const { PrototypeOutboxPublisher } = require('./PrototypeOutboxPublisher');
const { PrototypeRedisEventSourceV2 } = require('./PrototypeEventStream');
const { PrototypeEventConsumer } = require('./PrototypeEventConsumer');
const { PrototypeEventApplier } = require('./PrototypeEventApplier');
const { PrototypeTransportRuntime } = require('./PrototypeTransportRuntime');

const COMMAND_STREAM_V2 = 'prototype.commands.v2';

class PrototypeRedisCommandPublisherV2 {
  constructor(redis) { this.redis = redis; }
  async publish(command) {
    if (command?.schemaVersion !== 2) {
      throw new Error('Prototype isolated transport accepts only v2 commands');
    }
    await this.redis.xadd(COMMAND_STREAM_V2, '*', 'command', JSON.stringify(command));
  }
}

function createPrototypeOutboxPublisher({
  db,
  redis,
  publisherId,
  leaseMs = 30_000,
  now = () => new Date(),
  onError,
}) {
  const transport = new PrototypeRedisCommandPublisherV2(redis);
  return new PrototypeOutboxPublisher({
    claimPending: () => db.claimPrototypeOutbox({ publisherId, now: now(), leaseMs }),
    publish: (command) => transport.publish(command),
    markPublished: (commandId) => db.markPrototypeOutboxPublished(commandId, publisherId, now()),
    releaseClaim: (commandId) => db.releasePrototypeOutboxClaim(commandId, publisherId),
    onError,
  });
}

function configValue(response, key) {
  if (Array.isArray(response)) {
    const index = response.findIndex((value) => String(value).toLowerCase() === key.toLowerCase());
    return index >= 0 ? String(response[index + 1] ?? '') : '';
  }
  return String(response?.[key] ?? response?.[key.toLowerCase()] ?? '');
}

async function assertPrototypeRedisDurability(redis) {
  const [policyRaw, appendOnlyRaw, saveRaw] = await Promise.all([
    redis.config('GET', 'maxmemory-policy'),
    redis.config('GET', 'appendonly'),
    redis.config('GET', 'save'),
  ]);
  const policy = configValue(policyRaw, 'maxmemory-policy').toLowerCase();
  const appendOnly = configValue(appendOnlyRaw, 'appendonly').toLowerCase();
  const save = configValue(saveRaw, 'save').trim();
  if (policy !== 'noeviction') {
    throw new Error('Prototype Redis must use maxmemory-policy=noeviction');
  }
  if (appendOnly !== 'yes' && save.length === 0) {
    throw new Error('Prototype Redis persistence is disabled');
  }
}

function createPrototypeTransportRuntime({
  redis,
  eventRedis = redis,
  db,
  startSession,
  loadJob,
  parseEvent,
  consumerId,
  eventGroup,
  eventBlockMs = 5_000,
  publisherId,
  onError,
  cleanup,
  closeCleanup,
}) {
  if (
    !redis || !db || typeof startSession !== 'function' || typeof loadJob !== 'function' ||
    typeof parseEvent !== 'function' || !consumerId || !publisherId
  ) throw new Error('Prototype transport runtime dependencies are incomplete');
  const applier = new PrototypeEventApplier({
    updateExecution: (input) => db.updatePrototypeExecution(input),
    finishExecution: (input) => db.finishPrototypeExecution(input),
    verifyPublication: ({ event, session }) => db.verifyPrototypePublication?.({ event, session }),
    acceptPublication: (input) => db.acceptPrototypePublication(input),
    advanceStage: (input) => db.advancePrototypeStage(input),
    repairStage: (input) => db.retryPrototypeBuildStage(input),
  });
  const eventConsumer = new PrototypeEventConsumer({
    startSession,
    claimEvent: (input, session) => db.claimPrototypeWorkerEvent(input, session),
    loadJob,
    applyEvent: (event, session) => applier.apply(event, session),
    pauseJob: (input, session) => applier.pause(input, session),
    projectEvent: (input, session) => db.projectPrototypeWorkerEvent(input, session),
  });
  const eventSource = new PrototypeRedisEventSourceV2({
    redis: eventRedis,
    consumer: consumerId,
    ...(eventGroup ? { group: eventGroup } : {}),
    blockMs: eventBlockMs,
    parseEvent,
  });
  return new PrototypeTransportRuntime({
    outboxPublisher: createPrototypeOutboxPublisher({
      db, redis, publisherId, onError,
    }),
    eventSource,
    eventConsumer,
    reconcile: async () => {
      await db.reconcilePrototypeOutboxClaims(new Date());
      await db.reconcilePrototypePrimaryRevocations?.();
      await db.flushPrototypeChatProjection?.();
      await cleanup?.();
    },
    close: async () => {
      eventRedis.disconnect(false);
      if (eventRedis !== redis) redis.disconnect(false);
      closeCleanup?.();
    },
    onError,
  });
}

function createPrototypeCleanupReconciler({ db, storage, bucket, now = () => new Date() }) {
  if (!db || !storage || !bucket) return null;
  return async () => {
    const job = await db.claimPrototypeCleanup({ now: now() });
    if (!job) return { cleaned: false };
    try {
      const artifacts = await db.listPrototypeCleanupArtifacts(job.jobId);
      for (const artifact of artifacts) {
        if (!artifact.storageBucket || artifact.storageBucket !== bucket) {
          throw new Error('Prototype cleanup artifact storage binding is required');
        }
        await storage.deleteObject({ bucket, key: artifact.objectKey });
      }
      await db.deletePrototypeCleanupArtifacts(job.jobId);
      await db.completePrototypeCleanup(job.jobId);
      return { cleaned: true, jobId: job.jobId, artifactCount: artifacts.length };
    } catch (error) {
      await db.failPrototypeCleanup(job.jobId, now());
      throw error;
    }
  };
}

module.exports = {
  COMMAND_STREAM_V2,
  PrototypeRedisCommandPublisherV2,
  assertPrototypeRedisDurability,
  createPrototypeOutboxPublisher,
  createPrototypeTransportRuntime,
  createPrototypeCleanupReconciler,
};
