import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPrototypeConfig, PrototypeConfigError } from '../src/config.js';
import { createRoleServer } from '../src/server.js';

test('production orchestrator config fails closed without sandbox capabilities', () => {
  assert.throws(
    () =>
      loadPrototypeConfig({
        NODE_ENV: 'production',
        PROTOTYPE_SERVICE_ROLE: 'orchestrator',
        PROTOTYPE_CONTROL_PLANE_URL: 'https://control.internal',
        REDIS_URI: 'rediss://redis.internal',
      }),
    PrototypeConfigError,
  );
});

test('orchestrator config exposes projected output and only non-production test identity', () => {
  const base = {
    PROTOTYPE_SERVICE_ROLE: 'orchestrator',
    PROTOTYPE_CONTROL_PLANE_URL: 'http://127.0.0.1:3080',
    PROTOTYPE_PROJECTED_OUTPUT_ROOT: '/projected/prototype-output',
    PROTOTYPE_TEST_WORKER_IDENTITY: 'integration-worker',
  };
  const testConfig = loadPrototypeConfig({ NODE_ENV: 'test', ...base });
  assert.equal(testConfig.projectedOutputRoot, '/projected/prototype-output');
  assert.equal(testConfig.testWorkerIdentity, 'integration-worker');
});

test('dependency gateway rejects embedded proxy credentials', () => {
  assert.throws(
    () =>
      loadPrototypeConfig({
        NODE_ENV: 'test',
        PROTOTYPE_SERVICE_ROLE: 'dependency-gateway',
        PROTOTYPE_OUTBOUND_PROXY_TYPE: 'http-forward',
        PROTOTYPE_OUTBOUND_PROXY_URL: 'http://user:secret@proxy.test:8080',
      }),
    /credentials separately/,
  );
});

test('health and readiness remain distinct and shutdown aborts work', async () => {
  let ready = false;
  const service = createRoleServer({
    config: { role: 'orchestrator', host: '127.0.0.1', port: 0, shutdownTimeoutMs: 1_000 },
    lifecycle: { isReady: async () => ready },
  });
  const address = await service.start();
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  ready = true;
  await service.refreshReadiness();
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  await service.stop('test');
  assert.equal(service.signal.aborted, true);
});
