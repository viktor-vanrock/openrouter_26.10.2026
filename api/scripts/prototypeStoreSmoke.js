/** Real replica-set/primary projection acceptance. Creates and drops only two uniquely named test databases. */
require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const { createPrototypeStoreModels } = require('@librechat/data-schemas');
const { openPrototypeStore } = require('../server/services/Prototypes/PrototypeStore');
const { PrototypeChatProjection, tombstonePrototypeConversation } = require('../server/services/Prototypes/PrototypeChatProjection');
const { createPrototypeStoreDependencies } = require('../server/services/Prototypes/PrototypeStoreService');
const { PrototypeService } = require('../server/services/Prototypes/PrototypeService');
const assert = require('node:assert/strict');
const suffix = randomUUID().replaceAll('-', '');
const scopedUri = new URL(process.env.PROTOTYPE_MONGO_URI);
scopedUri.pathname = `/prototype_store_smoke_${suffix}`;
const mainUri = new URL(process.env.MONGO_URI);
mainUri.pathname = `/prototype_projection_smoke_${suffix}`;
const primary = new mongoose.Mongoose();
let store;
const evidence = { at: new Date().toISOString(), checks: {} };
(async () => {
  try {
    await primary.connect(mainUri.toString(), { serverSelectionTimeoutMS: 2000 });
    createPrototypeStoreModels(primary);
    store = await openPrototypeStore({ env: { PROTOTYPE_MONGO_URI: scopedUri.toString(), MONGO_URI: mainUri.toString() }, primary });
    const hello = await primary.connection.db.admin().command({ hello: 1 });
    evidence.primaryStandalone = !hello.setName;
    const deps = createPrototypeStoreDependencies({ readArtifact: async () => undefined, primary });
    const user = new mongoose.Types.ObjectId().toString();
    const conversationId = `smoke_${suffix}`;
    const req = { user: { id: user }, config: { prototypeAgent: { modelPolicy: { version: 'smoke-v1' } } } };
    const service = new PrototypeService({ ...deps, createId: kind => `${kind}_${new mongoose.Types.ObjectId()}`,
      estimateCost: async () => null });
    const input = { req, conversationId, messageId: `user_${suffix}`, parentMessageId: 'root',
      text: 'Create a prototype', modelId: 'selected/model', endpoint: 'OpenRouter', idempotencyKey: 'smoke' };
    const card = await service.submitTurn(input);
    assert.equal(card.modelId, input.modelId);
    assert.equal(await store.models.PrototypeJob.countDocuments(), 1);
    assert.equal(await primary.models.Message.countDocuments(), 0);
    assert.equal(await store.models.Message.countDocuments(), 1);
    assert.equal(await store.projection.queue.countDocuments({ status: 'pending' }), 2);
    evidence.checks.atomicSubmit = true;
    await service.submitTurn(input);
    assert.equal(await store.models.PrototypeJob.countDocuments(), 1);
    assert.equal(await store.projection.queue.countDocuments(), 2);
    evidence.checks.submitReplay = true;
    const session = await store.mongoose.startSession();
    try {
      await assert.rejects(session.withTransaction(async () => {
        await deps.createPrototypeUserMessage({ messageId: 'rolled-back', user, tenantId: '__default__',
          conversationId, text: 'must roll back', isCreatedByUser: true }, session);
        throw new Error('injected rollback');
      }), /injected/);
    } finally { await session.endSession(); }
    assert.equal(await store.models.Message.countDocuments({ messageId: 'rolled-back' }), 0);
    assert.equal(await store.projection.queue.countDocuments({ 'payload.messageId': 'rolled-back' }), 0);
    evidence.checks.rollback = true;
    // Simulate crash after a primary write but before durable queue acknowledgement.
    const pending = await store.projection.queue.find({ status: 'pending' }).sort({ createdAt: 1, _id: 1 }).toArray();
    await store.projection.deliver(pending.find(item => item.kind === 'conversation'));
    const original = store.projection.queue.updateOne.bind(store.projection.queue);
    store.projection.queue.updateOne = async () => { throw new Error('injected ack loss'); };
    await assert.rejects(store.projection.deliver(pending.find(item => item.kind === 'message')), /ack loss/);
    store.projection.queue.updateOne = original;
    const restarted = new PrototypeChatProjection({ scope: store.mongoose, primary });
    await restarted.flush(); await restarted.flush();
    assert.equal(await primary.models.Message.countDocuments(), 1);
    assert.equal(await primary.models.Conversation.countDocuments(), 1);
    evidence.checks.freshProjectionAfterAckLoss = true;
    const originalMain = await primary.models.Message.findOne({ messageId: input.messageId }).lean();
    assert.equal(originalMain.text, input.text);
    assert.equal(originalMain.tenantId, '__default__');
    // Ordinary chat reply was saved in primary; copy it into the prototype transaction without cross-client sessions.
    await primary.models.Message.create({ messageId: 'reply', conversationId, user, text: 'Add phone', isCreatedByUser: true });
    const readSession = await store.mongoose.startSession();
    try {
      await readSession.withTransaction(async () => {
        const copied = await deps.getMessage({ messageId: 'reply', conversationId, user, tenantId: '__default__' }, readSession);
        assert.equal(copied.text, 'Add phone');
        assert.equal(await deps.getMessage({ messageId: 'reply', conversationId, user: new mongoose.Types.ObjectId().toString(), tenantId: '__default__' }, readSession), null);
      });
    } finally { await readSession.endSession(); }
    evidence.checks.primaryReplyAndOwnerBinding = true;
    const command = await store.models.PrototypeOutbox.findOne({ jobId: card.jobId }).lean();
    await store.methods.registerPrototypeLease({ ...command, leaseId: 'lease_smoke' });
    const generation = { schemaVersion: 1, engineId: 'direct-react-v1', sourceProfile: 'react-source-v1',
      rulesDigest: `sha256:${'a'.repeat(64)}`, templateDigest: `sha256:${'b'.repeat(64)}`, toolchainDigest: `sha256:${'c'.repeat(64)}` };
    const pin = async (values = {}) => {
      const session = await store.mongoose.startSession();
      try { return await session.withTransaction(() => store.methods.pinPrototypeGeneration({
        ...command, leaseId: 'lease_smoke', generation, ...values }, session)); }
      finally { await session.endSession(); }
    };
    await pin(); await pin();
    assert.deepEqual((await store.models.PrototypeJob.findOne({ jobId: card.jobId }).lean()).generation, generation);
    assert.deepEqual((await store.models.PrototypeTurn.findOne({ turnId: command.turnId }).lean()).generation, generation);
    await assert.rejects(pin({ generation: { ...generation, rulesDigest: `sha256:${'d'.repeat(64)}` } }), /pins cannot change/);
    await assert.rejects(pin({ modelId: 'wrong/model' }), /no longer active/);
    await assert.rejects(pin({ fenceToken: command.fenceToken + 1 }), /no longer active/);
    evidence.checks.generationPinReplayConflictAndFence = true;
    const { PrototypeEventConsumer } = require('../server/services/Prototypes/PrototypeEventConsumer');
    const { PrototypeEventApplier } = require('../server/services/Prototypes/PrototypeEventApplier');
    const applier = new PrototypeEventApplier({ finishExecution: value => store.methods.finishPrototypeExecution(value) });
    const consumer = new PrototypeEventConsumer({ startSession: () => store.mongoose.startSession(),
      claimEvent: (value, session) => store.methods.claimPrototypeWorkerEvent(value, session),
      loadJob: (event, session) => store.models.PrototypeJob.findOne({ jobId: event.jobId }, null, { session }).lean(),
      applyEvent: (event, session) => applier.apply(event, session),
      projectEvent: (value, session) => store.methods.projectPrototypeWorkerEvent(value, session),
    });
    const waiting = { eventId: `event_${suffix}`, jobId: card.jobId, turnId: command.turnId,
      commandId: command.commandId, attemptId: command.attemptId, executionId: command.executionId,
      expectedRevision: command.expectedRevision, stage: 'generation', pipelineStep: 0,
      fenceToken: command.fenceToken, leaseId: 'lease_smoke', createdAt: new Date().toISOString(),
      payload: { type: 'waiting', reason: 'plan_approval', prompt: 'Visible plan A/B',
        checkpoint: { revision: 1, digest: `sha256:${'a'.repeat(64)}` } } };
    assert.equal((await consumer.consume('1-0', waiting)).applied, true);
    assert.equal((await consumer.consume('1-0', waiting)).duplicate, true);
    await restarted.flush();
    assert.equal(await primary.models.Message.countDocuments({ messageId: waiting.eventId }), 1);
    assert.equal((await primary.models.Message.findOne({ messageId: waiting.eventId }).lean()).text, waiting.payload.prompt);
    evidence.checks.assistantEventProjectionAndReplay = true;
    await tombstonePrototypeConversation({ primary, userId: user, tenantId: '__default__', conversationId });
    await primary.models.Message.deleteMany({ conversationId });
    await primary.models.Conversation.deleteMany({ conversationId });
    await restarted.queue.updateMany({}, { $set: { status: 'pending' } });
    await restarted.flush();
    assert.equal(await primary.models.Message.countDocuments(), 0);
    assert.equal(await primary.models.Conversation.countDocuments(), 0);
    evidence.checks.deletedConversationNeverResurrected = true;
    assert.equal(primary.connection.name, mainUri.pathname.slice(1));
    evidence.checks.primaryScopeUnchanged = true;
  } finally {
    if (store) { await store.mongoose.connection.dropDatabase(); await store.stop(); }
    if (primary.connection.readyState === 1) await primary.connection.dropDatabase();
    await primary.disconnect();
    evidence.cleanup = 'own_test_databases_dropped';
    await fs.writeFile('.prototype-dev/implementation-audit/prototype-store-smoke.json', JSON.stringify(evidence, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify(evidence));
})().catch(error => { console.error(error); process.exitCode = 1; });
