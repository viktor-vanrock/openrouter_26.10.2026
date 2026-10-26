import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import http from 'node:http';
import https from 'node:https';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
  createPrototypeStoreModels,
  createPrototypeMethods,
  decrypt,
} from '@librechat/data-schemas';
import sharedStorage from './shared-storage-config.cjs';
import { StageS3Client } from './s3-client.js';
import { createGatewayRuntime, createGatewayControlPlaneClient } from './runtime-factory.js';
import { startServiceHeartbeat } from './service-heartbeat.js';
import { assertStorageCapabilities } from './storage-capabilities.js';
import { serviceLogger } from './local-log.js';
import { errorLogFields } from './service-log.js';

async function openStore(uri) {
  const scope = new mongoose.Mongoose();
  try {
    await scope.connect(uri, {
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
      maxPoolSize: 10,
    });
    const hello = await scope.connection.db.admin().command({ hello: 1 });
    if (!hello.setName || !hello.isWritablePrimary)
      throw new Error('PROTOTYPE_REPLICA_PRIMARY_REQUIRED');
    const models = createPrototypeStoreModels(scope);
    return {
      scope,
      models,
      methods: createPrototypeMethods(scope),
      close: () => scope.disconnect(),
    };
  } catch (error) {
    await scope.disconnect();
    throw error;
  }
}
async function openPrimary(uri) {
  const connection = mongoose.createConnection();
  try {
    await connection.openUri(uri, {
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
      maxPoolSize: 2,
    });
    return connection;
  } catch (error) {
    await connection.close();
    throw error;
  }
}
export function ownedCredentialReader(primary, decryptValue = decrypt) {
  return async ({ userId, tenantId, name }) => {
    if (
      name !== 'OpenRouter' ||
      !/^[a-f0-9]{24}$/.test(userId ?? '') ||
      typeof tenantId !== 'string' ||
      !tenantId
    ) {
      throw new Error('PROTOTYPE_OWNER_CREDENTIAL_INVALID');
    }
    const record = await primary.db.collection('keys').findOne(
      {
        userId: new mongoose.Types.ObjectId(userId),
        name,
        ...(tenantId === '__default__'
          ? { $or: [{ tenantId }, { tenantId: { $exists: false } }, { tenantId: null }] }
          : { tenantId }),
      },
      { projection: { value: 1, expiresAt: 1 }, maxTimeMS: 1000 },
    );
    if (!record || (record.expiresAt && new Date(record.expiresAt) <= new Date()))
      throw new Error('PROTOTYPE_OWNER_CREDENTIAL_UNAVAILABLE');
    try {
      return JSON.parse(await decryptValue(record.value));
    } catch {
      throw new Error('PROTOTYPE_OWNER_CREDENTIAL_INVALID');
    }
  };
}

/** Shared Gateway runtime in production. Standby never reads/ACKs Redis commands or sends heartbeat. */
export function createGatewayOrchestratorLifecycle({
  env = process.env,
  openPrototype = openStore,
  openChat = openPrimary,
  redisFactory = (uri) =>
    new Redis(uri, { enableReadyCheck: true, maxRetriesPerRequest: 1, connectTimeout: 2000 }),
  storageFactory = (settings) =>
    new StageS3Client({
      ...settings,
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 3000,
        socketTimeout: 5000,
        // The packaged Node24/MinIO HEAD regression requires separate bounded connections.
        httpAgent: new http.Agent({ keepAlive: false }),
        httpsAgent: new https.Agent({ keepAlive: false }),
      }),
    }),
  runtimeFactory = createGatewayRuntime,
  makeClient = createGatewayControlPlaneClient,
  checkStorage = assertStorageCapabilities,
  heartbeat = startServiceHeartbeat,
  log: injectedLog,
} = {}) {
  let store, primary, redis, sourceRedis, storage, built, loop, stopHeartbeat, monitor;
  let ready = false,
    stopped = false,
    checking = false,
    dependencyHealthy = false,
    workerConfig;
  let startupDependency = 'workspace';
  let log = injectedLog ?? serviceLogger(null, { environment: env.NODE_ENV });
  const safeError = (error) =>
    log('service.error', errorLogFields(error, 'PROTOTYPE_DEPENDENCY_UNAVAILABLE'));
  const availability = new Map();
  function dependencyState(dependency, available, error) {
    if (availability.get(dependency) === available) return;
    availability.set(dependency, available);
    log(available ? 'dependency.available' : 'dependency.unavailable', {
      dependency,
      available,
      ...(error ? errorLogFields(error, 'PROTOTYPE_DEPENDENCY_UNAVAILABLE') : {}),
    });
  }
  async function checkDependencies() {
    if (checking || stopped) return;
    checking = true;
    try {
      const dependencies = [
        [
          'prototype_store',
          store.scope.connection.readyState === 1,
          () => store.scope.connection.db.command({ ping: 1 }, { maxTimeMS: 1000 }),
        ],
        ['primary_store', primary.readyState === 1, async () => {}],
        ['redis', redis.status === 'ready', () => redis.ping()],
        ['command_redis', sourceRedis.status === 'ready', async () => {}],
        ['gateway', true, () => built.backend.gateway.probe()],
      ];
      const results = await Promise.all(
        dependencies.map(async ([name, connected, probe]) => {
          try {
            if (!connected) throw new Error('PROTOTYPE_CONNECTION_NOT_READY');
            await probe();
            dependencyState(name, true);
            return true;
          } catch (error) {
            dependencyState(name, false, error);
            return false;
          }
        }),
      );
      dependencyHealthy = !stopped && results.every(Boolean);
    } catch {
      dependencyHealthy = false;
    } finally {
      checking = false;
    }
  }
  const lifecycle = {
    async start({ config, signal }) {
      workerConfig = config;
      log = injectedLog ?? serviceLogger(config.workspaceDirectory, { environment: env.NODE_ENV });
      log('service.starting', { intake: config.workerIntakeEnabled, engine: 'direct-react-v1' });
      if (
        config.executionBackend !== 'sandbox-gateway' ||
        !env.PROTOTYPE_MONGO_URI ||
        !env.MONGO_URI ||
        env.PROTOTYPE_MONGO_URI === env.MONGO_URI
      )
        throw new Error('PROTOTYPE_SEPARATE_STORE_REQUIRED');
      if (
        config.workerIntakeEnabled &&
        (!/^[a-f0-9]{64}$/i.test(env.CREDS_KEY ?? '') ||
          !/^[a-f0-9]{32}$/i.test(env.CREDS_IV ?? ''))
      ) {
        throw new Error('PROTOTYPE_OWNER_CREDENTIAL_CONFIG_REQUIRED');
      }
      if (
        config.environment === 'production' &&
        config.workerIntakeEnabled &&
        !(
          Number(env.PROTOTYPE_LOCAL_TURN_LIMIT_USD ?? 2) > 0 &&
          Number(env.PROTOTYPE_LOCAL_TURN_LIMIT_USD ?? 2) <= 2
        )
      ) {
        throw new Error('PROTOTYPE_TURN_BUDGET_INVALID');
      }
      try {
        await fs.mkdir(config.workspaceDirectory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(config.workspaceDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
          throw new Error('PROTOTYPE_WORKSPACE_INVALID');
        await fs.chmod(config.workspaceDirectory, 0o700);
        startupDependency = 'prototype_store';
        store = await openPrototype(env.PROTOTYPE_MONGO_URI);
        startupDependency = 'primary_store';
        primary = await openChat(env.MONGO_URI);
        const a = store.scope.connection,
          b = primary;
        if (a.host === b.host && a.port === b.port && a.db.databaseName === b.db.databaseName)
          throw new Error('PROTOTYPE_SEPARATE_STORE_REQUIRED');
        startupDependency = 'redis';
        redis = redisFactory(config.redisUrl);
        sourceRedis = redisFactory(config.redisUrl);
        redis.on('error', safeError);
        sourceRedis.on('error', safeError);
        await Promise.all([redis.ping(), sourceRedis.ping()]);
        startupDependency = 'storage_config';
        storage = storageFactory(sharedStorage.prototypeS3Config(env));
        const client = await makeClient(config, { log });
        const methods = { ...store.methods, getUserKeyValues: ownedCredentialReader(primary) };
        startupDependency = 'gateway_runtime';
        built = await runtimeFactory({
          config,
          mongoose: store.scope,
          models: store.models,
          methods,
          storage,
          redis,
          sourceRedis,
          directory: config.workspaceDirectory,
          log,
          client,
        });
        await checkDependencies();
        if (!dependencyHealthy) throw new Error('PROTOTYPE_DEPENDENCY_UNAVAILABLE');
        if (signal.aborted || stopped) throw new Error('PROTOTYPE_START_ABORTED');
        if (config.workerIntakeEnabled) {
          startupDependency = 'redis_durability';
          const policies = await Promise.all(
            ['maxmemory-policy', 'appendonly', 'save'].map((name) => redis.config('GET', name)),
          );
          if (
            policies[0]?.[1] !== 'noeviction' ||
            (policies[1]?.[1] !== 'yes' && !policies[2]?.[1]?.trim())
          )
            throw new Error('PROTOTYPE_REDIS_DURABILITY_REQUIRED');
          // Explicit enable authorizes only a unique own-prefix storage capability probe.
          startupDependency = 'storage_capabilities';
          const checkedStorage = Object.fromEntries(
            ['putObject', 'headObject', 'getObject', 'deleteObject'].map((method) => [
              method,
              async (input) => {
                startupDependency = `storage_${method}`;
                return storage[method](input);
              },
            ]),
          );
          await checkStorage({ client: checkedStorage, bucket: config.storageBucket });
          startupDependency = 'command_group';
          await built.runtime.prepare();
          ready = true;
          stopHeartbeat = heartbeat({ client, isReady: () => lifecycle.isReady(), log });
          loop = built.runtime.start({ signal }).then(
            () => {
              ready = false;
            },
            (error) => {
              ready = false;
              safeError(error);
            },
          );
        }
        monitor = setInterval(() => {
          void checkDependencies();
        }, 5000);
        monitor.unref();
        log('service.start', { intake: config.workerIntakeEnabled, engine: 'direct-react-v1' });
      } catch (error) {
        log('service.error', {
          dependency: startupDependency,
          code: /^PROTOTYPE_[A-Z_]+$/.test(error.message ?? '')
            ? error.message
            : 'PROTOTYPE_DEPENDENCY_UNAVAILABLE',
          errorType: /^[a-zA-Z0-9_]{1,64}$/.test(error.name ?? '') ? error.name : 'Unknown',
          httpStatus: Number.isInteger(error.$metadata?.httpStatusCode)
            ? error.$metadata.httpStatusCode
            : undefined,
        });
        await lifecycle.stop();
        throw new Error('PROTOTYPE_GATEWAY_STARTUP_FAILED');
      }
    },
    async isReady() {
      const available =
        !stopped &&
        ready &&
        dependencyHealthy &&
        redis?.status === 'ready' &&
        sourceRedis?.status === 'ready' &&
        store?.scope.connection.readyState === 1 &&
        primary?.readyState === 1 &&
        (await built?.runtime.isReady()) === true;
      dependencyState('worker_readiness', available);
      return available;
    },
    async handleRequest(req, res) {
      if (req.method !== 'GET' || req.url !== '/status') return false;
      const body = JSON.stringify({
        mode: workerConfig?.workerIntakeEnabled ? 'active' : 'standby',
        dependencies: dependencyHealthy ? 'available' : 'unavailable',
        storage: workerConfig?.workerIntakeEnabled ? 'verified_on_start' : 'not_probed',
        engine: 'direct-react-v1',
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      ready = false;
      dependencyHealthy = false;
      clearInterval(monitor);
      stopHeartbeat?.();
      log('service.stopping');
      built?.stages.stop();
      await built?.runtime.stop().catch(safeError);
      redis?.disconnect(false);
      sourceRedis?.disconnect(false);
      await loop;
      storage?.destroy();
      await primary?.close().catch(safeError);
      await store?.close().catch(safeError);
      log('service.stopped');
    },
  };
  return lifecycle;
}
