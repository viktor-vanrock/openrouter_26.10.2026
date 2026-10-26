/** Shared storage addressing/publication check. No dotenv overrides or implicit provider switching. */
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  S3ArtifactStore,
  artifactDigest,
  s3ConditionalCreateMode,
} from '@librechat/prototype-worker';
import { randomUUID } from 'node:crypto';
import { StageS3Client } from '../src/s3-client.js';
import { assertStorageCapabilities } from '../src/storage-capabilities.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
dotenv.config({ path: `${root}/.env`, quiet: true });
const { prototypeS3Config } = createRequire(import.meta.url)(
  '../../../api/server/services/Prototypes/PrototypeSharedConfig',
);
const config = prototypeS3Config();
const client = new StageS3Client({
  ...config,
  maxAttempts: 1,
  requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 5000 }),
});
const bucket = process.env.AWS_BUCKET_NAME;
const evidence = {
  at: new Date().toISOString(),
  forcePathStyle: config.forcePathStyle,
  conditionalMode: s3ConditionalCreateMode(config.endpoint),
  checks: {},
};
const suffix = randomUUID().replaceAll('-', '');
const owner = {
  tenantId: `probe_${suffix}`,
  jobId: `job_${suffix}`,
  executionId: `execution_${suffix}`,
  revision: 1,
};
const store = new S3ArtifactStore(client, bucket);
const body = Buffer.from('Verified own-prefix shared S3 publication');
const pin = artifactDigest(Buffer.from('fixture-pins'));
let reference;
try {
  await assertStorageCapabilities({ client, bucket });
  evidence.checks.capabilities = true;
  reference = await store.publish({
    owner,
    kind: 'html',
    bytes: body,
    digest: artifactDigest(body),
    contentType: 'text/plain',
    templateDigest: pin,
    toolchainDigest: pin,
  });
  evidence.checks.publish = true;
  evidence.checks.restoreDigest = (await store.readVerified(reference, owner)).equals(body);
  const duplicate = await store.publish({
    owner,
    kind: 'html',
    bytes: body,
    digest: artifactDigest(body),
    contentType: 'text/plain',
    templateDigest: pin,
    toolchainDigest: pin,
  });
  evidence.checks.idempotentReference = duplicate.objectKey === reference.objectKey;
  evidence.reference = { objectKey: reference.objectKey, digest: reference.digest };
} finally {
  if (reference) {
    await client.deleteObject({ bucket, key: reference.objectKey });
    evidence.checks.cleanup =
      (await client.headObject({ bucket, key: reference.objectKey })) === null;
  }
  client.destroy();
  await fs.writeFile(
    `${root}/.prototype-dev/implementation-audit/shared-s3-publication.json`,
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
}
console.log(JSON.stringify(evidence));
if (Object.values(evidence.checks).some((value) => value !== true)) process.exitCode = 1;
