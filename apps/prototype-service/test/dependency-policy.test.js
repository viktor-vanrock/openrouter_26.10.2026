import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDependencyClosure,
  createTemplateContract,
  isPublicAddress,
  resolvePublicRegistryHost,
  validateLockfilePackage,
  validateRegistryRequest,
} from '../src/dependency-policy.js';

test('rejects private, loopback, link-local, mapped IPv6, and metadata destinations', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.1',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946'), true);
});

test('requires every resolved address to be public', async () => {
  await assert.rejects(
    () =>
      resolvePublicRegistryHost('registry.example', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    /DESTINATION_DENIED/,
  );
});

test('allows only closure-bound metadata/tarballs on an allowlisted HTTPS registry', () => {
  const input = {
    method: 'GET',
    url: 'https://registry.example/v1/tarballs/react-1.tgz',
    allowlist: ['registry.example'],
    closure: [{ metadataPath: '/v1/packages/react', tarballPath: '/v1/tarballs/react-1.tgz' }],
  };
  assert.equal(validateRegistryRequest(input).pathname, '/v1/tarballs/react-1.tgz');
  assert.throws(() => validateRegistryRequest({ ...input, method: 'CONNECT' }), /METHOD_DENIED/);
  assert.throws(
    () =>
      validateRegistryRequest({
        ...input,
        url: 'https://attacker.example/v1/tarballs/react-1.tgz',
      }),
    /HOST_DENIED/,
  );
});

test('requires integrity and gateway-routed immutable lockfile resolution', () => {
  const entry = {
    version: '1.0.0',
    integrity: 'sha512-YWJjZA==',
    resolved: 'https://dependency.internal/v1/tarballs/react-1.tgz',
  };
  assert.doesNotThrow(() => validateLockfilePackage(entry, 'https://dependency.internal'));
  assert.throws(
    () =>
      validateLockfilePackage(
        { ...entry, resolved: 'https://registry.npmjs.org/react.tgz' },
        'https://dependency.internal',
      ),
    /BYPASS/,
  );
  assert.throws(
    () =>
      validateLockfilePackage(
        { ...entry, version: 'git+https://github.com/a/b' },
        'https://dependency.internal',
      ),
    /SOURCE_DENIED/,
  );
});

test('builds scoped, transitive and compatible optional closure and rewrites every tarball', () => {
  const lockfile = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@scope/app': '1.0.0' } },
      'node_modules/@scope/app': {
        version: '1.0.0',
        integrity: 'sha512-YWJjZA==',
        resolved: 'https://registry.example/@scope/app/-/app-1.0.0.tgz',
        dependencies: { child: '2.0.0' },
      },
      'node_modules/child': {
        version: '2.0.0',
        integrity: 'sha512-ZGVmZw==',
        resolved: 'https://registry.example/child/-/child-2.0.0.tgz',
      },
      'node_modules/linux-only': {
        version: '3.0.0',
        integrity: 'sha512-Z2hpamts==',
        optional: true,
        os: ['linux'],
        resolved: 'https://registry.example/linux-only/-/linux-only-3.0.0.tgz',
      },
    },
  };
  const result = buildDependencyClosure({
    lockfile,
    gatewayBaseUrl: 'http://dependency.internal',
    registryAllowlist: ['registry.example'],
    platform: { os: 'linux', arch: 'x64' },
  });
  assert.equal(result.closure.length, 3);
  assert.equal(result.closure[0].name, '@scope/app');
  assert.match(
    result.lockfile.packages['node_modules/@scope/app'].resolved,
    /^http:\/\/dependency\.internal\/v1\/tarballs\/%40scope%2Fapp/,
  );
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
});

test('rejects hostile dependency sources and non-registry resolved URLs before rewrite', () => {
  const base = {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/app': {
        version: '1.0.0',
        integrity: 'sha512-YWJjZA==',
        resolved: 'https://attacker.example/app.tgz',
      },
    },
  };
  const input = {
    lockfile: base,
    gatewayBaseUrl: 'http://dependency.internal',
    registryAllowlist: ['registry.example'],
    platform: { os: 'linux', arch: 'x64' },
  };
  assert.throws(() => buildDependencyClosure(input), /UPSTREAM_INVALID/);
  base.packages[''].dependencies = { app: 'git+https://github.com/a/b' };
  assert.throws(() => buildDependencyClosure(input), /SOURCE_DENIED/);
});

test('template digest binds manifest, lockfile, build configuration and toolchain', () => {
  const contract = createTemplateContract({
    manifest: { scripts: { build: 'vite build' } },
    lockfile: { lockfileVersion: 3, packages: { '': {} } },
    buildConfig: { output: 'dist/index.html' },
    versions: {
      templateVersion: '3',
      toolchainVersion: 'node-22',
      toolchainDigest: `sha256:${'a'.repeat(64)}`,
    },
    gatewayBaseUrl: 'http://dependency.internal',
    registryAllowlist: ['registry.example'],
    platform: { os: 'linux', arch: 'x64' },
  });
  assert.match(contract.templateDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(contract.toolchainDigest, `sha256:${'a'.repeat(64)}`);
});
