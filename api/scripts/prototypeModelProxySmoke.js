/** Real replica + scoped JWT + HTTP streaming. Unique test DB and fake provider; no provider billing. */
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const OpenAI = require('openai');
const { createPrototypeStoreModels } = require('@librechat/data-schemas');
const { createPrototypeModelProxyStartup } = require('../server/services/Prototypes/PrototypeModelProxyStartup');
const { PrototypeModelAuthority } = require('../server/services/Prototypes/PrototypeModelAuthority');
const { createPrototypeServiceAuthenticator } = require('../server/services/Prototypes/PrototypeControlPlaneStartup');

async function listen(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
const close = async server => { if (!server) return; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
(async () => {
  const scope = new mongoose.Mongoose();
  const uri = new URL(process.env.PROTOTYPE_MONGO_URI);
  // This runner drops its own DB. Never allow a production/remote authority URI.
  assert.ok(uri.protocol === 'mongodb:' && ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname) &&
    !uri.host.includes(',') && uri.searchParams.has('replicaSet'), 'LOCAL_REPLICA_URI_REQUIRED');
  uri.pathname = `/prototype_model_proxy_smoke_${crypto.randomUUID().replaceAll('-', '')}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-proxy-smoke-'));
  let upstream, api, runtime;
  const checks = {};
  let providerRequests = 0, metadataRequests = 0;
  try {
    await scope.connect(uri.toString(), { serverSelectionTimeoutMS: 2000 });
    createPrototypeStoreModels(scope);
    const userId = new mongoose.Types.ObjectId().toString();
    const identity = { jobId: 'job_smoke', turnId: 'turn_smoke', commandId: 'cmd_smoke', attemptId: 'attempt_smoke',
      executionId: 'execution_smoke', leaseId: 'lease_smoke', stage: 'generation', fenceToken: 3 };
    const job = { jobId: identity.jobId, tenantId: '__default__', userId: new mongoose.Types.ObjectId(userId),
      modelId: 'selected/model', status: 'running', revision: 4, fenceToken: identity.fenceToken,
      generation: { engineId: 'opencode-fsd-v1' },
      activeTurnId: identity.turnId, activeCommandId: identity.commandId, activeAttemptId: identity.attemptId,
      activeExecutionId: identity.executionId, activeLeaseId: identity.leaseId, activeStage: 'generation', accessRevokedAt: null };
    await scope.models.PrototypeJob.collection.insertOne(job);
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPath = path.join(dir, 'signing.pem');
    await fs.writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    let stalledResponse;
    const fake = express(); fake.use(express.json({ limit: '2mb' }));
    fake.get('/v1/models', (req, res) => {
      metadataRequests++;
      assert.equal(req.get('Authorization'), 'Bearer private-test-provider-key');
      res.json({ data: [{ id: job.modelId, context_length: 200000,
        top_provider: { max_completion_tokens: 16384 }, pricing: { prompt: '0.0000001', completion: '0.0000002' } }] });
    });
    fake.post('/v1/chat/completions', (req, res) => {
      providerRequests++;
      assert.equal(req.get('Authorization'), 'Bearer private-test-provider-key');
      assert.equal(req.body.model, job.modelId);
      res.set('Content-Type', 'text/event-stream');
      if (req.body.messages[0].content === 'stall') { stalledResponse = res; res.flushHeaders(); return; }
      const wire = Buffer.from('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tool1","type":"function","function":{"name":"read_source","arguments":"{}"}}]}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":10,"cost":0.00001}}\n\ndata: [DONE]\n\n');
      res.write(wire.subarray(0, 29)); res.end(wire.subarray(29));
    });
    upstream = await listen(fake);
    const env = { NODE_ENV: 'production', PROTOTYPE_SERVICE_AUTH_MODE: 'bearer',
      PROTOTYPE_SERVICE_TOKEN: 'a'.repeat(64),
      PROTOTYPE_MODEL_PROXY_ENABLED: 'true', OPENROUTER_API_URL: 'https://fixed-provider.example/v1',
      PROTOTYPE_MODEL_TOKEN_PRIVATE_KEY_PATH: keyPath };
    runtime = await createPrototypeModelProxyStartup({ mongoose: scope, env,
      authenticateService: createPrototypeServiceAuthenticator({ env }),
      getUserKeyValues: async input => {
        assert.equal(input.userId, userId); return { apiKey: 'private-test-provider-key' };
      }, fetchImpl: (url, options) => fetch(`${upstream.origin}${new URL(url).pathname}`, options) });
    const app = express(); app.use(express.json({ limit: '3mb' }));
    // Loopback-only trusted ingress emulation; no production forwarding changes.
    app.set('trust proxy', 1);
    app.use('/api/internal/prototype-tokens', runtime.tokenRouter);
    app.use('/api/prototype-model/v1', runtime.modelRouter);
    api = await listen(app);
    const refresh = (input = identity, authenticated = true, secure = true) => fetch(`${api.origin}/api/internal/prototype-tokens/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(secure ? { 'X-Forwarded-Proto': 'https' } : {}),
        ...(authenticated ? { Authorization: `Bearer ${env.PROTOTYPE_SERVICE_TOKEN}` } : {}) },
      body: JSON.stringify(input) });
    assert.equal((await refresh({}, false)).status, 401);
    assert.equal((await refresh({}, true, false)).status, 401);
    assert.equal((await refresh({})).status, 422);
    assert.equal((await fetch(`${api.origin}/internal/prototype-tokens/refresh`, { method: 'POST' })).status, 404);
    checks.productionBearerAliasesAuthBeforeValidation = true;
    assert.equal((await refresh(identity, false)).status, 401);
    assert.equal((await refresh({ ...identity, executionId: 'foreign' })).status, 409);
    checks.serviceIdentityAndTuple = true;
    let reply = await refresh(); assert.equal(reply.status, 200);
    const initial = await reply.json();
    assert.ok(Date.parse(initial.expiresAt) <= Date.now() + 45000);
    const token = initial.token;
    assert.equal((await runtime.tokenService.verify(token)).userId, userId);
    const models = await fetch(`${api.origin}/api/prototype-model/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await models.json()).data[0].id, job.modelId);
    assert.equal(metadataRequests, 0); checks.scopedDiscoveryAndTokenExpiry = true;
    const request = (id, patch = {}, bearer = token) => fetch(`${api.origin}/api/prototype-model/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'X-Prototype-Request-Id': id },
      body: JSON.stringify({ model: job.modelId, stream: true, max_tokens: 4096,
        messages: [{ role: 'user', content: 'text' }], tools: [{ type: 'function', function: { name: 'read_source',
          parameters: { type: 'object', properties: { path: { type: 'string' } } } } }], ...patch }) });
    const sdk = new OpenAI({ apiKey: token, baseURL: `${api.origin}/api/prototype-model/v1`, maxRetries: 0 });
    const streamed = await sdk.chat.completions.create({ model: job.modelId, stream: true, max_tokens: 4096,
      messages: [{ role: 'user', content: 'text' }], tools: [{ type: 'function', function: { name: 'read_source',
        parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] },
    { headers: { 'X-Prototype-Request-Id': 'first' } });
    const chunks = []; for await (const chunk of streamed) chunks.push(chunk);
    assert.ok(chunks[0].choices[0].delta.tool_calls);
    assert.equal(chunks.at(-1).usage.cost, 0.00001);
    assert.ok(!JSON.stringify(chunks).includes('private-test-provider-key'));
    checks.openAiSdkStreaming = true;
    let receipt = await scope.connection.db.collection('prototypeagentrequests').findOne({ requestId: 'first' });
    assert.equal(receipt.status, 'settled'); assert.equal(receipt.actualMicros, 10);
    assert.equal((await request('first')).status, 409); assert.equal(providerRequests, 1);
    assert.equal((await request('first', { messages: [{ role: 'user', content: 'changed' }] })).status, 409);
    assert.equal(providerRequests, 1);
    assert.equal((await request('different', { model: 'another/model' })).status, 422);
    await (await request('tool-followup', { messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'tool1',
      type: 'function', function: { name: 'read_source', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'tool1', content: 'result' }] })).text();
    assert.equal(providerRequests, 2); checks.streamingToolsUsageReplayAndModel = true;
    const leaseBefore = await runtime.authority.active(await runtime.tokenService.verify(token));
    await refresh();
    const leaseAfter = await runtime.authority.active(await runtime.tokenService.verify(token));
    assert.ok(leaseAfter.leaseExpiresAt >= leaseBefore.leaseExpiresAt);
    checks.durableRenewal = true;
    const stalled = await request('stall', { messages: [{ role: 'user', content: 'stall' }] });
    const drain = stalled.text();
    await scope.models.PrototypeJob.collection.updateOne({ jobId: job.jobId }, { $inc: { fenceToken: 1 }, $set: { status: 'canceled' } });
    await assert.rejects(drain);
    assert.equal(stalledResponse.destroyed, true);
    assert.equal((await request('after-cancel')).status, 401);
    assert.equal((await refresh()).status, 409);
    receipt = await scope.connection.db.collection('prototypeagentrequests').findOne({ requestId: 'stall' });
    assert.equal(receipt.status, 'unknown'); assert.ok(receipt.reservedMicros > 0);
    assert.equal(providerRequests, 3); checks.cancelAbortsRunningStreamAndRetainsUnknown = true;
    // Old signed identity cannot be repurposed even if the live tuple is otherwise restored.
    await scope.models.PrototypeJob.collection.updateOne({ jobId: job.jobId }, { $set: { ...job,
      userId: new mongoose.Types.ObjectId(), _id: job._id } });
    await assert.rejects(runtime.tokenService.verify(token)); checks.ownerRevocation = true;
    await scope.models.PrototypeJob.collection.updateOne({ jobId: job.jobId }, { $set: job });
    const expired = new PrototypeModelAuthority({ mongoose: scope, now: () => Date.now() + 600001 });
    await assert.rejects(expired.renew(identity));
    checks.renewalCannotExtendPersistedDeadline = true;
    const evidence = { at: new Date().toISOString(), checks, fakeProviderRequests: providerRequests, paidProviderRequests: 0,
      scope: 'real replica-set, real scoped JWT, local HTTP provider transport; no remote OpenCode' };
    const evidenceDir = path.resolve(`.prototype-dev/adapter-model-proxy-smoke-${crypto.randomUUID()}`);
    await fs.mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const output = path.join(evidenceDir, 'receipt.json');
    await fs.writeFile(output, JSON.stringify(evidence, null, 2));
    await fs.chmod(output, 0o600);
    console.log(JSON.stringify({ ...evidence, evidenceFile: output }));
  } finally {
    runtime?.close(); await close(api?.server); await close(upstream?.server);
    if (scope.connection.readyState === 1) await scope.connection.dropDatabase();
    await scope.disconnect(); await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
