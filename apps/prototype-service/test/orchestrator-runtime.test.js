import assert from 'node:assert/strict';
import test from 'node:test';
import { RedisExecutionRegistry } from '../src/execution-registry.js';
import { PrototypeOrchestratorRuntime } from '../src/orchestrator-runtime.js';
import { PrototypeControlPlaneError } from '../src/control-plane-client.js';

const command = {
  schemaVersion: 2,
  commandId: 'command_1',
  kind: 'execute_stage',
  jobId: 'job_1',
  turnId: 'turn_1',
  expectedRevision: 2,
  attemptId: 'attempt_1',
  executionId: 'execution_1',
  stage: 'generation',
  fenceToken: 3,
  deadlineAt: '2030-01-01T00:00:00.000Z',
};

test('command failure is correlated and does not acknowledge or retry the failed stage', async () => {
  const events = [];
  let attempts = 0;
  const runtime = new PrototypeOrchestratorRuntime({
    executionMode: 'supervised',
    source: { acknowledge: async () => assert.fail('failed command was acknowledged') },
    registry: { claim: async () => ({ accepted: true }) },
    supervisor: {
      prepare: async () => {},
      complete: async () => {
        attempts++;
        throw new PrototypeControlPlaneError('PROTOTYPE_SERVICE_UNAVAILABLE', 503);
      },
    },
    log: (event, fields) => events.push({ event, ...fields }),
  });
  await assert.rejects(runtime.handle({ streamId: '1-0', command }), {
    code: 'PROTOTYPE_SERVICE_UNAVAILABLE',
  });
  assert.equal(attempts, 1);
  assert.equal(events[0].event, 'command.received');
  const failure = events.find((entry) => entry.event === 'command.failed');
  assert.equal(failure.commandId, command.commandId);
  assert.equal(failure.httpStatus, 503);
  assert.ok(!events.some((entry) => entry.event === 'command.acknowledged'));
});

test('durable registry distinguishes retry from conflicting execution', async () => {
  const results = [1, 2, 3, 0];
  const registry = new RedisExecutionRegistry({ eval: async () => results.shift() });
  await assert.doesNotReject(async () => {
    assert.deepEqual(await registry.claim(command, 1_800_000_000_000), {
      accepted: true,
      duplicate: false,
      scheduled: false,
    });
    assert.deepEqual(await registry.claim(command, 1_800_000_000_000), {
      accepted: true,
      duplicate: true,
      scheduled: false,
    });
    assert.deepEqual(await registry.claim(command, 1_800_000_000_000), {
      accepted: true,
      duplicate: true,
      scheduled: true,
    });
    assert.deepEqual(await registry.claim(command, 1_800_000_000_000), {
      accepted: false,
      reason: 'identity_conflict',
    });
  });
});

test('marks a scheduled execution only while its accepted identity is current', async () => {
  const values = [1, 0];
  const registry = new RedisExecutionRegistry({ eval: async () => values.shift() });
  assert.equal(await registry.markScheduled(command), true);
  assert.equal(await registry.markScheduled(command), false);
});

test('registry validates cancellation against the accepted execution identity', async () => {
  const registry = new RedisExecutionRegistry({ get: async () => 'execution_1' });
  assert.equal(await registry.isAccepted(command), true);
  assert.equal(await registry.isAccepted({ ...command, executionId: 'execution_2' }), false);
});

test('duplicate delivery is acknowledged without creating a second Kubernetes Job', async () => {
  const created = [];
  const acknowledged = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async (id) => acknowledged.push(id) },
    events: { publishRejected: async () => {} },
    registry: { claim: async () => ({ accepted: true, duplicate: true, scheduled: true }) },
    scheduler: { createExecution: async (input) => created.push(input) },
    buildJobInput: (value) => value,
  });
  assert.deepEqual(await runtime.handle({ streamId: '1-0', command }), {
    accepted: true,
    duplicate: true,
    scheduled: true,
  });
  assert.deepEqual(created, []);
  assert.deepEqual(acknowledged, ['1-0']);
});

test('new delivery schedules once before acknowledging', async () => {
  const order = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async () => order.push('ack') },
    events: { publishRejected: async () => {} },
    registry: {
      claim: async () => ({ accepted: true, duplicate: false, scheduled: false }),
      markScheduled: async () => {
        order.push('mark');
        return true;
      },
    },
    scheduler: { createExecution: async () => order.push('schedule') },
    buildJobInput: (value) => value,
  });
  await runtime.handle({ streamId: '1-0', command });
  assert.deepEqual(order, ['schedule', 'mark', 'ack']);
});

test('a crash after registry claim retries scheduling before ACK', async () => {
  const order = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async () => order.push('ack') },
    events: { publishRejected: async () => {} },
    registry: {
      claim: async () => ({ accepted: true, duplicate: true, scheduled: false }),
      markScheduled: async () => {
        order.push('mark');
        return true;
      },
    },
    scheduler: { createExecution: async () => order.push('schedule') },
    buildJobInput: (value) => value,
  });
  await runtime.handle({ streamId: '1-0', command });
  assert.deepEqual(order, ['schedule', 'mark', 'ack']);
});

test('supervises a scheduled stage and releases quota before acknowledging', async () => {
  const order = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async () => order.push('ack') },
    events: { publishRejected: async () => {} },
    quota: {
      claim: async () => ({ accepted: true, duplicate: false }),
      release: async () => order.push('release'),
    },
    registry: {
      claim: async () => ({ accepted: true, duplicate: false, scheduled: false }),
      markScheduled: async () => {
        order.push('mark');
        return true;
      },
    },
    scheduler: { createExecution: async () => order.push('schedule') },
    supervisor: {
      prepare: async (value) => {
        assert.equal(value, command);
        order.push('prepare');
      },
      complete: async (value) => {
        assert.equal(value, command);
        order.push('complete');
      },
    },
    buildJobInput: (value) => value,
  });
  await runtime.handle({ streamId: '1-0', command });
  assert.deepEqual(order, ['prepare', 'schedule', 'mark', 'complete', 'release', 'ack']);
});

test('retries supervision without rescheduling or acknowledging after a completion failure', async () => {
  const order = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async () => order.push('ack') },
    events: { publishRejected: async () => {} },
    quota: {
      claim: async () => ({ accepted: true, duplicate: true }),
      release: async () => order.push('release'),
    },
    registry: { claim: async () => ({ accepted: true, duplicate: true, scheduled: true }) },
    scheduler: { createExecution: async () => order.push('schedule') },
    supervisor: {
      prepare: async () => order.push('prepare'),
      complete: async () => {
        order.push('complete');
        throw new Error('control plane down');
      },
    },
    buildJobInput: (value) => value,
  });
  await assert.rejects(() => runtime.handle({ streamId: '1-0', command }), /control plane down/);
  assert.deepEqual(order, ['prepare', 'complete']);
});

test('does not schedule or acknowledge when durable lease registration fails', async () => {
  const order = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async () => order.push('ack') },
    events: { publishRejected: async () => {} },
    quota: {
      claim: async () => ({ accepted: true, duplicate: false }),
      release: async () => order.push('release'),
    },
    registry: { claim: async () => ({ accepted: true, duplicate: false, scheduled: false }) },
    scheduler: { createExecution: async () => order.push('schedule') },
    supervisor: {
      prepare: async () => {
        order.push('prepare');
        throw new Error('lease CAS unavailable');
      },
    },
    buildJobInput: (value) => value,
  });
  await assert.rejects(() => runtime.handle({ streamId: '1-0', command }), /lease CAS unavailable/);
  assert.deepEqual(order, ['prepare', 'release']);
});

test('ACKs a superseded delivery after an authoritative Mongo lease CAS rejection', async () => {
  const order = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async () => order.push('ack') },
    events: { publishRejected: async (_command, reason) => order.push(reason) },
    quota: {
      claim: async () => ({ accepted: true, duplicate: true }),
      release: async () => order.push('release'),
    },
    registry: { claim: async () => ({ accepted: true, duplicate: true, scheduled: true }) },
    scheduler: { createExecution: async () => assert.fail('stale execution was rescheduled') },
    supervisor: {
      prepare: async () => {
        throw new PrototypeControlPlaneError('PROTOTYPE_STALE_REVISION', 409);
      },
      complete: async () => assert.fail('stale execution was completed twice'),
    },
    buildJobInput: (value) => value,
  });
  assert.deepEqual(await runtime.handle({ streamId: '1-0', command }), {
    accepted: false,
    reason: 'stale_execution',
  });
  assert.deepEqual(order, ['release', 'stale_execution', 'ack']);
});

test('keeps failed authorization and unavailable control-plane deliveries pending', async () => {
  for (const error of [
    new PrototypeControlPlaneError('PROTOTYPE_WORKER_UNAUTHORIZED', 401),
    new PrototypeControlPlaneError('PROTOTYPE_SERVICE_UNAVAILABLE', 503),
    Object.assign(new Error('untrusted stale error'), {
      code: 'PROTOTYPE_STALE_REVISION',
      status: 409,
    }),
  ]) {
    const runtime = new PrototypeOrchestratorRuntime({
      source: { acknowledge: async () => assert.fail('unverified failure was ACKed') },
      events: { publishRejected: async () => assert.fail('unverified failure was discarded') },
      registry: { claim: async () => ({ accepted: true, duplicate: true, scheduled: true }) },
      scheduler: { createExecution: async () => assert.fail('failed lease was scheduled') },
      supervisor: {
        prepare: async () => {
          throw error;
        },
      },
      buildJobInput: (value) => value,
    });
    await assert.rejects(
      () => runtime.handle({ streamId: '1-0', command }),
      (value) => value === error,
    );
  }
});

test('quota rejection is published and acknowledged before registry claim', async () => {
  const calls = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async () => calls.push('ack') },
    events: { publishRejected: async () => calls.push('rejected') },
    quota: { claim: async () => ({ accepted: false, reason: 'user_quota_exceeded' }) },
    registry: { claim: async () => calls.push('registry') },
    scheduler: {},
    buildJobInput: (value) => value,
  });
  assert.deepEqual(await runtime.handle({ streamId: '1-0', command }), {
    accepted: false,
    reason: 'user_quota_exceeded',
  });
  assert.deepEqual(calls, ['rejected', 'ack']);
});

test('stale cancellation cannot delete another accepted execution', async () => {
  const calls = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async () => calls.push('ack') },
    events: { publishRejected: async () => calls.push('rejected') },
    registry: { isAccepted: async () => false },
    scheduler: { cancelExecution: async () => calls.push('delete') },
    buildJobInput: (value) => value,
  });
  assert.deepEqual(
    await runtime.handle({
      streamId: '2-0',
      command: { ...command, kind: 'cancel_execution' },
    }),
    { canceled: false, reason: 'stale_execution' },
  );
  assert.deepEqual(calls, ['rejected', 'ack']);
});

test('current cancellation deletes the bounded execution job before ACK', async () => {
  const calls = [];
  const runtime = new PrototypeOrchestratorRuntime({
    source: { acknowledge: async () => calls.push('ack') },
    events: { publishRejected: async () => calls.push('rejected') },
    registry: { isAccepted: async () => true },
    scheduler: { cancelExecution: async () => calls.push('delete') },
    buildJobInput: (value) => value,
  });
  assert.deepEqual(
    await runtime.handle({
      streamId: '2-0',
      command: { ...command, kind: 'cancel_execution' },
    }),
    { canceled: true },
  );
  assert.deepEqual(calls, ['delete', 'ack']);
});

test('prepare establishes the command group before reporting readiness', async () => {
  let ensured = false;
  const runtime = new PrototypeOrchestratorRuntime({
    source: {
      ensureGroup: async () => {
        ensured = true;
      },
      close: async () => {},
    },
    events: {},
    registry: {},
    scheduler: {},
    buildJobInput: (value) => value,
  });
  assert.equal(await runtime.isReady(), false);
  await runtime.prepare();
  assert.equal(ensured, true);
  assert.equal(await runtime.isReady(), true);
  await runtime.stop();
});
