import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PrototypeControlPlaneClient,
  PrototypeControlPlaneError,
} from '../src/control-plane-client.js';

function jsonResponse(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const lease = {
  jobId: 'job_1',
  turnId: 'turn_1',
  commandId: 'command_1',
  expectedRevision: 2,
  attemptId: 'attempt_1',
  executionId: 'execution_1',
  stage: 'generation',
  fenceToken: 3,
  leaseId: 'lease_1',
};

test('control-plane logs carry command identity and HTTP status but exclude tokens and request bodies', async () => {
  const events = [];
  const client = new PrototypeControlPlaneClient({
    baseUrl: 'https://control.test',
    headers: async () => ({ Authorization: 'Bearer private-token' }),
    log: (event, fields) => events.push({ event, ...fields }),
    fetchImpl: async () => jsonResponse(401, { error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED' } }),
  });
  await assert.rejects(client.registerLease({ ...lease, prompt: 'private-prompt' }), {
    code: 'PROTOTYPE_WORKER_UNAUTHORIZED',
  });
  const failure = events.find((entry) => entry.event === 'control.failed');
  assert.equal(failure.jobId, lease.jobId);
  assert.equal(failure.executionId, lease.executionId);
  assert.equal(failure.httpStatus, 401);
  assert.equal(failure.operation, 'leases');
  assert.doesNotMatch(JSON.stringify(events), /private-token|private-prompt/);
  events.length = 0;
  await assert.rejects(client.post('/internal/prototype-control/v2/heartbeat', { ready: true }));
  assert.equal(events.length, 0);
});

test('posts lease and completion contracts with injected service identity', async () => {
  const calls = [];
  const responses = [
    jsonResponse(200, { jobId: 'job_1', revision: 2, fenceToken: 3, leaseId: 'lease_1' }),
    jsonResponse(202, { eventId: 'event_1', accepted: true }),
    jsonResponse(202, { eventId: 'event_2', accepted: true }),
    jsonResponse(202, { eventId: 'event_3', accepted: true }),
    jsonResponse(202, { eventId: 'event_4', accepted: true }),
  ];
  const client = new PrototypeControlPlaneClient({
    baseUrl: 'https://control.internal/base/',
    environment: 'production',
    headers: async () => ({ 'x-prototype-service': 'synthetic-identity' }),
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return responses.shift();
    },
  });
  assert.deepEqual(await client.registerLease(lease), {
    jobId: 'job_1',
    revision: 2,
    fenceToken: 3,
    leaseId: 'lease_1',
  });
  assert.deepEqual(await client.completeStage({ ...lease, pipelineStep: 0 }), {
    eventId: 'event_1',
    accepted: true,
  });
  assert.deepEqual(await client.completePublication({ ...lease, pipelineStep: 5 }), {
    eventId: 'event_2',
    accepted: true,
  });
  assert.deepEqual(await client.failStage({ ...lease, pipelineStep: 4 }), {
    eventId: 'event_3',
    accepted: true,
  });
  assert.deepEqual(await client.completeWaiting({ ...lease, pipelineStep: 0 }), {
    eventId: 'event_4',
    accepted: true,
  });
  assert.equal(calls[0][0].pathname, '/internal/prototype-control/v2/leases');
  assert.equal(calls[1][0].pathname, '/internal/prototype-control/v2/stage-completions');
  assert.equal(calls[2][0].pathname, '/internal/prototype-control/v2/publications');
  assert.equal(calls[3][0].pathname, '/internal/prototype-control/v2/stage-failures');
  assert.equal(calls[4][0].pathname, '/internal/prototype-control/v2/waiting');
  assert.equal(calls[0][1].headers['x-prototype-service'], 'synthetic-identity');
  assert.equal(calls[0][1].redirect, 'error');
});

test('maps only safe control-plane errors without returning response details', async () => {
  const canary = 'private database credentials';
  for (const [status, responseCode, expectedCode] of [
    [409, 'PROTOTYPE_STALE_REVISION', 'PROTOTYPE_STALE_REVISION'],
    [401, 'PROTOTYPE_WORKER_UNAUTHORIZED', 'PROTOTYPE_WORKER_UNAUTHORIZED'],
    [503, 'PRIVATE_INTERNAL_ERROR', 'PROTOTYPE_SERVICE_UNAVAILABLE'],
  ]) {
    const client = new PrototypeControlPlaneClient({
      baseUrl: 'http://127.0.0.1:3080',
      environment: 'test',
      fetchImpl: async () =>
        jsonResponse(status, { error: { code: responseCode, detail: canary } }),
    });
    await assert.rejects(
      () => client.registerLease(lease),
      (error) =>
        error instanceof PrototypeControlPlaneError &&
        error.code === expectedCode &&
        !error.message.includes(canary),
    );
  }
});

test('fails closed for redirects, malformed responses, excessive bytes, and transport errors', async () => {
  const scenarios = [
    async () => jsonResponse(200, { accepted: 'yes' }),
    async () => new Response('x'.repeat(100), { status: 200 }),
    async () => {
      throw new Error('socket included a secret');
    },
  ];
  for (const fetchImpl of scenarios) {
    const client = new PrototypeControlPlaneClient({
      baseUrl: 'http://127.0.0.1:3080',
      environment: 'test',
      fetchImpl,
      maxResponseBytes: 32,
    });
    await assert.rejects(
      () => client.completeStage({ ...lease, pipelineStep: 0 }),
      (error) => error instanceof PrototypeControlPlaneError && !error.message.includes('secret'),
    );
  }
});

test('requires HTTPS in production and rejects embedded URL credentials', () => {
  assert.throws(
    () =>
      new PrototypeControlPlaneClient({
        baseUrl: 'http://control.internal',
        environment: 'production',
      }),
    /URL is invalid/,
  );
  assert.throws(
    () =>
      new PrototypeControlPlaneClient({
        baseUrl: 'https://user:secret@control.internal',
        environment: 'production',
      }),
    /URL is invalid/,
  );
});

test('production bearer client sends identity only to bounded API paths over HTTPS', async () => {
  const token = 'a'.repeat(64),
    calls = [];
  const client = PrototypeControlPlaneClient.fromBearerConfig({
    baseUrl: 'https://chat.test/api/',
    token,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return jsonResponse(202, { accepted: true });
    },
  });
  await client.post('/internal/prototype-tokens/refresh', {});
  assert.equal(calls[0][0].href, 'https://chat.test/api/internal/prototype-tokens/refresh');
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0][1].redirect, 'error');
  for (const path of [
    'https://evil.test',
    '/internal/prototype-tokens/../leak',
    '/internal/prototype-tokens?leak',
  ]) {
    await assert.rejects(() => client.post(path, {}), /PROTOTYPE_CONTROL_PATH_INVALID/);
  }
  assert.equal(calls.length, 1);
  assert.throws(
    () => PrototypeControlPlaneClient.fromBearerConfig({ baseUrl: 'http://chat.test', token }),
    /URL is invalid/,
  );
  assert.throws(
    () =>
      PrototypeControlPlaneClient.fromBearerConfig({
        baseUrl: 'https://chat.test',
        token: 'short',
      }),
    /AUTH_CONFIG_INVALID/,
  );
});
