const { createHash } = require('node:crypto');
const { runAsSystem } = require('@librechat/data-schemas');
const { PrototypeServiceError } = require('./errors');

const ownerFilter = ({ user, tenantId, conversationId }) => ({ user: String(user), conversationId,
  ...(tenantId === '__default__' ? { $or: [{ tenantId }, { tenantId: { $exists: false } }, { tenantId: null }] } : { tenantId }) });
const bindingId = doc => createHash('sha256').update(JSON.stringify([String(doc.user), doc.tenantId, doc.conversationId])).digest('hex');
function clean(doc) {
  const { _id, __v, _meiliIndex, messages, ...value } = doc;
  return value;
}

/** Durable projection outbox; main Mongo never participates in prototype transactions. */
class PrototypeChatProjection {
  constructor({ scope, primary }) {
    this.scope = scope;
    this.primary = primary;
    this.queue = scope.connection.db.collection('prototypechatprojections');
    this.bindings = primary.connection.db.collection('prototypechatbindings');
  }
  async prepare() { await this.queue.createIndex({ status: 1, nextAttemptAt: 1, createdAt: 1 }); }
  async enqueue(kind, document, session) {
    const payload = clean(document);
    if (!['message', 'conversation'].includes(kind) || !payload.user || !payload.tenantId || !payload.conversationId ||
        (kind === 'message' && !payload.messageId)) throw new Error('PROTOTYPE_PROJECTION_INVALID');
    const id = `${kind}:${bindingId(payload)}:${kind === 'message' ? payload.messageId : payload.conversationId}`;
    await this.queue.updateOne({ _id: id }, { $setOnInsert: { kind, payload, status: 'pending', createdAt: new Date() } },
      { upsert: true, session });
  }
  async requireAccessible(doc) {
    const binding = await this.bindings.findOne({ _id: bindingId(doc) });
    const userDeletion = await this.bindings.findOne({ _id: `user:${bindingId({ ...doc, conversationId: '*' })}` });
    if (userDeletion?.deletedAt) {
      const copy = await this.scope.models.Conversation.findOne({ user: String(doc.user),
        tenantId: doc.tenantId, conversationId: doc.conversationId }).lean();
      if (copy?.createdAt && copy.createdAt <= userDeletion.deletedAt) {
        throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
      }
    }
    if (binding?.deletedAt || (binding?.projectedAt && !await this.primary.models.Conversation.findOne(ownerFilter(doc)).lean())) {
      throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
    }
  }
  async mirrorConversation(userId, conversationId, tenantId, session) {
    const doc = { user: String(userId), conversationId, tenantId };
    await this.requireAccessible(doc);
    const main = await this.primary.models.Conversation.findOne(ownerFilter(doc)).lean();
    if (!main) return this.scope.models.Conversation.findOne(doc, null, { session }).lean();
    const value = clean({ ...main, ...doc });
    return this.scope.models.Conversation.findOneAndUpdate(doc, { $setOnInsert: value },
      { upsert: true, new: true, runValidators: true, session, timestamps: false }).lean();
  }
  async mirrorMessage(doc, session) {
    await this.requireAccessible(doc);
    const main = await this.primary.models.Message.findOne({ ...ownerFilter(doc), messageId: doc.messageId }).lean();
    if (!main) return null;
    const payload = clean({ ...main, tenantId: doc.tenantId });
    return this.scope.models.Message.findOneAndUpdate(doc, { $setOnInsert: payload },
      { upsert: true, new: true, runValidators: true, session, timestamps: false }).lean();
  }
  async deliver(item) {
    const doc = item.payload;
    await this.requireAccessible(doc);
    const binding = bindingId(doc);
    // Tombstones survive deletion and prevent an outbox replay from resurrecting the chat.
    await this.bindings.updateOne({ _id: binding }, { $setOnInsert: { user: doc.user, tenantId: doc.tenantId,
      conversationId: doc.conversationId, createdAt: new Date() } }, { upsert: true });
    const model = item.kind === 'conversation' ? this.primary.models.Conversation : this.primary.models.Message;
    const filter = { ...ownerFilter(doc), ...(item.kind === 'message' ? { messageId: doc.messageId } : {}) };
    if (item.kind === 'message' && !await this.primary.models.Conversation.findOne(ownerFilter(doc)).lean()) {
      throw new Error('PROTOTYPE_PROJECTION_CONVERSATION_PENDING');
    }
    const existing = await model.findOne(filter).lean();
    if (existing && item.kind === 'message' && (existing.text !== doc.text ||
        existing.isCreatedByUser !== doc.isCreatedByUser || existing.conversationId !== doc.conversationId)) {
      throw new Error('PROTOTYPE_PROJECTION_MESSAGE_CONFLICT');
    }
    await model.findOneAndUpdate(filter, { $setOnInsert: doc }, { upsert: true, runValidators: true, timestamps: false });
    const after = await this.bindings.findOne({ _id: binding });
    const mainConversation = await this.primary.models.Conversation.findOne(ownerFilter(doc)).lean();
    if (after?.deletedAt || (item.kind === 'message' && !mainConversation)) {
      if (!existing) await model.deleteOne(filter);
      throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
    }
    await this.bindings.updateOne({ _id: binding, deletedAt: { $exists: false } },
      { $set: { projectedAt: new Date() } });
    await this.queue.updateOne({ _id: item._id, status: 'pending' }, { $set: { status: 'delivered', deliveredAt: new Date() } });
  }
  async flush(limit = 50) {
    return this.flushMatching({}, limit);
  }
  async flushForJob(jobId) {
    const job = await this.scope.models.PrototypeJob.findOne({ jobId }).lean();
    if (!job) return;
    return this.flushMatching({ 'payload.user': String(job.userId), 'payload.tenantId': job.tenantId,
      'payload.conversationId': job.conversationId }, 50);
  }
  async flushMatching(filter, limit) {
    return runAsSystem(async () => {
      const pending = await this.queue.find({ ...filter, status: 'pending', $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: new Date() } }] }).sort({ createdAt: 1, _id: 1 }).limit(limit).toArray();
      for (const item of pending) {
        try { await this.deliver(item); }
        catch (error) {
          if (error.code === 'PROTOTYPE_JOB_NOT_FOUND') {
            await this.queue.updateOne({ _id: item._id }, { $set: { status: 'revoked' } });
          } else {
            await this.queue.updateOne({ _id: item._id, status: 'pending' }, {
              $inc: { attempts: 1 },
              $set: { nextAttemptAt: new Date(Date.now() + 5000), errorCode: 'PROTOTYPE_PROJECTION_RETRY' },
            });
          }
        }
      }
      return { delivered: pending.length };
    });
  }
}

/** Main DB tombstone writes don't depend on the optional store. */
async function tombstonePrototypeConversation({ primary, userId, tenantId, conversationId }) {
  const doc = { user: String(userId), tenantId, conversationId };
  const database = primary.connection?.db ?? primary.db;
  if (!database) throw new Error('Primary Mongo connection is unavailable');
  await database.collection('prototypechatbindings').updateOne({ _id: bindingId(doc) },
    { $set: { ...doc, deletedAt: new Date() } }, { upsert: true });
}
async function tombstonePrototypeUserConversations({ primary, userId, tenantId }) {
  const doc = { user: String(userId), tenantId, conversationId: '*' };
  const deletedAt = new Date();
  const database = primary.connection?.db ?? primary.db;
  if (!database) throw new Error('Primary Mongo connection is unavailable');
  await database.collection('prototypechatbindings').updateOne({ _id: `user:${bindingId(doc)}` },
    { $set: { ...doc, deletedAt } }, { upsert: true });
  await database.collection('prototypechatbindings').updateMany({ user: doc.user, tenantId }, { $set: { deletedAt } });
}
module.exports = { PrototypeChatProjection, ownerFilter, bindingId, tombstonePrototypeConversation, tombstonePrototypeUserConversations };
