import assert from 'node:assert/strict';
import test from 'node:test';
import { DependencyGatewayRuntime } from '../src/dependency-gateway-runtime.js';

const entry = {
  name: 'app',
  version: '1.0.0',
  integrity: 'sha512-YWJjZA==',
  metadataPath: '/v1/packages/app',
  tarballPath: '/v1/tarballs/app/1.0.0.tgz',
  metadataUrl: 'https://registry.example/app',
  tarballUrl: 'https://registry.example/app/-/app-1.0.0.tgz',
};
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

async function invoke(runtime, method, url) {
  let status;
  let body;
  const res = {
    writeHead(value) {
      status = value;
    },
    end(value) {
      body = value;
    },
  };
  await runtime.handleRequest({ method, url }, res);
  return { status, body };
}

test('cold-cache metadata and tarball requests traverse the injected proxy transport', async () => {
  const counts = { metadata: 0, tarball: 0 };
  const transport = async (target) => {
    counts[target.pathname.endsWith('.tgz') ? 'tarball' : 'metadata'] += 1;
    const body = target.pathname.endsWith('.tgz')
      ? Buffer.from(target.pathname)
      : Buffer.from(
          JSON.stringify({
            versions: {
              '1.0.0': {
                name: 'app',
                version: '1.0.0',
                dist: {
                  integrity: 'sha512-YWJjZA==',
                  tarball: 'https://registry.example/app/-/app-1.0.0.tgz',
                },
              },
            },
          }),
        );
    return { statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, body };
  };
  const runtime = new DependencyGatewayRuntime({
    allowlist: ['registry.example'],
    closure: [entry],
    lookup,
    transport,
  });
  await runtime.start();
  try {
    const metadata = await invoke(runtime, 'GET', entry.metadataPath);
    assert.equal(metadata.status, 200);
    assert.equal(
      JSON.parse(metadata.body).versions['1.0.0'].dist.tarball,
      'http://dependency.internal/v1/tarballs/app/1.0.0.tgz',
    );
    assert.equal((await invoke(runtime, 'GET', entry.tarballPath)).status, 200);
    assert.deepEqual(counts, { metadata: 1, tarball: 1 });
    assert.equal((await invoke(runtime, 'GET', '/-/npm/v1/tokens')).status, 404);
    assert.equal((await invoke(runtime, 'POST', entry.tarballPath)).status, 405);
  } finally {
    await runtime.stop();
  }
});

test('proxy-down fails closed without a direct registry fallback', async () => {
  let calls = 0;
  const runtime = new DependencyGatewayRuntime({
    allowlist: ['registry.example'],
    closure: [entry],
    lookup,
    transport: async () => {
      calls += 1;
      throw new Error('proxy unavailable');
    },
  });
  await runtime.start();
  try {
    const response = await invoke(runtime, 'GET', entry.tarballPath);
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
  } finally {
    await runtime.stop();
  }
});

test('every redirect is revalidated and private or mapped IPv6 rebinding is rejected', async () => {
  let dnsCalls = 0;
  const runtime = new DependencyGatewayRuntime({
    allowlist: ['registry.example'],
    closure: [entry],
    lookup: async () => [
      { address: ++dnsCalls === 1 ? '93.184.216.34' : '::ffff:127.0.0.1', family: 6 },
    ],
    transport: async () => ({
      statusCode: 302,
      headers: { location: 'https://registry.example/redirected.tgz' },
      body: Buffer.alloc(0),
    }),
  });
  await runtime.start();
  await assert.rejects(
    () => runtime.fetch(entry, 'tarball', 'GET'),
    /CLOSURE_DENIED|DESTINATION_DENIED/,
  );
  await runtime.stop();
});
