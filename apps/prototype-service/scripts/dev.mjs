/** Thin Gateway development launcher. Uses prepared dependencies; owns only its process/profile. */
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import {
  createPrototypeStoreModels,
  createPrototypeMethods,
  decrypt,
} from '@librechat/data-schemas';
import { loadPrototypeConfig } from '../src/config.js';
import { createGatewayRuntime } from '../src/runtime-factory.js';
import { PrototypeControlPlaneClient } from '../src/control-plane-client.js';
import { StageS3Client } from '../src/s3-client.js';
import { startServiceHeartbeat } from '../src/service-heartbeat.js';
import { assertStorageCapabilities } from '../src/storage-capabilities.js';
import { localLogger } from '../src/local-log.js';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../../../', import.meta.url));
dotenv.config({ path: path.join(root, '.env'), quiet: true });
if (process.env.NODE_ENV === 'production')
  throw new Error('Use the production entrypoint for production');
if (process.env.PROTOTYPE_DEV_TEST === '1')
  throw new Error('Gateway dev launcher requires the selected real chat model');
const config = loadPrototypeConfig(process.env, 'orchestrator');
if (config.executionBackend !== 'sandbox-gateway')
  throw new Error('prototype:dev requires sandbox-gateway');
config.modelProviderUrl = process.env.OPENROUTER_API_URL?.replace(/\/$/, '');
if (!config.modelProviderUrl?.startsWith('https://'))
  throw new Error('OPENROUTER_API_URL must use HTTPS');
if (!process.env.PROTOTYPE_MONGO_URI || process.env.PROTOTYPE_MONGO_URI === process.env.MONGO_URI) {
  throw new Error('An explicit separate PROTOTYPE_MONGO_URI replica-set scope is required');
}
const require = createRequire(import.meta.url);
const { prototypeS3Config } = require('../src/shared-storage-config.cjs');
const directory = path.join(root, '.prototype-dev/gateway-runtime');
const profileFile = path.join(root, '.prototype-dev/runtime.json');
const lockFile = path.join(root, '.prototype-dev/service.lock');
const abort = new AbortController();
const checkOnly = process.argv.includes('--check');
const scope = new mongoose.Mongoose();
const primary = mongoose.createConnection();
let lock, runtime, stages, redis, sourceRedis, storage, stopHeartbeat;
let ownsProfile = false;
let startupDependency = 'prototype Mongo';
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    abort.abort();
    stages?.stop();
  });
try {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(profileFile), 0o700);
  try {
    lock = await fs.open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await fs.readFile(lockFile, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* stale lock */
    }
    if (alive) throw new Error('Prototype development service is already running');
    await fs.unlink(lockFile);
    lock = await fs.open(lockFile, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid));
  await scope.connect(process.env.PROTOTYPE_MONGO_URI, {
    serverSelectionTimeoutMS: 2_000,
    maxPoolSize: 10,
  });
  const hello = await scope.connection.db.admin().command({ hello: 1 });
  if (!hello.setName || hello.isWritablePrimary !== true)
    throw new Error('Prototype store requires a writable replica set');
  const models = createPrototypeStoreModels(scope);
  await Promise.all(Object.values(models).map((model) => model.init()));
  startupDependency = 'primary Mongo';
  await primary.openUri(process.env.MONGO_URI, { serverSelectionTimeoutMS: 2_000, maxPoolSize: 2 });
  // The service reads the owner's existing encrypted credential; users/history/keys are never cloned.
  const methods = {
    ...createPrototypeMethods(scope),
    getUserKeyValues: async ({ userId, tenantId, name }) => {
      const key = await primary.db.collection('keys').findOne({
        userId: new mongoose.Types.ObjectId(userId),
        name,
        ...(tenantId === '__default__'
          ? { $or: [{ tenantId }, { tenantId: { $exists: false } }, { tenantId: null }] }
          : { tenantId }),
      });
      if (!key || (key.expiresAt && new Date(key.expiresAt) <= new Date()))
        throw new Error('Owner model credential unavailable');
      return JSON.parse(await decrypt(key.value));
    },
  };
  startupDependency = 'shared Redis';
  redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 2_000 });
  sourceRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 2_000 });
  redis.on('error', () => undefined);
  sourceRedis.on('error', () => undefined);
  await redis.ping();
  startupDependency = 'shared OBS';
  storage = new StageS3Client({ ...prototypeS3Config(), maxAttempts: 1 });
  // Fail closed before publishing a readiness profile when the storage contract isn't supported.
  await assertStorageCapabilities({ client: storage, bucket: config.storageBucket });
  const identity = randomBytes(32).toString('hex');
  const client = new PrototypeControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    environment: 'development',
    headers: async () => ({ 'X-Prototype-Worker': identity }),
  });
  const log = localLogger(directory);
  startupDependency = 'Gateway runtime';
  const built = await createGatewayRuntime({
    config,
    mongoose: scope,
    models,
    methods,
    storage,
    redis,
    sourceRedis,
    directory,
    log,
    client,
  });
  ({ runtime, stages } = built);
  await runtime.prepare();
  if (checkOnly) {
    console.info(
      'Prototype prerequisites PASS: chat Mongo, prototype replica set, shared Redis/OBS and Gateway. Worker not started; no model requests.',
    );
  } else {
    await fs.writeFile(
      profileFile,
      JSON.stringify({
        schemaVersion: 2,
        pid: process.pid,
        env: {
          PROTOTYPE_MONGO_URI: process.env.PROTOTYPE_MONGO_URI,
          REDIS_URI: process.env.REDIS_URI,
          PROTOTYPE_TEST_WORKER_IDENTITY: identity,
        },
      }),
      { mode: 0o600 },
    );
    ownsProfile = true;
    stopHeartbeat = startServiceHeartbeat({
      client,
      isReady: async () =>
        !abort.signal.aborted &&
        redis.status === 'ready' &&
        (await runtime.isReady()) &&
        !!(await built.backend.gateway.probe()),
    });
    console.info('Prototype Gateway service ready; API and frontend remain separate processes.');
    await runtime.start({ signal: abort.signal });
  }
} catch (error) {
  if (!abort.signal.aborted) {
    const code = error?.code || error?.name;
    const safe = /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : code;
    console.error(`Prototype service unavailable: ${safe || 'STARTUP_FAILED'}`);
    process.exitCode = 1;
    console.error(`Failed dependency: ${startupDependency}.`);
    if (startupDependency === 'prototype Mongo') {
      console.error('Prepare local replica set: docker volume create prototype_mongo_data');
      console.error(
        'docker compose -f docker-compose.deps-only.yml --profile prototype up -d --no-deps --wait prototype-mongo',
      );
      console.error('Check PROTOTYPE_MONGO_URI in root .env; primary MONGO_URI remains unchanged.');
    } else if (startupDependency === 'shared Redis') {
      console.error(
        'Check shared REDIS_URI in root .env; local Docker Redis is on 127.0.0.1:6379.',
      );
    }
  }
} finally {
  stopHeartbeat?.();
  stages?.stop();
  await runtime?.stop();
  redis?.disconnect(false);
  sourceRedis?.disconnect(false);
  storage?.destroy();
  await scope.disconnect();
  await primary.close();
  if (ownsProfile) await fs.rm(profileFile, { force: true });
  if (lock) {
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}
