import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Redis from 'ioredis';
import { RedisPrototypeCommandSourceV2 } from '@librechat/prototype-worker';
import { RedisBudgetLedger } from '../src/budget.js';
import { RedisExecutionRegistry } from '../src/execution-registry.js';
import { PrototypeOrchestratorRuntime } from '../src/orchestrator-runtime.js';
import { RedisConcurrencyQuota } from '../src/quota.js';

const enabled = process.env.PROTOTYPE_REDIS_INTEGRATION === '1';
const redisUrl = process.env.REDIS_URI || 'redis://127.0.0.1:6379';

function command(suffix, patch = {}) {
  return {
    schemaVersion: 2,
    commandId: `command_${suffix}`,
    kind: 'execute_stage',
    jobId: `job_${suffix}`,
    turnId: `turn_${suffix}`,
    tenantId: `tenant_${suffix}`,
    userId: `user_${suffix}`,
    modelId: 'fake/model',
    expectedRevision: 1,
    attemptId: `attempt_${suffix}`,
    executionId: `execution_${suffix}`,
    stage: 'generation',
    fenceToken: 1,
    checkpoint: null,
    sourceDigest: null,
    budget: {
      currency: 'USD',
      maxCostUsd: 1,
      maxRequests: 2,
      maxInputTokens: null,
      maxOutputTokens: null,
    },
    createdAt: '2026-09-24T10:00:00.000Z',
    deadlineAt: '2033-05-18T03:33:50.000Z',
    ...patch,
  };
}

test(
  'real Redis preserves execution dedupe across registry instances and the claim/schedule crash window',
  { skip: !enabled },
  async () => {
    const redis = new Redis(redisUrl);
    const value = command(randomUUID());
    const first = new RedisExecutionRegistry(redis);
    const second = new RedisExecutionRegistry(redis);
    try {
      assert.deepEqual(await first.claim(value, 2_000_000_000_000), {
        accepted: true,
        duplicate: false,
        scheduled: false,
      });
      assert.deepEqual(await second.claim(value, 2_000_000_000_000), {
        accepted: true,
        duplicate: true,
        scheduled: false,
      });
      assert.equal(await second.markScheduled(value), true);
      assert.deepEqual(await first.claim(value, 2_000_000_000_000), {
        accepted: true,
        duplicate: true,
        scheduled: true,
      });
    } finally {
      await redis.del(first.key(value), first.scheduledKey(value));
      redis.disconnect();
    }
  },
);

test(
  'real Redis enforces and releases user concurrency atomically',
  { skip: !enabled },
  async () => {
    const redis = new Redis(redisUrl);
    const suffix = randomUUID();
    const first = command(`${suffix}_a`, {
      tenantId: `tenant_${suffix}`,
      userId: `user_${suffix}`,
    });
    const second = command(`${suffix}_b`, { tenantId: first.tenantId, userId: first.userId });
    const quota = new RedisConcurrencyQuota(
      redis,
      { global: 10, tenant: 2, user: 1 },
      () => 2_000_000_000_000,
    );
    try {
      assert.deepEqual(await quota.claim(first), { accepted: true, duplicate: false });
      assert.deepEqual(await quota.claim(second), {
        accepted: false,
        reason: 'user_quota_exceeded',
      });
      assert.deepEqual(await quota.release(first), { released: true, duplicate: false });
      assert.deepEqual(await quota.claim(second), { accepted: true, duplicate: false });
    } finally {
      await quota.release(first);
      await quota.release(second);
      redis.disconnect();
    }
  },
);

test(
  'real Redis budget settlement is idempotent and cannot be reopened',
  { skip: !enabled },
  async () => {
    const redis = new Redis(redisUrl);
    const suffix = randomUUID();
    const scope = {
      tenantId: `tenant_${suffix}`,
      userId: `user_${suffix}`,
      jobId: `job_${suffix}`,
      turnId: 'turn_1',
    };
    const ledger = new RedisBudgetLedger(redis);
    try {
      assert.deepEqual(
        await ledger.reserve(scope, {
          reservationId: 'reservation_1',
          amountUsd: 0.5,
          ceilingUsd: 1,
          maxRequests: 30,
        }),
        { accepted: true, duplicate: false, reservedUsd: 0.5 },
      );
      assert.deepEqual(
        await ledger.settle(scope, {
          reservationId: 'reservation_1',
          actualCostUsd: 0.4,
        }),
        { settled: true, duplicate: false, actualCostUsd: 0.4 },
      );
      assert.deepEqual(
        await ledger.settle(scope, {
          reservationId: 'reservation_1',
          actualCostUsd: 0.4,
        }),
        { settled: true, duplicate: true, actualCostUsd: 0.4 },
      );
      assert.deepEqual(
        await ledger.reserve(scope, {
          reservationId: 'reservation_1',
          amountUsd: 0.5,
          ceilingUsd: 1,
          maxRequests: 30,
        }),
        { accepted: false, reason: 'reservation_settled' },
      );
    } finally {
      const keys = ledger.keys(scope, 'reservation_1');
      await redis.del(
        keys.reservation,
        keys.spent,
        keys.reserved,
        keys.settled,
        keys.expirations,
        keys.requests,
      );
      redis.disconnect();
    }
  },
);

test(
  'real Redis keeps an expired reservation charged when upstream usage is unknown',
  { skip: !enabled },
  async () => {
    const redis = new Redis(redisUrl);
    const suffix = randomUUID();
    const scope = {
      tenantId: `tenant_${suffix}`,
      userId: `user_${suffix}`,
      jobId: `job_${suffix}`,
      turnId: 'turn_1',
    };
    let now = 1_000_000;
    const ledger = new RedisBudgetLedger(redis, {
      reservationTtlMs: 1000,
      settlementTtlMs: 86_400_000,
      now: () => now,
    });
    try {
      assert.deepEqual(
        await ledger.reserve(scope, {
          reservationId: 'first',
          amountUsd: 0.8,
          ceilingUsd: 1,
          maxRequests: 30,
        }),
        { accepted: true, duplicate: false, reservedUsd: 0.8 },
      );
      now += 1001;
      assert.deepEqual(
        await ledger.reserve(scope, {
          reservationId: 'second',
          amountUsd: 0.4,
          ceilingUsd: 1,
          maxRequests: 30,
        }),
        { accepted: false, reason: 'budget_exceeded' },
      );
      assert.deepEqual(
        await ledger.reserve(scope, {
          reservationId: 'first',
          amountUsd: 0.8,
          ceilingUsd: 1,
          maxRequests: 30,
        }),
        { accepted: false, reason: 'reservation_settled' },
      );
      const keys = ledger.keys(scope, 'first');
      assert.equal(Number(await redis.get(keys.spent)), 0.8);
      assert.equal(Number(await redis.get(keys.reserved)), 0);
      assert.deepEqual(
        await ledger.settle(scope, {
          reservationId: 'first',
          actualCostUsd: 0.2,
        }),
        { settled: false, reason: 'settlement_conflict' },
      );
    } finally {
      const first = ledger.keys(scope, 'first');
      const second = ledger.keys(scope, 'second');
      await redis.del(
        first.reservation,
        first.spent,
        first.reserved,
        first.settled,
        first.expirations,
        first.requests,
        second.reservation,
        second.settled,
      );
      redis.disconnect();
    }
  },
);

test(
  'real Redis only refunds a bounded reservation after an exact known settlement',
  { skip: !enabled },
  async () => {
    const redis = new Redis(redisUrl);
    const suffix = randomUUID();
    const scope = {
      tenantId: `tenant_${suffix}`,
      userId: `user_${suffix}`,
      jobId: `job_${suffix}`,
      turnId: 'turn_1',
    };
    const ledger = new RedisBudgetLedger(redis);
    try {
      assert.equal(
        (
          await ledger.reserve(scope, {
            reservationId: 'first',
            amountUsd: 0.8,
            ceilingUsd: 1,
            maxRequests: 30,
          })
        ).accepted,
        true,
      );
      assert.deepEqual(
        await ledger.settle(scope, {
          reservationId: 'first',
          actualCostUsd: 0.2,
        }),
        { settled: true, duplicate: false, actualCostUsd: 0.2 },
      );
      assert.equal(
        (
          await ledger.reserve(scope, {
            reservationId: 'second',
            amountUsd: 0.8,
            ceilingUsd: 1,
            maxRequests: 30,
          })
        ).accepted,
        true,
      );
      assert.deepEqual(
        await ledger.settle(scope, {
          reservationId: 'second',
          actualCostUsd: 0.9,
        }),
        { settled: false, reason: 'reservation_exceeded' },
      );
      assert.ok(Math.abs(Number(await redis.get(ledger.keys(scope, 'second').spent)) - 1.1) < 1e-9);
      assert.deepEqual(
        await ledger.reserve(scope, {
          reservationId: 'third',
          amountUsd: 0.01,
          ceilingUsd: 1,
          maxRequests: 30,
        }),
        { accepted: false, reason: 'budget_exceeded' },
      );
    } finally {
      const first = ledger.keys(scope, 'first');
      const second = ledger.keys(scope, 'second');
      const third = ledger.keys(scope, 'third');
      await redis.del(
        first.reservation,
        first.spent,
        first.reserved,
        first.settled,
        first.requests,
        first.expirations,
        second.reservation,
        second.settled,
        third.reservation,
        third.settled,
      );
      redis.disconnect();
    }
  },
);

test(
  'real Redis isolates budget by turn and caps accepted request count',
  { skip: !enabled },
  async () => {
    const redis = new Redis(redisUrl);
    const suffix = randomUUID();
    const shared = {
      tenantId: `tenant_${suffix}`,
      userId: `user_${suffix}`,
      jobId: `job_${suffix}`,
    };
    const firstTurn = { ...shared, turnId: 'turn_first' };
    const secondTurn = { ...shared, turnId: 'turn_second' };
    const ledger = new RedisBudgetLedger(redis);
    const budget = { amountUsd: 0.2, ceilingUsd: 1, maxRequests: 2 };
    try {
      assert.equal(
        (await ledger.reserve(firstTurn, { reservationId: 'one', ...budget })).accepted,
        true,
      );
      assert.equal(
        (await ledger.reserve(firstTurn, { reservationId: 'two', ...budget })).accepted,
        true,
      );
      assert.deepEqual(await ledger.reserve(firstTurn, { reservationId: 'three', ...budget }), {
        accepted: false,
        reason: 'request_limit_exceeded',
      });
      assert.equal(
        (await ledger.reserve(secondTurn, { reservationId: 'one', ...budget })).accepted,
        true,
      );
      assert.deepEqual(await ledger.reserve(firstTurn, { reservationId: 'one', ...budget }), {
        accepted: true,
        duplicate: true,
        reservedUsd: 0.2,
      });
    } finally {
      const keys = [
        ledger.keys(firstTurn, 'one'),
        ledger.keys(firstTurn, 'two'),
        ledger.keys(firstTurn, 'three'),
        ledger.keys(secondTurn, 'one'),
      ];
      await redis.del(...new Set(keys.flatMap((entry) => Object.values(entry))));
      redis.disconnect();
    }
  },
);

test(
  'real Redis command source reclaims an unacked v2 delivery after consumer restart',
  { skip: !enabled },
  async () => {
    const redis = new Redis(redisUrl);
    const suffix = randomUUID();
    const group = `prototype-service-test-${suffix}`;
    const value = command(suffix);
    const sourceA = new RedisPrototypeCommandSourceV2(redis, `consumer-a-${suffix}`, {
      group,
      blockMs: 10,
      claimIdleMs: 0,
    });
    const sourceB = new RedisPrototypeCommandSourceV2(redis, `consumer-b-${suffix}`, {
      group,
      blockMs: 10,
      claimIdleMs: 0,
    });
    let streamId;
    try {
      await sourceA.ensureGroup();
      // The shared integration Redis may contain commands from earlier runs. This
      // test owns a unique group and starts it at the current tail before adding
      // its fixture, so reclaim evidence cannot be satisfied by unrelated data.
      await redis.xgroup('SETID', 'prototype.commands.v2', group, '$');
      streamId = await redis.xadd('prototype.commands.v2', '*', 'command', JSON.stringify(value));
      assert.deepEqual(await sourceA.next(), { streamId, command: value });
      assert.deepEqual(await sourceB.next(), { streamId, command: value });
      await sourceB.acknowledge(streamId);
    } finally {
      if (streamId) await redis.xdel('prototype.commands.v2', streamId);
      await redis.xgroup('DESTROY', 'prototype.commands.v2', group).catch(() => undefined);
      redis.disconnect();
    }
  },
);

test(
  'real Redis service replica restart resumes an unacked scheduled command without rescheduling it',
  { skip: !enabled },
  async () => {
    const redis = new Redis(redisUrl);
    const suffix = randomUUID();
    const group = `prototype-service-restart-${suffix}`;
    const value = command(suffix);
    const sourceA = new RedisPrototypeCommandSourceV2(redis, `replica-a-${suffix}`, {
      group,
      blockMs: 10,
      claimIdleMs: 0,
    });
    const sourceB = new RedisPrototypeCommandSourceV2(redis, `replica-b-${suffix}`, {
      group,
      blockMs: 10,
      claimIdleMs: 0,
    });
    const registryA = new RedisExecutionRegistry(redis);
    const registryB = new RedisExecutionRegistry(redis);
    const scheduled = [];
    const scheduler = {
      createExecution: async (input) => scheduled.push(input.executionId),
    };
    const events = { publishRejected: async () => assert.fail('valid command was rejected') };
    let streamId;
    try {
      const replicaA = new PrototypeOrchestratorRuntime({
        source: sourceA,
        events,
        registry: registryA,
        scheduler,
        supervisor: {
          prepare: async () => undefined,
          complete: async () => {
            throw new Error('replica terminated before ACK');
          },
        },
        buildJobInput: (input) => input,
      });
      await replicaA.prepare();
      await redis.xgroup('SETID', 'prototype.commands.v2', group, '$');
      streamId = await redis.xadd('prototype.commands.v2', '*', 'command', JSON.stringify(value));

      const firstDelivery = await sourceA.next();
      assert.deepEqual(firstDelivery, { streamId, command: value });
      await assert.rejects(() => replicaA.handle(firstDelivery), /replica terminated before ACK/);
      assert.equal(await redis.get(registryA.scheduledKey(value)), value.executionId);

      const replicaB = new PrototypeOrchestratorRuntime({
        source: sourceB,
        events,
        registry: registryB,
        scheduler,
        buildJobInput: (input) => input,
      });
      await replicaB.prepare();
      const reclaimed = await sourceB.next();
      assert.deepEqual(reclaimed, { streamId, command: value });
      assert.deepEqual(await replicaB.handle(reclaimed), {
        accepted: true,
        duplicate: true,
        scheduled: true,
      });

      assert.deepEqual(scheduled, [value.executionId]);
      const pending = await redis.xpending('prototype.commands.v2', group);
      assert.equal(Number(pending[0]), 0);
    } finally {
      if (streamId) await redis.xdel('prototype.commands.v2', streamId);
      await redis.del(registryA.key(value), registryA.scheduledKey(value));
      await redis.xgroup('DESTROY', 'prototype.commands.v2', group).catch(() => undefined);
      redis.disconnect();
    }
  },
);
