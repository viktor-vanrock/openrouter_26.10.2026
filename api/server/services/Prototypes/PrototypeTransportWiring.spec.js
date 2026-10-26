const {
  PrototypeRedisCommandPublisherV2,
  assertPrototypeRedisDurability,
  createPrototypeOutboxPublisher,
  createPrototypeTransportRuntime,
  createPrototypeCleanupReconciler,
} = require('./PrototypeTransportWiring');

const command = {
  schemaVersion: 2, commandId: 'command_1', kind: 'execute_stage', jobId: 'job_1',
  turnId: 'turn_1', tenantId: 'tenant_1', userId: 'user_1', modelId: 'fake/model', expectedRevision: 1,
  attemptId: 'attempt_1', executionId: 'execution_1', stage: 'generation', fenceToken: 1,
  checkpointRevision: null, checkpointDigest: null, sourceDigest: null,
  budget: { currency: 'USD', maxCostUsd: 1, maxRequests: 2, maxInputTokens: null, maxOutputTokens: null },
  deadlineAt: new Date('2026-09-24T10:10:00.000Z'), attachmentManifest: [],
  createdAt: new Date('2026-09-24T10:00:00.000Z'), status: 'publishing', publishAttempts: 1,
};

describe('Prototype transport wiring', () => {
  it('publishes only v2 command envelopes to the isolated stream', async () => {
    const redis = { xadd: jest.fn() };
    const publisher = new PrototypeRedisCommandPublisherV2(redis);
    await publisher.publish({ schemaVersion: 2, commandId: 'command_1' });
    expect(redis.xadd).toHaveBeenCalledWith(
      'prototype.commands.v2', '*', 'command', JSON.stringify({ schemaVersion: 2, commandId: 'command_1' }),
    );
    await expect(publisher.publish({ schemaVersion: 1 })).rejects.toThrow('only v2');
  });

  it('binds Mongo publication claims to one API replica identity', async () => {
    const db = {
      claimPrototypeOutbox: jest.fn(async () => command),
      markPrototypeOutboxPublished: jest.fn(),
      releasePrototypeOutboxClaim: jest.fn(),
    };
    const redis = { xadd: jest.fn() };
    const now = () => new Date('2026-09-24T10:00:00.000Z');
    const publisher = createPrototypeOutboxPublisher({
      db, redis, publisherId: 'api-a', leaseMs: 30_000, now,
    });
    await publisher.runOnce();
    expect(db.claimPrototypeOutbox).toHaveBeenCalledWith({
      publisherId: 'api-a', now: now(), leaseMs: 30_000,
    });
    expect(db.markPrototypeOutboxPublished).toHaveBeenCalledWith('command_1', 'api-a', now());
  });

  it('fails closed unless the dedicated Redis is persistent and noeviction', async () => {
    const redis = {
      config: jest.fn(async (_command, key) => ({
        'maxmemory-policy': ['maxmemory-policy', 'noeviction'],
        appendonly: ['appendonly', 'yes'],
        save: ['save', ''],
      })[key]),
    };
    await expect(assertPrototypeRedisDurability(redis)).resolves.toBeUndefined();
    redis.config.mockImplementation(async (_command, key) => ({
      'maxmemory-policy': ['maxmemory-policy', 'allkeys-lru'],
      appendonly: ['appendonly', 'no'], save: ['save', ''],
    })[key]);
    await expect(assertPrototypeRedisDurability(redis)).rejects.toThrow('noeviction');
  });

  it('assembles publisher, transactional event consumer, and reconciler into one runtime', async () => {
    let rejectRead;
    const redis = {
      xgroup: jest.fn(async () => 'OK'),
      xautoclaim: jest.fn(async () => ['0-0', []]),
      xreadgroup: jest.fn(async () => new Promise((_, reject) => { rejectRead = reject; })),
      xadd: jest.fn(), xack: jest.fn(),
      disconnect: jest.fn(() => rejectRead?.(new Error('closed'))),
    };
    const db = {
      claimPrototypeOutbox: jest.fn(async () => null),
      markPrototypeOutboxPublished: jest.fn(), releasePrototypeOutboxClaim: jest.fn(),
      claimPrototypeWorkerEvent: jest.fn(), updatePrototypeExecution: jest.fn(),
      finishPrototypeExecution: jest.fn(), reconcilePrototypeOutboxClaims: jest.fn(),
    };
    const runtime = createPrototypeTransportRuntime({
      redis, db, startSession: jest.fn(), loadJob: jest.fn(), parseEvent: (value) => value,
      consumerId: 'api-events-a', publisherId: 'api-outbox-a', onError: jest.fn(),
    });
    await runtime.start();
    expect(runtime.isReady()).toBe(true);
    await runtime.stop();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('uses a dedicated Redis connection for blocking event reads', async () => {
    let rejectRead;
    const redis = { xadd: jest.fn(), disconnect: jest.fn() };
    const eventRedis = {
      xgroup: jest.fn(async () => 'OK'),
      xautoclaim: jest.fn(async () => ['0-0', []]),
      xreadgroup: jest.fn(async () => new Promise((_, reject) => { rejectRead = reject; })),
      xack: jest.fn(),
      disconnect: jest.fn(() => rejectRead?.(new Error('closed'))),
    };
    const db = {
      claimPrototypeOutbox: jest.fn(async () => null),
      markPrototypeOutboxPublished: jest.fn(), releasePrototypeOutboxClaim: jest.fn(),
      claimPrototypeWorkerEvent: jest.fn(), updatePrototypeExecution: jest.fn(),
      finishPrototypeExecution: jest.fn(), reconcilePrototypeOutboxClaims: jest.fn(),
    };
    const runtime = createPrototypeTransportRuntime({
      redis, eventRedis, db, startSession: jest.fn(), loadJob: jest.fn(),
      parseEvent: (value) => value, consumerId: 'api-events-a', publisherId: 'api-outbox-a',
    });
    await runtime.start();
    await runtime.stop();
    expect(eventRedis.xreadgroup).toHaveBeenCalled();
    expect(redis.xreadgroup).toBeUndefined();
    expect(eventRedis.disconnect).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });

  it('retries durable cleanup and removes only the claimed job artifacts', async () => {
    const db = {
      claimPrototypeCleanup: jest.fn()
        .mockResolvedValueOnce({ jobId: 'job_1' })
        .mockResolvedValueOnce({ jobId: 'job_2' }),
      listPrototypeCleanupArtifacts: jest.fn()
        .mockResolvedValueOnce([{ objectKey: 'jobs/job_1/a', storageBucket: 'prototype-test' }, { objectKey: 'jobs/job_1/b', storageBucket: 'prototype-test' }])
        .mockResolvedValueOnce([{ objectKey: 'jobs/job_2/a', storageBucket: 'prototype-test' }]),
      deletePrototypeCleanupArtifacts: jest.fn(),
      completePrototypeCleanup: jest.fn(),
      failPrototypeCleanup: jest.fn(),
    };
    const storage = {
      deleteObject: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('temporary S3 outage')),
    };
    const cleanup = createPrototypeCleanupReconciler({
      db,
      storage,
      bucket: 'prototype-test',
      now: () => new Date('2026-09-28T00:00:00.000Z'),
    });

    await expect(cleanup()).resolves.toEqual({
      cleaned: true, jobId: 'job_1', artifactCount: 2,
    });
    expect(storage.deleteObject).toHaveBeenNthCalledWith(1, {
      bucket: 'prototype-test', key: 'jobs/job_1/a',
    });
    expect(db.completePrototypeCleanup).toHaveBeenCalledWith('job_1');

    await expect(cleanup()).rejects.toThrow('temporary S3 outage');
    expect(db.failPrototypeCleanup).toHaveBeenCalledWith(
      'job_2',
      new Date('2026-09-28T00:00:00.000Z'),
    );
    expect(db.deletePrototypeCleanupArtifacts).not.toHaveBeenCalledWith('job_2');
  });
});

it('never redirects cleanup of an unbound historical object into the current shared bucket', async () => {
  const { createPrototypeCleanupReconciler } = require('./PrototypeTransportWiring');
  const storage = { deleteObject: jest.fn() };
  const db = { claimPrototypeCleanup: jest.fn(async () => ({ jobId: 'job_legacy' })),
    listPrototypeCleanupArtifacts: jest.fn(async () => [{ objectKey: 'historical/a' }]),
    failPrototypeCleanup: jest.fn(), completePrototypeCleanup: jest.fn(), deletePrototypeCleanupArtifacts: jest.fn() };
  const cleanup = createPrototypeCleanupReconciler({ db, storage, bucket: 'current-shared-bucket' });
  await expect(cleanup()).rejects.toThrow('storage binding');
  expect(storage.deleteObject).not.toHaveBeenCalled();
  expect(db.completePrototypeCleanup).not.toHaveBeenCalled();
  expect(db.failPrototypeCleanup).toHaveBeenCalled();
});
