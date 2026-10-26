import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProxyLifecycle, createScopedModelFetch } from '../src/model-proxy-lifecycle.js';
const baseUrl = 'https://staging.example/api/prototype-model/v1';
test('trusted refresh joins concurrent reads, expires, keeps full tuple and denies after close', async () => {
  let now = Date.now(),
    calls = 0;
  const command = {
    jobId: 'job',
    turnId: 'turn',
    commandId: 'cmd',
    attemptId: 'attempt',
    executionId: 'exec',
    stage: 'generation',
    fenceToken: 2,
    leaseId: 'lease',
    modelId: 'selected/model',
  };
  const lifecycle = new ModelProxyLifecycle({
    proxyBaseUrl: baseUrl,
    command,
    now: () => now,
    controlPlane: {
      post: async (path, input) => {
        calls++;
        assert.equal(path, '/internal/prototype-tokens/refresh');
        assert.equal(input.fenceToken, 2);
        assert.equal(Object.keys(input).length, 8);
        return { token: 'scoped-token', expiresAt: new Date(now + 45000).toISOString() };
      },
    },
  });
  const [a, b] = await Promise.all([lifecycle.credentials(), lifecycle.credentials()]);
  assert.equal(a, b);
  assert.equal(calls, 1);
  now += 36000;
  await lifecycle.credentials();
  assert.equal(calls, 2);
  lifecycle.close();
  await assert.rejects(lifecycle.credentials(), /AUTHORITY_REVOKED/);
});
test('sandbox transport only routes scoped paths and never retries ambiguous calls', async () => {
  let calls = 0;
  const wrapped = createScopedModelFetch({
    baseUrl,
    credentials: async () => 'short-token',
    requestId: () => 'request1',
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(init.headers.get('Authorization'), 'Bearer short-token');
      assert.equal(init.headers.get('X-Prototype-Request-Id'), 'request1');
      assert.equal(init.redirect, 'error');
      throw new Error('unknown outcome');
    },
  });
  await assert.rejects(
    wrapped(`${baseUrl}/chat/completions`, { method: 'POST' }),
    /unknown outcome/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    wrapped('https://foreign.example/v1/chat/completions', { method: 'POST' }),
    /TARGET_DENIED/,
  );
  await assert.rejects(wrapped(`${baseUrl}/responses`, { method: 'POST' }), /TARGET_DENIED/);
  assert.equal(calls, 1);
});
