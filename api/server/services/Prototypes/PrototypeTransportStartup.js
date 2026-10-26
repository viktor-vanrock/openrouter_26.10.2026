const Redis = require('ioredis');
const {
  assertPrototypeRedisDurability,
  createPrototypeTransportRuntime,
  createPrototypeCleanupReconciler,
} = require('./PrototypeTransportWiring');
const { PrototypeS3Client } = require('./PrototypeS3Client');
const { prototypeS3Config } = require('./PrototypeSharedConfig');
const { prototypeAvailability } = require('./PrototypeAvailability');

async function startPrototypeTransport({
  enabled,
  appConfig,
  env = process.env,
  db,
  mongoose,
  logger,
  registerShutdownTask,
  RedisCtor = Redis,
  loadContracts = () => import('@librechat/prototype-worker'),
  assertDurability = assertPrototypeRedisDurability,
  createRuntime = createPrototypeTransportRuntime,
  bindControlPlane,
  startPrivateListener,
  stopPrivateListener,
}) {
  if (!enabled) return null;
  if (appConfig.prototypeAgent?.enabled !== true) {
    throw new Error('Prototype transport cannot start while prototypeAgent is disabled');
  }
  const redisUrl = env.REDIS_URI;
  if (typeof redisUrl !== 'string' || redisUrl.length === 0) {
    throw new Error('REDIS_URI is required for the isolated transport');
  }
  const redisOptions = { enableReadyCheck: true, maxRetriesPerRequest: 1,
    connectTimeout: 1_000, commandTimeout: 10_000 };
  const redis = new RedisCtor(redisUrl, redisOptions);
  let unbindControlPlane;
  let lastRedisWarningAt = 0;
  const onRedisError = () => {
    const now = Date.now();
    if (now - lastRedisWarningAt < 5_000) return;
    lastRedisWarningAt = now;
    logger?.warn?.('[PrototypeTransport] Redis connection interrupted; retrying.');
  };
  redis.on?.('error', onRedisError);
  let eventRedis;
  let cleanupClient;
  let runtime;
  try {
    eventRedis = new RedisCtor(redisUrl, redisOptions);
    eventRedis.on?.('error', onRedisError);
    await Promise.all([redis.ping(), eventRedis.ping()]);
    await assertDurability(redis);
    const { parsePrototypeWorkerEventV2 } = await loadContracts();
    if (typeof parsePrototypeWorkerEventV2 !== 'function') {
      throw new Error('Prototype v2 event parser is unavailable');
    }
    const publishControlEvent = async (event) => {
      const parsed = parsePrototypeWorkerEventV2(event);
      await redis.xadd('prototype.events.v2', '*', 'event', JSON.stringify(parsed));
    };
    unbindControlPlane = bindControlPlane?.({ publishControlEvent });
    const replica = env.HOSTNAME || `api-${process.pid}`;
    let cleanup;
    if (env.AWS_BUCKET_NAME) {
      cleanupClient = new PrototypeS3Client(prototypeS3Config(env));
      cleanup = createPrototypeCleanupReconciler({
        db,
        storage: cleanupClient,
        bucket: env.AWS_BUCKET_NAME,
      });
    }
    runtime = createRuntime({
      redis,
      eventRedis,
      db,
      startSession: () => mongoose.startSession(),
      loadJob: (event, session) =>
        mongoose.models.PrototypeJob.findOne({ jobId: event.jobId }, null, { session }).lean(),
      parseEvent: parsePrototypeWorkerEventV2,
      consumerId: env.PROTOTYPE_EVENT_CONSUMER || `${replica}-events`,
      eventGroup: env.PROTOTYPE_EVENT_GROUP || 'prototype-control-plane',
      publisherId: env.PROTOTYPE_OUTBOX_PUBLISHER || `${replica}-outbox`,
      onError: (error) => logger.error('[PrototypeTransport] Background operation failed', error),
      cleanup,
      closeCleanup: () => cleanupClient?.destroy(),
    });
    await runtime.start();
    await startPrivateListener?.();
    prototypeAvailability.bindTransport(() => redis.status === 'ready' && eventRedis.status === 'ready' &&
      mongoose.connection?.readyState === 1 && runtime.isReady());
    registerShutdownTask('prototype transport', async () => {
      prototypeAvailability.unbindTransport();
      unbindControlPlane?.();
      await stopPrivateListener?.();
      await runtime.stop();
    });
    logger.info('Prototype isolated transport started.');
    return runtime;
  } catch (error) {
    try { await stopPrivateListener?.(); } catch { /* Preserve startup failure. */ }
    unbindControlPlane?.();
    redis.disconnect(false);
    if (eventRedis && eventRedis !== redis) eventRedis.disconnect(false);
    cleanupClient?.destroy();
    try { await runtime?.stop?.(); } catch { /* Preserve startup failure. */ }
    throw error;
  }
}

module.exports = { startPrototypeTransport };
