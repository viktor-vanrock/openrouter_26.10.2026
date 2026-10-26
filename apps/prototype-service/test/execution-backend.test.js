import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPrototypeConfig } from '../src/config.js';
import { createExecutionBackend } from '../src/execution-backend.js';
import { SandboxGatewayClient } from '../src/sandbox-gateway-client.js';
const env = {
  NODE_ENV: 'production',
  PROTOTYPE_EXECUTION_BACKEND: 'sandbox-gateway',
  PROTOTYPE_CONTROL_PLANE_URL: 'https://control.test',
  SANDBOX_GATEWAY_URL: 'https://gateway.test',
  SANDBOX_GATEWAY_TOKEN: 'test-token',
  AWS_BUCKET_NAME: 'shared-files',
  AWS_REGION: 'explicit',
  AWS_ENDPOINT_URL: 'https://s3.test',
  OPENROUTER_API_URL: 'https://provider.test/v1',
  REDIS_URI: 'redis://127.0.0.1:19079',
};

test('Gateway production config never requires or exposes Kubernetes credentials', async () => {
  const config = loadPrototypeConfig(env, 'orchestrator');
  assert.equal(config.schedulerContext, null);
  assert.equal(config.kubernetesTokenPath, null);
  assert.equal(config.kubernetesApiUrl, null);
  const backend = await createExecutionBackend({
    config,
    directory: '/unused',
    gateway: { probe: async () => ({ api: 1, version: 'compatible-next-release' }) },
  });
  assert.match(backend.pipeline.image, /@sha256:/);
  assert.equal(backend.release.build.profile, 'offline-react-build-v1');
});

test('multi-file build is an explicitly selected pinned profile and never changes the baseline default', async () => {
  const config = loadPrototypeConfig(env, 'orchestrator');
  const options = { config, directory: '/unused', gateway: { probe: async () => ({ api: 1 }) } };
  const baseline = await createExecutionBackend(options);
  const fsd = await createExecutionBackend({ ...options, profile: 'offline-react-fsd-build-v1' });
  assert.notEqual(fsd.profile, baseline.profile);
  assert.equal(baseline.profile, 'offline-react-build-v1');
  await assert.rejects(
    createExecutionBackend({ ...options, profile: 'caller-profile' }),
    /PROFILE_INVALID/,
  );
});

test('Gateway rejects absent credentials, unsupported backend, insecure URL and missing signing region', () => {
  for (const patch of [
    { SANDBOX_GATEWAY_TOKEN: '' },
    { SANDBOX_GATEWAY_URL: 'http://gateway.test' },
    { PROTOTYPE_EXECUTION_BACKEND: 'host' },
    { AWS_REGION: '' },
  ]) {
    assert.throws(() => loadPrototypeConfig({ ...env, ...patch }, 'orchestrator'));
  }
  assert.throws(() => new SandboxGatewayClient({ baseUrl: 'https://gateway.test', token: '' }));
});

test('public version compatibility does not substitute for authenticated readiness', async () => {
  const g = new SandboxGatewayClient({ baseUrl: 'https://gateway.test', token: 'test' });
  const requests = [];
  g.request = async (_method, path) => {
    requests.push(path);
    return { api: 1, version: 'v0.7.4' };
  };
  assert.equal((await g.probe()).api, 1);
  assert.deepEqual(requests, ['/version', '/sandboxes?limit=1']);
  g.request = async () => ({ api: 2 });
  await assert.rejects(g.probe(), /UNSUPPORTED/);
});

test('Amazon S3 relies on the regional SDK endpoint in production when no custom endpoint is configured', () => {
  const config = loadPrototypeConfig({ ...env, AWS_ENDPOINT_URL: '' }, 'orchestrator');
  assert.equal(config.storageEndpoint, null);
  assert.equal(config.storageRegion, 'explicit');
});
