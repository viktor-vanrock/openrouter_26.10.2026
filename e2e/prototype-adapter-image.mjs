/** Production image smoke with isolated DBs, disposable identity, UID1000 and no worker/provider calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import dotenv from 'dotenv';
import YAML from 'yaml';
import mongoose from 'mongoose';
dotenv.config({ quiet: true });
const image = process.env.PROTOTYPE_ACCEPTANCE_IMAGE ?? 'chatrouter-adapter-api-check:local';
const id = randomUUID().replaceAll('-', ''), container = `adapter-image-${id.slice(0, 12)}`;
const out = path.resolve(`.prototype-dev/adapter-image-${Date.now()}`);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const serviceToken = randomBytes(32).toString('hex');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const primary = new URL(process.env.MONGO_URI); primary.pathname = `/adapter_image_chat_${id}`;
const prototype = new URL(process.env.PROTOTYPE_MONGO_URI); prototype.pathname = `/adapter_image_store_${id}`;
const dockerUri = url => { const copy = new URL(url); copy.hostname = 'host.docker.internal'; return copy.toString(); };
const evidence = { at: new Date().toISOString(), image, checks: {}, paidProviderRequests: 0 };
let started = false;
const unusedPort = async () => {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
};
try {
  const prod = YAML.parse(await fs.readFile('envs/prod.yaml', 'utf8'));
  const config = YAML.parse(prod.librechat.configYamlContent);
  await fs.writeFile(path.join(out, 'librechat.yaml'), YAML.stringify(config), { mode: 0o644 });
  const env = { NODE_ENV: 'production', HOST: '0.0.0.0', PORT: '3080', MONGO_URI: dockerUri(primary), PROTOTYPE_MONGO_URI: dockerUri(prototype),
    CONFIG_PATH: '/app/librechat.yaml', CREDS_KEY: randomBytes(32).toString('hex'), CREDS_IV: randomBytes(16).toString('hex'),
    JWT_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    PROTOTYPE_TRANSPORT_ENABLED: 'false', PROTOTYPE_MODEL_PROXY_ENABLED: 'true',
    PROTOTYPE_SERVICE_AUTH_MODE: 'bearer', PROTOTYPE_SERVICE_TOKEN: serviceToken,
    PROTOTYPE_MODEL_TOKEN_PRIVATE_KEY_BASE64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
    TRUST_PROXY: '1',
    OPENROUTER_API_URL: 'https://or.crbrcloud.ru/api/v1', SEARCH: 'false', USE_REDIS: 'false', USE_REDIS_STREAMS: 'false',
    REDIS_URI: 'redis://127.0.0.1:1', AWS_ENDPOINT_URL: 'http://127.0.0.1:1' };
  const envFile = path.join(out, 'runtime.env');
  await fs.writeFile(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  const port = await unusedPort();
  docker(['run', '-d', '--name', container, '--user', '1000:2000', '--env-file', envFile,
    '-p', `127.0.0.1:${port}:3080`,
    '--mount', `type=bind,source=${path.join(out, 'librechat.yaml')},target=/app/librechat.yaml,readonly`,
    '--entrypoint', 'node', image, 'server/index.js']); started = true;
  evidence.imageId = docker(['inspect', container, '--format', '{{.Image}}']).trim();
  const origin = `http://127.0.0.1:${port}`, deadline = Date.now() + 90000;
  let ready = false;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1500) })).status === 200) { ready = true; break; } } catch {}
    await delay(500);
  }
  if (!ready) throw new Error('IMAGE_API_READINESS_FAILED');
  evidence.checks.productionNonRootReady = true;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/prototype-model/v1/models`);
    if (response.status === 401) { evidence.checks.adapterStarted = true; break; }
    await delay(500);
  }
  evidence.checks.publicTokenRefresh404 = (await fetch(`${origin}/internal/prototype-tokens/refresh`, { method: 'POST' })).status === 404;
  const refresh = headers => fetch(`${origin}/api/internal/prototype-tokens/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  evidence.checks.bearerWithoutHttpsDenied = (await refresh({ Authorization: `Bearer ${serviceToken}` })).status === 401;
  evidence.checks.httpsWithoutBearerDenied = (await refresh({ 'X-Forwarded-Proto': 'https' })).status === 401;
  evidence.checks.httpsWrongBearerDenied = (await refresh({ 'X-Forwarded-Proto': 'https', Authorization: 'Bearer invalid' })).status === 401;
  evidence.checks.httpsWorkerAdmittedThenInvalidTupleDenied = (await refresh({
    'X-Forwarded-Proto': 'https', Authorization: `Bearer ${serviceToken}` })).status === 422;
  evidence.checks.noPrivateTlsPort = !docker(['port', container]).includes('3443');
  const scope = new mongoose.Mongoose();
  try {
    await scope.connect(prototype.toString());
    evidence.checks.noGenerationCommands = await scope.connection.db.collection('prototypeoutboxes').countDocuments() === 0;
    evidence.checks.noPrototypeHeartbeat = !(await scope.connection.db.listCollections({ name: 'prototypeavailability' }).toArray()).length;
  } finally { await scope.disconnect(); }
  evidence.passed = Object.values(evidence.checks).every(value => value === true) && evidence.checks.adapterStarted === true;
  if (!evidence.passed) process.exitCode = 1;
} catch (error) { evidence.passed = false; evidence.code = /^IMAGE_[A-Z_]+$/.test(error.message) ? error.message : 'IMAGE_SMOKE_FAILED'; process.exitCode = 1; }
finally {
  if (started) {
    const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
    await fs.writeFile(path.join(out, 'container.log'), String(logs.stdout ?? '') + String(logs.stderr ?? ''), { mode: 0o600 });
    docker(['rm', '-f', container]);
  }
  for (const uri of [primary, prototype]) {
    const scope = new mongoose.Mongoose();
    try { await scope.connect(uri.toString()); await scope.connection.dropDatabase(); } finally { await scope.disconnect(); }
  }
  await fs.rm(path.join(out, 'runtime.env'), { force: true });
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...evidence, evidenceDirectory: out }));
}
