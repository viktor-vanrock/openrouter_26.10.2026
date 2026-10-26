import assert from 'node:assert/strict';
import test from 'node:test';
import { RedisConcurrencyQuota } from '../src/quota.js';

const command = {
  tenantId: 'tenant_1',
  userId: 'user_1',
  jobId: 'job_1',
  attemptId: 'attempt_1',
  executionId: 'execution_1',
  fenceToken: 2,
  deadlineAt: '2033-05-18T03:33:50.000Z',
};

test('claims all concurrency scopes in one Redis operation', async () => {
  const calls = [];
  const quota = new RedisConcurrencyQuota(
    {
      eval: async (...args) => {
        calls.push(args);
        return [1, 'accepted'];
      },
    },
    { global: 20, tenant: 5, user: 2 },
    () => 2_000_000_000_000,
  );
  assert.deepEqual(await quota.claim(command), { accepted: true, duplicate: false });
  assert.equal(calls[0][1], 5);
  assert.match(calls[0][2], /tenant_1:user_1:execution_1$/);
});

test('reports the limiting scope and duplicate claims', async () => {
  const results = [
    [0, 'tenant'],
    [2, 'duplicate'],
  ];
  const quota = new RedisConcurrencyQuota(
    { eval: async () => results.shift() },
    { global: 20, tenant: 5, user: 2 },
    () => 2_000_000_000_000,
  );
  assert.deepEqual(await quota.claim(command), {
    accepted: false,
    reason: 'tenant_quota_exceeded',
  });
  assert.deepEqual(await quota.claim(command), { accepted: true, duplicate: true });
});

test('release is idempotent but rejects a conflicting identity', async () => {
  const results = [1, 2, 0];
  const quota = new RedisConcurrencyQuota(
    { eval: async () => results.shift() },
    { global: 20, tenant: 5, user: 2 },
  );
  assert.deepEqual(await quota.release(command), { released: true, duplicate: false });
  assert.deepEqual(await quota.release(command), { released: true, duplicate: true });
  assert.deepEqual(await quota.release(command), { released: false, reason: 'identity_conflict' });
});

test('fails before Redis for expired commands or unsafe scope identities', async () => {
  const redis = {
    eval: async () => {
      throw new Error('should not run');
    },
  };
  const quota = new RedisConcurrencyQuota(redis, { global: 20, tenant: 5, user: 2 }, () => 10);
  assert.deepEqual(await quota.claim({ ...command, deadlineAt: new Date(9).toISOString() }), {
    accepted: false,
    reason: 'deadline_expired',
  });
  await assert.rejects(() => quota.claim({ ...command, userId: '../unsafe' }), /userId is invalid/);
});
