import assert from 'node:assert/strict';
import test from 'node:test';
import { createDependencyGatewayLifecycle } from '../src/dependency-gateway-lifecycle.js';

const config = {
  outboundProxyType: 'http-forward',
  outboundProxyUrl: 'http://proxy.test:8080',
  outboundProxyDestinationGuard: 'attested',
  dependencyClosurePath: '/trusted/closure.json',
  dependencyGatewayPublicUrl: 'http://dependency.internal',
  registryAllowlist: ['registry.example'],
  dependencyMaxRequests: 10,
  dependencyRequestTimeoutMs: 1_000,
  dependencyMaxResponseBytes: 10_000,
};
const closure = [
  {
    name: 'app',
    version: '1.0.0',
    integrity: 'sha512-YWJjZA==',
    metadataPath: '/v1/packages/app',
    tarballPath: '/v1/tarballs/app/1.0.0.tgz',
    metadataUrl: 'https://registry.example/app',
    tarballUrl: 'https://registry.example/app/-/app-1.0.0.tgz',
  },
];

test('dependency gateway lifecycle becomes ready only with closure and attested proxy', async () => {
  const lifecycle = createDependencyGatewayLifecycle({
    readFile: async () => JSON.stringify(closure),
    transportFactory: () => async () => ({ statusCode: 200, headers: {}, body: Buffer.alloc(0) }),
  });
  assert.equal(await lifecycle.isReady(), false);
  await lifecycle.start({ config });
  assert.equal(await lifecycle.isReady(), true);
  await lifecycle.stop();
  assert.equal(await lifecycle.isReady(), false);
});

test('dependency gateway lifecycle fails closed without proxy destination guarantees', async () => {
  const lifecycle = createDependencyGatewayLifecycle({
    readFile: async () => JSON.stringify(closure),
  });
  await assert.rejects(
    () => lifecycle.start({ config: { ...config, outboundProxyDestinationGuard: null } }),
    /not attested/,
  );
});
