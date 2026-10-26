import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createGatewayOrchestratorLifecycle,
  ownedCredentialReader,
} from '../src/gateway-orchestrator-lifecycle.js';
import { createRoleServer } from '../src/server.js';
import { loadPrototypeConfig } from '../src/config.js';

const env = {
  NODE_ENV: 'production',
  PROTOTYPE_SERVICE_ROLE: 'orchestrator',
  PROTOTYPE_EXECUTION_BACKEND: 'sandbox-gateway',
  PROTOTYPE_SERVICE_AUTH_MODE: 'bearer',
  PROTOTYPE_SERVICE_TOKEN: 'a'.repeat(64),
  PROTOTYPE_CONTROL_PLANE_URL: 'https://chat.test',
  SANDBOX_GATEWAY_URL: 'https://gateway.test',
  SANDBOX_GATEWAY_TOKEN: 'test',
  OPENROUTER_API_URL: 'https://provider.test/api/v1',
  REDIS_URI: 'redis://redis.test',
  AWS_BUCKET_NAME: 'shared-files',
  AWS_REGION: 'explicit',
  PROTOTYPE_MONGO_URI: 'mongodb://prototype.test/store?replicaSet=rs',
  MONGO_URI: 'mongodb://chat.test/chat',
  CREDS_KEY: 'b'.repeat(64),
  CREDS_IV: 'c'.repeat(32),
};
async function harness({ intake = false, failure } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-worker-'));
  const events = [];
  const prototypeConnection = {
    readyState: 1,
    host: 'prototype',
    port: 27017,
    db: { databaseName: 'prototype', command: async () => ({ ok: 1 }) },
  };
  const primary = {
    readyState: 1,
    host: 'chat',
    port: 27017,
    db: { databaseName: 'chat' },
    close: async () => {
      events.push('closeChat');
    },
  };
  const runtime = {
    prepare: async () => {
      events.push('prepare');
    },
    start: async ({ signal }) => {
      events.push('consume');
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    stop: async () => {
      events.push('stopRuntime');
    },
    isReady: async () => true,
  };
  const clients = [];
  const lifecycle = createGatewayOrchestratorLifecycle({
    env,
    log: () => {},
    openPrototype: async () => ({
      scope: { connection: prototypeConnection },
      models: {},
      methods: {},
      close: async () => events.push('closePrototype'),
    }),
    openChat: async () => primary,
    redisFactory: () => {
      const client = {
        status: 'ready',
        on: () => {},
        ping: async () => {
          if (failure === 'redis') throw new Error('private-secret');
        },
        config: async (_method, name) => [
          name,
          name === 'maxmemory-policy' ? 'noeviction' : name === 'appendonly' ? 'yes' : '',
        ],
        disconnect: () => {
          client.status = 'end';
          events.push('disconnectRedis');
        },
      };
      clients.push(client);
      return client;
    },
    storageFactory: () => ({ destroy: () => events.push('closeStorage') }),
    makeClient: async () => ({ post: async () => {} }),
    checkStorage: async () => {
      events.push('storageProbe');
      if (failure === 'storage') throw new Error('private-secret');
    },
    heartbeat: () => {
      events.push('heartbeat');
      return () => events.push('stopHeartbeat');
    },
    runtimeFactory: async (options) => {
      assert.equal(options.config.kubernetesTokenPath, null);
      return {
        runtime,
        stages: { stop: () => events.push('stopStages') },
        backend: { gateway: { probe: async () => ({ api: 1 }) } },
      };
    },
  });
  const config = {
    ...loadPrototypeConfig({
      ...env,
      PROTOTYPE_WORKER_INTAKE_ENABLED: String(intake),
      PROTOTYPE_WORKSPACE_DIR: directory,
    }),
    host: '127.0.0.1',
    port: 0,
  };
  const service = createRoleServer({ config, lifecycle });
  return {
    service,
    lifecycle,
    config,
    events,
    clients,
    prototypeConnection,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}
test('production Gateway standby starts without scheduler privileges and never prepares intake/storage writes/heartbeat', async () => {
  const h = await harness();
  try {
    const address = await h.service.start(),
      base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await (await fetch(`${base}/status`)).json()).mode, 'standby');
    assert.ok(!h.events.includes('prepare'));
    assert.ok(!h.events.includes('storageProbe'));
    assert.ok(!h.events.includes('heartbeat'));
  } finally {
    await h.service.stop();
    await h.cleanup();
  }
  assert.ok(h.events.includes('closePrototype'));
  assert.ok(h.events.includes('closeChat'));
});
test('explicit production intake verifies storage, starts common runtime and independent heartbeat, loses readiness on connection loss', async () => {
  const h = await harness({ intake: true });
  try {
    const address = await h.service.start(),
      base = `http://127.0.0.1:${address.port}`;
    assert.deepEqual(h.events.slice(0, 4), ['storageProbe', 'prepare', 'heartbeat', 'consume']);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    h.clients[0].status = 'reconnecting';
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    h.clients[0].status = 'ready';
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    h.prototypeConnection.readyState = 0;
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
  } finally {
    await h.service.stop();
    await h.cleanup();
  }
  assert.ok(h.events.indexOf('stopHeartbeat') < h.events.indexOf('stopStages'));
});
test('failed startup closes acquired connections and does not expose raw dependency credentials', async () => {
  for (const failure of ['redis', 'storage']) {
    const h = await harness({ intake: true, failure });
    try {
      await assert.rejects(h.service.start(), /PROTOTYPE_GATEWAY_STARTUP_FAILED/);
      assert.ok(h.events.includes('closePrototype'));
      assert.ok(h.events.includes('closeChat'));
      assert.ok(!h.events.includes('consume'));
      assert.equal(await h.lifecycle.isReady(), false);
    } finally {
      await h.cleanup();
    }
  }
});
test('owner credential lookup cannot cross tenant, use alternate provider or resurrect expired key', async () => {
  let query,
    record = { value: 'encrypted', expiresAt: new Date(Date.now() + 10000) };
  const reader = ownedCredentialReader(
    {
      db: {
        collection: (name) => {
          assert.equal(name, 'keys');
          return {
            findOne: async (input) => {
              query = input;
              return record;
            },
          };
        },
      },
    },
    async (value) => {
      assert.equal(value, 'encrypted');
      return '{"apiKey":"fixture-only"}';
    },
  );
  assert.equal(
    (await reader({ userId: 'a'.repeat(24), tenantId: 'tenant-a', name: 'OpenRouter' })).apiKey,
    'fixture-only',
  );
  assert.equal(query.tenantId, 'tenant-a');
  assert.ok(!query.$or);
  await assert.rejects(
    reader({ userId: 'a'.repeat(24), tenantId: 'tenant-a', name: 'other' }),
    /CREDENTIAL_INVALID/,
  );
  record = { ...record, expiresAt: new Date(0) };
  await assert.rejects(
    reader({ userId: 'a'.repeat(24), tenantId: 'tenant-a', name: 'OpenRouter' }),
    /CREDENTIAL_UNAVAILABLE/,
  );
});
