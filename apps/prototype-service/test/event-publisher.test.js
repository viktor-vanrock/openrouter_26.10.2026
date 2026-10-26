import assert from 'node:assert/strict';
import test from 'node:test';
import { RedisPrototypeEventPublisherV2 } from '../src/event-publisher.js';

const command = {
  commandId: 'command_1',
  jobId: 'job_1',
  turnId: 'turn_1',
  expectedRevision: 2,
  attemptId: 'attempt_1',
  executionId: 'execution_1',
  stage: 'generation',
  fenceToken: 3,
};

test('publishes a schema-validated safe rejection on the v2 event stream', async () => {
  const calls = [];
  const publisher = new RedisPrototypeEventPublisherV2(
    { xadd: async (...args) => calls.push(args) },
    () => new Date('2026-09-24T10:00:00.000Z'),
  );
  await publisher.publishRejected(command, 'identity_conflict');
  assert.equal(calls[0][0], 'prototype.events.v2');
  const event = JSON.parse(calls[0][3]);
  assert.equal(event.payload.code, 'PROTOTYPE_SERVICE_UNAVAILABLE');
  assert.equal(event.payload.retryable, false);
  assert.equal(event.leaseId, 'orchestrator-rejection');
});
