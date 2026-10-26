import { isConditionalCreateConflict, s3ConditionalCreateMode } from '@librechat/prototype-worker';
/** Own-prefix object capability test. Never lists/deletes other files or prints credentials. */
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { loadPrototypeConfig } from '../src/config.js';
import { SandboxGatewayClient } from '../src/sandbox-gateway-client.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
dotenv.config({ path: `${root}/.env`, quiet: true });
const require = createRequire(import.meta.url);
const {
  prototypeS3Config,
} = require('../../../api/server/services/Prototypes/PrototypeSharedConfig');
const { PrototypeS3Client } = require('../../../api/server/services/Prototypes/PrototypeS3Client');
const out = `${root}/.prototype-dev/implementation-audit`;
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const config = loadPrototypeConfig(process.env, 'orchestrator');
const gateway = await SandboxGatewayClient.fromConfig(config.gateway);
const evidence = { at: new Date().toISOString(), gateway: await gateway.probe(), storage: {} };
if (!process.argv.includes('--objects'))
  throw new Error('Explicit --objects required for own-prefix writes');
const virtual = process.argv.includes('--virtual-host');
const s3config = prototypeS3Config();
const client = new PrototypeS3Client({
  ...s3config,
  ...(virtual ? { forcePathStyle: false } : {}),
  maxAttempts: 1,
  requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, requestTimeout: 5_000 }),
});
const bucket = process.env.AWS_BUCKET_NAME;
const key = `prototypes/acceptance/${randomUUID()}/object-probe.txt`;
const body = Buffer.from('ChatRouter own-prefix storage capability check');
const safeError = (e) => ({ name: e.name, status: e.$metadata?.httpStatusCode ?? null });
evidence.storage = {
  key,
  conditionalMode: s3ConditionalCreateMode(s3config.endpoint),
  forcePathStyle: virtual ? false : s3config.forcePathStyle,
  checks: {},
};
let created = false;
try {
  await client.putObject({ bucket, key, body, ifNoneMatch: '*' });
  created = true;
  evidence.storage.checks.put = true;
  evidence.storage.checks.head = (await client.headObject({ bucket, key }))?.size === body.length;
  evidence.storage.checks.get = (await client.getObject({ bucket, key })).equals(body);
  try {
    await client.putObject({
      bucket,
      key,
      body: Buffer.from('conditional overwrite must be rejected'),
      ifNoneMatch: '*',
    });
    evidence.storage.checks.conditional = false;
    evidence.storage.conditionalOutcome = 'overwrite_accepted';
  } catch (error) {
    evidence.storage.checks.conditional = isConditionalCreateConflict(error);
    evidence.storage.conditionalError = safeError(error);
  }
  evidence.storage.checks.unchanged = (await client.getObject({ bucket, key })).equals(body);
} catch (error) {
  evidence.storage.error = safeError(error);
} finally {
  if (created) {
    try {
      await client.deleteObject({ bucket, key });
      evidence.storage.checks.delete = true;
      evidence.storage.checks.absent = (await client.headObject({ bucket, key })) === null;
    } catch (error) {
      evidence.storage.cleanupError = safeError(error);
    }
  }
  client.destroy();
}
await fs.writeFile(
  `${out}/preflight-${virtual ? 'virtual-host' : 'configured'}.json`,
  JSON.stringify(evidence, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(evidence));
if (
  !Object.values(evidence.storage.checks).every((v) => v === true) ||
  !evidence.storage.checks.conditional
)
  process.exitCode = 1;
