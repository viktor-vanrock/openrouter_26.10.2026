const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyPrototypeDevProfile } = require('./PrototypeDevProfile');

describe('PrototypeDevProfile', () => {
  let directory, filename, profile;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-profile-'));
    filename = path.join(directory, 'runtime.json');
    profile = { pid: 12345, env: {
      MONGO_URI: `mongodb://127.0.0.1:19017/prototype_personal_${'a'.repeat(32)}?replicaSet=prototype-rs&directConnection=true`,
      CONFIG_PATH: path.join(directory, 'librechat.yaml'), REDIS_URI: 'redis://127.0.0.1:19079',
      PROTOTYPE_TEST_WORKER_IDENTITY: 'b'.repeat(64), JWT_SECRET: 'must-not-be-overridden', PORT: '9999',
    } };
    fs.writeFileSync(filename, JSON.stringify(profile), { mode: 0o600 });
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('applies only the allowed local service wiring while preserving normal ports and signing keys', () => {
    const env = { NODE_ENV: 'development', REDIS_URI: 'redis://127.0.0.1:19079', PORT: '3080', JWT_SECRET: 'existing',
      MONGO_URI: profile.env.MONGO_URI, CONFIG_PATH: '/main/librechat.yaml', HOST: 'main-host',
      AWS_ENDPOINT_URL: 'https://storage.test', AWS_BUCKET_NAME: 'shared-files',
      AWS_REGION: 'explicit-region', AWS_ACCESS_KEY_ID: 'existing-access', AWS_SECRET_ACCESS_KEY: 'existing-secret' };
    const storageBefore = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('AWS_')));
    expect(applyPrototypeDevProfile({ env, filename, isAlive: () => true })).toBe(true);
    expect(env).toMatchObject({ PORT: '3080', JWT_SECRET: 'existing', PROTOTYPE_TRANSPORT_ENABLED: 'true', HOST: 'main-host', CONFIG_PATH: '/main/librechat.yaml', MONGO_URI: profile.env.MONGO_URI });
    expect(env).toMatchObject(storageBefore);
  });
  it('rejects a stale profile that points the prototype queue at a different Redis', () => {
    expect(() => applyPrototypeDevProfile({ env: { NODE_ENV: 'development', REDIS_URI: 'redis://different.test' },
      filename, isAlive: () => true })).toThrow('Invalid local prototype runtime profile');
  });
  it.each(['production', 'test', undefined])('never loads a profile in %s', (NODE_ENV) => {
    const env = { NODE_ENV };
    expect(applyPrototypeDevProfile({ env, filename, isAlive: () => true })).toBe(false);
    expect(env.MONGO_URI).toBeUndefined();
  });
  it('ignores stopped services and explicit opt-out', () => {
    expect(applyPrototypeDevProfile({ env: { NODE_ENV: 'development', REDIS_URI: 'redis://127.0.0.1:19079' }, filename, isAlive: () => false })).toBe(false);
    expect(applyPrototypeDevProfile({ env: { NODE_ENV: 'development', REDIS_URI: 'redis://127.0.0.1:19079', PROTOTYPE_DEV_ENABLED: 'false' }, filename })).toBe(false);
  });
  it('rejects external databases and shared-readable identity files', () => {
    profile.env.MONGO_URI = 'mongodb://external.example/database';
    fs.writeFileSync(filename, JSON.stringify(profile));
    expect(() => applyPrototypeDevProfile({ env: { NODE_ENV: 'development', REDIS_URI: 'redis://127.0.0.1:19079' }, filename, isAlive: () => true })).toThrow('Invalid local');
    fs.chmodSync(filename, 0o644);
    expect(() => applyPrototypeDevProfile({ env: { NODE_ENV: 'development', REDIS_URI: 'redis://127.0.0.1:19079' }, filename })).toThrow('owner-only');
  });
});

it('does not replace the main chat database/config with a prototype-only database', () => {
  const env = { NODE_ENV: 'development', REDIS_URI: 'redis://127.0.0.1:19079', MONGO_URI: 'mongodb://main/database', CONFIG_PATH: '/main.yaml' };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-foreign-db-'));
  const filename = path.join(directory, 'runtime.json');
  fs.writeFileSync(filename, JSON.stringify({ pid: 12345, env: {
    MONGO_URI: `mongodb://127.0.0.1:19017/prototype_personal_${'a'.repeat(32)}?replicaSet=prototype-rs&directConnection=true`,
    CONFIG_PATH: path.join(directory, 'librechat.yaml'), REDIS_URI: env.REDIS_URI, PROTOTYPE_TEST_WORKER_IDENTITY: 'b'.repeat(64),
  } }), { mode: 0o600 });
  try {
    expect(applyPrototypeDevProfile({ env, filename, isAlive: () => true })).toBe(false);
    expect(env.MONGO_URI).toBe('mongodb://main/database');
    expect(env.CONFIG_PATH).toBe('/main.yaml');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it('accepts a v2 profile for the explicit separate store without changing primary DB/config/storage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prototype-separate-store-'));
  const filename = path.join(directory, 'runtime.json');
  const env = { NODE_ENV: 'development', MONGO_URI: 'mongodb://primary/LibreChat', CONFIG_PATH: '/main.yaml',
    PROTOTYPE_MONGO_URI: 'mongodb://replica/prototypes?replicaSet=rs', REDIS_URI: 'redis://shared',
    AWS_BUCKET_NAME: 'shared-files', PORT: '3080' };
  const before = { ...env };
  fs.writeFileSync(filename, JSON.stringify({ schemaVersion: 2, pid: 12345, env: {
    PROTOTYPE_MONGO_URI: env.PROTOTYPE_MONGO_URI, REDIS_URI: env.REDIS_URI,
    PROTOTYPE_TEST_WORKER_IDENTITY: 'c'.repeat(64), MONGO_URI: 'must-not-load', CONFIG_PATH: 'must-not-load',
  } }), { mode: 0o600 });
  try {
    expect(applyPrototypeDevProfile({ env, filename, isAlive: () => true })).toBe(true);
    expect(env).toMatchObject(before);
    expect(env.PROTOTYPE_TEST_WORKER_IDENTITY).toBe('c'.repeat(64));
    expect(() => applyPrototypeDevProfile({ env: { ...env, PROTOTYPE_MONGO_URI: 'mongodb://wrong/store' },
      filename, isAlive: () => true })).toThrow('Invalid local');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
