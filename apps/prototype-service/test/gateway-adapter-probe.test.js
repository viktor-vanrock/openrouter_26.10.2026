import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  approve,
  makePlan,
  storeScope,
  digest,
  preflight,
  boundedHttp,
  readPrivate,
  writePrivate,
  origin,
} from '../src/adapter-acceptance.js';
import { runSandbox, parseSse } from '../scripts/gateway-adapter-sandbox.mjs';
const pins = {
  buildFsd: {
    rulesDigest: `sha256:${'a'.repeat(64)}`,
    templateDigest: `sha256:${'b'.repeat(64)}`,
    toolchainDigest: `sha256:${'c'.repeat(64)}`,
  },
  agent: { image: `registry/image@sha256:${'d'.repeat(64)}` },
};
const metadata = {
  id: '~selected/model',
  context_length: 100000,
  top_provider: { max_completion_tokens: 4096 },
  pricing: { prompt: '0.0000001', completion: '0.0000002' },
};
const plan = () =>
  makePlan({
    apiOrigin: 'https://api.example',
    scope: storeScope('mongodb://user:secret@db.example:27017/prototype?replicaSet=rs0'),
    owner: 'a'.repeat(24),
    tenant: '__default__',
    model: metadata.id,
    conversation: 'conversation',
    message: 'message',
    pins,
    metadata,
    selectionVerified: true,
  });
const approval = (p) => ({
  planDigest: digest(p),
  operator: 'test-operator',
  actions: ['fixture', 'token', 'live', 'gateway-discovery', 'cleanup'],
  owner: p.selection.owner,
  model: p.selection.model,
  productionStoreFingerprint: p.scope.fingerprint,
  sameStoreAsProductionAdapter: true,
  agentEgressVerified: true,
  deployedCommit: 'e'.repeat(40),
  deployedImageDigest: `sha256:${'f'.repeat(64)}`,
  metadataDigest: p.metadataDigest,
  metadataVerifiedAt: new Date().toISOString(),
  maxUsd: 0.1,
  maxProviderPosts: 2,
  validUntil: new Date(Date.now() + 60000).toISOString(),
});
test('plan preserves exact tilde model, full pins and isolates conversation authority', () => {
  const p = plan();
  assert.equal(p.selection.model, '~selected/model');
  assert.equal(p.command.expectedRevision, 2);
  assert.equal(p.generation.engineId, 'opencode-fsd-v1');
  assert.equal(p.blockers.length, 0);
  assert.ok(p.quoteUsd < 0.1);
  assert.ok(!JSON.stringify(p).includes('secret'));
});
test('unconfirmed owner, store and agent cannot authorize fixture/live', () => {
  const p = makePlan({ apiOrigin: 'https://api.example', pins: { ...pins, agent: null } });
  assert.ok(p.blockers.includes('production_store_scope'));
  assert.ok(p.blockers.includes('agent_image_egress_pin'));
  assert.throws(() => approve(p, approval(plan()), 'fixture'), /APPROVAL_REQUIRED/);
});
test('scope attestation binds exact logical database and replica without credentials', () => {
  const first = storeScope('mongodb://user:password@db:27017/prototype?replicaSet=rs0');
  assert.deepEqual(first, storeScope('mongodb://another:other@db:27017/prototype?replicaSet=rs0'));
  assert.notEqual(
    first.fingerprint,
    storeScope('mongodb://db:27017/other?replicaSet=rs0').fingerprint,
  );
  assert.throws(() => storeScope('mongodb://db/admin'), /STORE_INVALID/);
  const replica = storeScope(
    'mongodb://user:password@db1:27017,db2:27017,db3:27017/prototype?replicaSet=rs0',
  );
  assert.equal(replica.database, 'prototype');
  assert.notEqual(replica.fingerprint, first.fingerprint);
});
test('production mutations fail before dispatch on stale, changed or incomplete approval', () => {
  const p = plan(),
    a = approval(p);
  approve(p, a, 'fixture');
  approve(p, a, 'live');
  for (const bad of [
    { ...a, owner: 'b'.repeat(24) },
    { ...a, model: 'fallback' },
    { ...a, sameStoreAsProductionAdapter: false },
    { ...a, validUntil: '2020-01-01' },
    { ...a, actions: [] },
    { ...a, planDigest: 'changed' },
  ]) {
    assert.throws(() => approve(p, bad, 'fixture'), /APPROVAL_REQUIRED/);
  }
  assert.throws(() => approve(p, { ...a, maxUsd: 1 }, 'live'), /COST_APPROVAL_REQUIRED/);
  assert.throws(
    () => approve(p, { ...a, metadataVerifiedAt: '2020-01-01' }, 'live'),
    /CURRENT_PRICE_EVIDENCE_REQUIRED/,
  );
  assert.throws(
    () => approve(p, { ...a, metadataDigest: 'changed' }, 'live'),
    /CURRENT_PRICE_EVIDENCE_REQUIRED/,
  );
});
test('conservative quote never accepts unsupported or overpriced selected model', () => {
  const p = makePlan({
    ...{ apiOrigin: 'https://api.example', pins, model: metadata.id },
    metadata: { ...metadata, pricing: { prompt: '1', completion: '1' } },
  });
  assert.ok(p.blockers.includes('quote_exceeds_ceiling'));
  assert.throws(() => origin('https://user:password@api.example'), /ORIGIN_INVALID/);
  assert.throws(() => origin('http://api.example'), /ORIGIN_INVALID/);
});
test('read-only preflight sends only empty auth bodies, no model POST and emits no secrets', async () => {
  const calls = [],
    secret = 'actual-service-secret';
  const result = await preflight({
    apiOrigin: 'https://api.example',
    serviceToken: secret,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      assert.ok(!url.includes(secret));
      const status = url.endsWith('/api/config')
        ? 200
        : url.includes('/internal/') && !url.includes('/api/')
          ? 404
          : init.headers.Authorization === `Bearer ${secret}`
            ? 422
            : 401;
      return new Response(JSON.stringify({ token: secret }), { status });
    },
  });
  assert.ok(calls.every((c) => c.init.method === 'GET' || c.init.body === '{}'));
  assert.ok(calls.every((c) => !c.url.includes('chat/completions')));
  assert.equal(result.productionStoreWrites, 0);
  assert.equal(result.paidProviderPosts, 0);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(Object.values(result.checks).every((v) => v.result === 'PASS'));
});
test('ambiguous auth transport has one dispatch per check, redirect denied and bounded response', async () => {
  let count = 0;
  await assert.rejects(
    boundedHttp('https://api.example', {}, async () => {
      count++;
      throw new Error('contains-secret');
    }),
  );
  assert.equal(count, 1);
  await assert.rejects(
    boundedHttp('https://api.example', {}, async () => new Response('x'.repeat(300000))),
    /RESPONSE_LIMIT/,
  );
});
test('private manifests reject world-readable and symlink files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-acceptance-'));
  try {
    const file = path.join(dir, 'plan.json');
    await writePrivate(file, { hello: true }, true);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readPrivate(file), { hello: true });
    await fs.symlink(file, path.join(dir, 'link'));
    await assert.rejects(readPrivate(path.join(dir, 'link')));
    await fs.chmod(file, 0o644);
    await assert.rejects(readPrivate(file), /PRIVATE_FILE_REQUIRED/);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});
function sse(events) {
  const wire = events
    .map((v) => `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\r\n\r\n`)
    .join('');
  const bytes = new TextEncoder().encode(wire);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const usage = { prompt_tokens: 50, completion_tokens: 10, cost: 0.00001 };
test('fragmented UTF-8 SSE assembles actual tool arguments and rejects missing usage/DONE', async () => {
  const value = await parseSse(
    sse([
      {
        choices: [
          {
            delta: {
              content: 'Русский',
              tool_calls: [
                { index: 0, id: 'call1', function: { name: 'read_', arguments: '{"path":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'fixture', arguments: '"src/fixture.ts"}' } },
              ],
            },
          },
        ],
      },
      { choices: [], usage },
      '[DONE]',
    ]),
  );
  assert.equal(value.text, 'Русский');
  assert.equal(value.tools[0].function.name, 'read_fixture');
  assert.equal(JSON.parse(value.tools[0].function.arguments).path, 'src/fixture.ts');
  await assert.rejects(parseSse(sse([{ choices: [] }, '[DONE]'])), /USAGE_OR_DONE/);
  await assert.rejects(parseSse(sse([{ usage }])), /USAGE_OR_DONE/);
});
test('discovery-only sandbox never invokes paid endpoint or reads fixture', async () => {
  const calls = [];
  const result = await runSandbox({
    input: {
      baseUrl: 'https://api.example/api/prototype-model/v1',
      model: metadata.id,
      mode: 'gateway-discovery',
    },
    credential: 'scoped-only',
    save: async () => {},
    readFixture: () => assert.fail(),
    fetchImpl: async (url, init) => {
      calls.push(url);
      assert.equal(init.headers.Authorization, 'Bearer scoped-only');
      return Response.json({ data: [{ id: metadata.id }] });
    },
  });
  assert.equal(result.providerPostAttempts, 0);
  assert.equal(calls.length, 1);
});
test('live invokes real tool event and next result in same turn with new stable ID and renewed scoped token', async () => {
  const saved = [],
    dispatched = [];
  let reads = 0;
  const result = await runSandbox({
    input: {
      baseUrl: 'https://api.example/api/prototype-model/v1',
      model: metadata.id,
      mode: 'live',
      quoteUsd: 0.01,
      requestIds: ['request1', 'request2'],
      renewCredential: async () => 'renewed-scoped',
    },
    credential: 'scoped-only',
    save: async (value) => saved.push(structuredClone(value)),
    readFixture: async () => {
      reads++;
      return 'export const fixtureValue = 42;';
    },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: metadata.id }] });
      const body = JSON.parse(init.body);
      dispatched.push({ body, init });
      if (dispatched.length > 2) {
        dispatched.pop();
        return new Response('{}', { status: body.model === metadata.id ? 409 : 422 });
      }
      assert.equal(saved.at(-1).requests.at(-1).outcome, 'dispatch_intent');
      assert.equal(init.redirect, 'error');
      if (dispatched.length === 1)
        return sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call1',
                      type: 'function',
                      function: { name: 'read_fixture', arguments: '{"path":"src/fixture.ts"}' },
                    },
                  ],
                },
              },
            ],
          },
          { usage },
          '[DONE]',
        ]);
      assert.equal(init.headers.Authorization, 'Bearer renewed-scoped');
      assert.equal(body.messages.at(-1).tool_call_id, 'call1');
      assert.equal(body.messages.at(-1).role, 'tool');
      return sse([{ choices: [{ delta: { content: 'Exports value 42.' } }] }, { usage }, '[DONE]']);
    },
  });
  assert.equal(reads, 1);
  assert.equal(dispatched.length, 2);
  assert.equal(result.usableResult, true);
  assert.notEqual(
    dispatched[0].init.headers['X-Prototype-Request-Id'],
    dispatched[1].init.headers['X-Prototype-Request-Id'],
  );
  assert.ok(!JSON.stringify(saved).includes('scoped-only'));
});
test('ambiguous live POST persists unknown outcome and never retries or executes invented tool', async () => {
  let posts = 0,
    last;
  await assert.rejects(
    runSandbox({
      input: {
        baseUrl: 'https://api.example/api/prototype-model/v1',
        model: metadata.id,
        mode: 'live',
        quoteUsd: 0.01,
        requestIds: ['stable', 'next'],
      },
      credential: 'scoped',
      save: async (v) => {
        last = structuredClone(v);
      },
      readFixture: () => assert.fail('must not fabricate a tool call'),
      fetchImpl: async (url) => {
        if (url.endsWith('/models')) return Response.json({ data: [{ id: metadata.id }] });
        posts++;
        throw new Error('ambiguous secret');
      },
    }),
    /MODEL_OUTCOME_UNKNOWN/,
  );
  assert.equal(posts, 1);
  assert.equal(last.requests[0].outcome, 'unknown');
  assert.equal(last.requests[0].requestId, 'stable');
});
test('cleanup preserves unknown create and DELETE acknowledgement debt, never touches foreign IDs', async () => {
  const { cleanupGateway } = await import('../scripts/gateway-adapter-probe.mjs');
  const p = plan();
  let record = { ...p.command, runId: p.runId, image: p.image, ledgerRevision: 0 },
    calls = 0,
    updated;
  const store = {
    models: { PrototypeGatewayExecution: { findOne: () => ({ lean: async () => record }) } },
  };
  const deps = {
    gateway: {
      request: async () => {
        calls++;
      },
    },
    ledger: {
      update: async (_c, _r, changes, options) => {
        updated = { changes, options };
      },
    },
  };
  let result = await cleanupGateway(store, {}, p, deps);
  assert.equal(calls, 0);
  assert.equal(result.cleanup, 'create_outcome_unknown');
  record = { ...record, sandboxId: 'owned', sessionId: 'session' };
  result = await cleanupGateway(store, {}, p, deps);
  assert.equal(calls, 2);
  assert.equal(result.cleanup, 'delete_acknowledged');
  assert.equal(result.stopEvidence, 'stop_unknown');
  assert.equal(result.result, 'BLOCKED_BY_ENVIRONMENT');
  assert.equal(updated.options.requireActive, false);
  record = { ...record, userId: 'foreign' };
  await assert.rejects(cleanupGateway(store, {}, p, deps), /OWN_GATEWAY/);
  assert.equal(calls, 2);
});
test(
  'own fixture uses real schemas/transaction/CAS, rejects foreign cleanup and retains canceled records',
  { skip: process.env.PROTOTYPE_ACCEPTANCE_LOCAL_TEST !== '1' },
  async () => {
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ quiet: true });
    const { default: mongoose } = await import('mongoose');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { createPrototypeStoreModels } = require('@librechat/data-schemas');
    const { fixture, assertOwn, cancel } = await import('../scripts/gateway-adapter-probe.mjs');
    const { randomBytes } = await import('node:crypto');
    const uri = new URL(process.env.PROTOTYPE_MONGO_URI);
    assert.ok(
      uri.protocol === 'mongodb:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname) &&
        uri.searchParams.has('replicaSet'),
    );
    uri.pathname = `/adapter_acceptance_test_${randomBytes(12).toString('hex')}`;
    const store = new mongoose.Mongoose(),
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adapter-fixture-'));
    try {
      await store.connect(uri.toString(), { serverSelectionTimeoutMS: 2000 });
      const models = createPrototypeStoreModels(store);
      await Promise.all(Object.values(models).map((m) => m.init()));
      const p = plan();
      await fixture(store, p, dir);
      const job = await assertOwn(store, p);
      assert.equal(job.revision, 2);
      assert.equal(job.status, 'running');
      assert.equal(job.generation.engineId, 'opencode-fsd-v1');
      assert.notEqual(job.conversationId, p.selection.conversation);
      assert.equal(await models.PrototypeOutbox.countDocuments(), 0);
      const {
        PrototypeModelAuthority,
      } = require('../../../api/server/services/Prototypes/PrototypeModelAuthority');
      const authority = new PrototypeModelAuthority({ mongoose: store });
      const active = await authority.renew(p.command);
      assert.equal(active.userId, p.selection.owner);
      assert.equal(active.modelId, p.selection.model);
      assert.equal(active.revision, 2);
      assert.ok(await authority.active(active));
      await assert.rejects(
        cancel(store, { ...p, command: { ...p.command, userId: 'b'.repeat(24) } }),
        /OWN_AUTHORITY/,
      );
      await cancel(store, p);
      await cancel(store, p);
      assert.equal(await authority.active(active), null);
      await assert.rejects(authority.renew(p.command), /AUTHORITY_REVOKED/);
      const revoked = await models.PrototypeJob.findOne({ jobId: p.command.jobId }).lean();
      assert.equal(revoked.status, 'canceled');
      assert.equal(revoked.fenceToken, 2);
      assert.ok(revoked.accessRevokedAt);
      assert.equal(
        (await models.PrototypeTurn.findOne({ turnId: p.command.turnId }).lean()).status,
        'canceled',
      );
      await assert.rejects(assertOwn(store, p), /OWN_AUTHORITY/);
    } finally {
      if (store.connection.readyState === 1) await store.connection.dropDatabase();
      await store.disconnect();
      await fs.rm(dir, { recursive: true });
    }
  },
);
