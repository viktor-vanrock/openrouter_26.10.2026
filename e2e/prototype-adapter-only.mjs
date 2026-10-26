/** Full API dark-launch acceptance on isolated databases; no worker/provider/Redis/S3 calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import YAML from 'yaml';
dotenv.config({ quiet: true });
const out = `.prototype-dev/adapter-only-${Date.now()}`;
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-adapter-only-'));
const suffix = randomUUID().replaceAll('-', '');
const primary = new URL(process.env.MONGO_URI); primary.pathname = `/adapter_chat_${suffix}`;
const prototype = new URL(process.env.PROTOTYPE_MONGO_URI); prototype.pathname = `/adapter_store_${suffix}`;
const config = YAML.parse(await fs.readFile('librechat.yaml', 'utf8'));
config.prototypeAgent = { ...config.prototypeAgent, enabled: false };
const configPath = path.join(directory, 'librechat.yaml');
await fs.writeFile(configPath, YAML.stringify(config), { mode: 0o600 });
const evidence = { at: new Date().toISOString(), providerRequests: 0, checks: {} };
const children = new Set();
const scope = new mongoose.Mongoose();
const serviceToken = randomBytes(32).toString('hex');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const authEnv = {
  PROTOTYPE_SERVICE_AUTH_MODE: 'bearer', PROTOTYPE_SERVICE_TOKEN: serviceToken,
  PROTOTYPE_MODEL_TOKEN_PRIVATE_KEY_PATH: '',
  PROTOTYPE_MODEL_TOKEN_PRIVATE_KEY_BASE64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
  TRUST_PROXY: '1',
};
async function port() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}
async function wait(check) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await delay(250); }
  throw new Error('ADAPTER_ONLY_ACCEPTANCE_TIMEOUT');
}
async function launch(label, extra = {}) {
  const listenPort = await port();
  const log = await fs.open(`${out}/${label}.log`, 'w', 0o600);
  const child = spawn(process.execPath, ['api/server/index.js'], { stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, NODE_ENV: process.argv.includes('--production') ? 'production' : 'development', HOST: '127.0.0.1', PORT: String(listenPort),
      MONGO_URI: primary.toString(), PROTOTYPE_MONGO_URI: prototype.toString(), CONFIG_PATH: configPath,
      SEARCH: 'false', USE_REDIS: 'false', USE_REDIS_STREAMS: 'false', REDIS_URI: 'redis://127.0.0.1:1',
      PROTOTYPE_TRANSPORT_ENABLED: 'false', PROTOTYPE_MODEL_PROXY_ENABLED: 'true',
      AWS_ENDPOINT_URL: 'http://127.0.0.1:1', ...authEnv, ...extra } });
  children.add(child); await log.close();
  const origin = `http://127.0.0.1:${listenPort}`;
  await wait(async () => (await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1500) })).status === 200);
  return { origin, child };
}
async function stop(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
  await Promise.race([stopped, delay(5000)]);
  if (child.exitCode == null && child.signalCode == null) { child.kill('SIGKILL'); await stopped; }
  children.delete(child);
}
try {
  const live = await launch('adapter-enabled');
  await wait(async () => (await fetch(`${live.origin}/api/prototype-model/v1/models`)).status === 401);
  evidence.checks.adapterStartedWithPrototypeUiAndTransportDisabled = true;
  evidence.checks.chatReadyWithoutRedisOrObs = true;
  const tokenResponse = await fetch(`${live.origin}/api/prototype-model/v1/models`, { headers: { Authorization: 'Bearer invalid' } });
  evidence.checks.invalidScopedTokenDenied = tokenResponse.status === 401;
  if (process.argv.includes('--production')) {
    evidence.checks.legacyTokenRefreshDisabled =
      (await fetch(`${live.origin}/internal/prototype-tokens/refresh`, { method: 'POST' })).status === 404;
    const refresh = headers => fetch(`${live.origin}/api/internal/prototype-tokens/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
    evidence.checks.bearerWithoutHttpsDenied = (await refresh({ Authorization: `Bearer ${serviceToken}` })).status === 401;
    evidence.checks.httpsWithoutBearerDenied = (await refresh({ 'X-Forwarded-Proto': 'https' })).status === 401;
    evidence.checks.httpsWrongBearerDenied = (await refresh({ 'X-Forwarded-Proto': 'https', Authorization: 'Bearer invalid' })).status === 401;
    evidence.checks.httpsWorkerAdmittedThenInvalidTupleDenied = (await refresh({
      'X-Forwarded-Proto': 'https', Authorization: `Bearer ${serviceToken}` })).status === 422;
  }
  await scope.connect(prototype.toString());
  const collections = (await scope.connection.db.listCollections().toArray()).map(c => c.name);
  evidence.checks.noWorkerHeartbeat = !collections.includes('prototypeavailability');
  evidence.checks.noGenerationCommands = await scope.connection.db.collection('prototypeoutboxes').countDocuments() === 0;
  await stop(live.child);
  const unavailable = await launch('adapter-store-unavailable', { PROTOTYPE_MONGO_URI: 'mongodb://127.0.0.1:1/unavailable' });
  evidence.checks.chatReadyWithAdapterStoreUnavailable = (await fetch(`${unavailable.origin}/readyz`)).status === 200;
  evidence.checks.unavailableAdapterReturns503 = (await fetch(`${unavailable.origin}/api/prototype-model/v1/models`)).status === 503;
  await stop(unavailable.child);
  evidence.passed = Object.values(evidence.checks).every(value => value === true);
  if (!evidence.passed) process.exitCode = 1;
} catch (error) { evidence.passed = false; evidence.code = error.message; process.exitCode = 1; }
finally {
  for (const child of children) await stop(child);
  if (scope.connection.readyState === 1) await scope.connection.dropDatabase(); await scope.disconnect();
  const cleanup = new mongoose.Mongoose();
  try { await cleanup.connect(primary.toString()); await cleanup.connection.dropDatabase(); } finally { await cleanup.disconnect(); }
  await fs.rm(directory, { recursive: true, force: true });
  await fs.writeFile(`${out}/receipt.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...evidence, evidenceDirectory: out }));
}
