import assert from 'node:assert/strict';
import test from 'node:test';
import { RedisBudgetLedger } from '../src/budget.js';

const scope = { tenantId: 'tenant_1', userId: 'user_1', jobId: 'job_1', turnId: 'turn_1' };

test('passes scoped idempotent reservation keys to one atomic Redis operation', async () => {
  const calls = [];
  const ledger = new RedisBudgetLedger({
    eval: async (...args) => {
      calls.push(args);
      return [1, '0.250000'];
    },
  });
  assert.deepEqual(
    await ledger.reserve(scope, {
      reservationId: 'reservation_1',
      amountUsd: 0.25,
      ceilingUsd: 1,
      maxRequests: 30,
    }),
    { accepted: true, duplicate: false, reservedUsd: 0.25 },
  );
  assert.equal(calls[0][1], 6);
  assert.match(calls[0][2], /tenant_1:user_1:job_1:turn_1:reservation:reservation_1$/);
});

test('reports duplicate settlement without refunding twice', async () => {
  const ledger = new RedisBudgetLedger({ eval: async () => [2, '0.175000'] });
  assert.deepEqual(
    await ledger.settle(scope, {
      reservationId: 'reservation_1',
      actualCostUsd: 0.175,
    }),
    { settled: true, duplicate: true, actualCostUsd: 0.175 },
  );
});

test('rejects reuse of an idempotency identity with different money', async () => {
  const ledger = new RedisBudgetLedger({ eval: async () => [3, '0.250000'] });
  assert.deepEqual(
    await ledger.reserve(scope, {
      reservationId: 'reservation_1',
      amountUsd: 0.5,
      ceilingUsd: 1,
      maxRequests: 30,
    }),
    { accepted: false, reason: 'reservation_conflict' },
  );
  assert.deepEqual(
    await ledger.settle(scope, {
      reservationId: 'reservation_1',
      actualCostUsd: 0.5,
    }),
    { settled: false, reason: 'settlement_conflict' },
  );
});

test('does not reopen an already settled reservation identity', async () => {
  const ledger = new RedisBudgetLedger({ eval: async () => [4, '0.175000'] });
  assert.deepEqual(
    await ledger.reserve(scope, {
      reservationId: 'reservation_1',
      amountUsd: 0.25,
      ceilingUsd: 1,
      maxRequests: 30,
    }),
    { accepted: false, reason: 'reservation_settled' },
  );
});

test('refuses budget reservations without a turn scope and finite request limit', async () => {
  const ledger = new RedisBudgetLedger({ eval: async () => [1, '0.250000'] });
  await assert.rejects(() =>
    ledger.reserve(
      { ...scope, turnId: undefined },
      {
        reservationId: 'one',
        amountUsd: 0.25,
        ceilingUsd: 1,
        maxRequests: 30,
      },
    ),
  );
  await assert.rejects(() =>
    ledger.reserve(scope, {
      reservationId: 'one',
      amountUsd: 0.25,
      ceilingUsd: 1,
      maxRequests: null,
    }),
  );
});

test('rejects unknown or invalid cost instead of treating it as zero', async () => {
  const ledger = new RedisBudgetLedger({ eval: async () => [1, '0'] });
  await assert.rejects(
    () => ledger.settle(scope, { reservationId: 'reservation_1', actualCostUsd: null }),
    /non-negative finite/,
  );
});
