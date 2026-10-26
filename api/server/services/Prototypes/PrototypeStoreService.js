const { getPrototypeStore } = require('./PrototypeStore');
const { PrototypeServiceError } = require('./errors');

/** Resolve only prototype dependencies from the isolated connection; auth/files stay in primary. */
function createPrototypeStoreDependencies({ readArtifact, primary = require('mongoose') }) {
  const store = getPrototypeStore;
  const model = name => store().models[name];
  const invoke = name => (...args) => store().methods[name](...args);
  const methods = ['createPrototypeJob', 'getOwnedPrototypeJob', 'transitionPrototypeJob', 'appendPrototypeEvent',
    'claimPrototypeReply', 'claimPrototypeTurn', 'retryFailedPrototypeJob', 'enqueuePrototypeOutbox'];
  return {
    ...Object.fromEntries(methods.map(name => [name, invoke(name)])),
    getOwnedPrototypeJob: async (input) => {
      const job = await store().methods.getOwnedPrototypeJob(input);
      if (job) await store().projection.requireAccessible({ user: String(job.userId),
        tenantId: job.tenantId, conversationId: job.conversationId });
      return job;
    },
    startSession: () => store().mongoose.startSession(),
    createPrototypeTurn: (input, session) => model('PrototypeTurn').create([input], { session }).then(([turn]) => turn.toObject()),
    findPrototypeOutbox: (commandId, session) => model('PrototypeOutbox').findOne({ commandId }, null, { session }).lean(),
    findLatestPrototypeTurn: (jobId, session) => model('PrototypeTurn').findOne({ jobId }, null, { session }).sort({ ordinal: -1 }).lean(),
    findPrototypeAcceptedTurn: (input, session) => model('PrototypeTurn').findOne(input, null, { session }).lean(),
    findOwnedPrototypeJobByConversation: async ({ conversationId, userId, tenantId }, session) => {
      await store().projection.requireAccessible({ conversationId, user: String(userId), tenantId });
      return model('PrototypeJob').findOne({ conversationId, userId, tenantId }, null, { session }).sort({ updatedAt: -1 }).lean();
    },
    listPrototypeEvents: async (jobId, after, limit) => {
      // Deliver committed message projections before the SSE state invalidates the UI message query.
      await store().projection.flushForJob(jobId);
      return model('PrototypeEvent').find({ jobId, eventId: { $gt: after } })
        .sort({ eventId: 1 }).limit(Math.min(Math.max(limit, 1), 100)).lean();
    },
    createPrototypeUserMessage: async (input, session) => {
      const message = await model('Message').findOneAndUpdate({ messageId: input.messageId, user: input.user,
        tenantId: input.tenantId, conversationId: input.conversationId }, { $setOnInsert: input },
      { upsert: true, new: true, runValidators: true, session }).lean();
      if (message.text !== input.text) throw new PrototypeServiceError('PROTOTYPE_INVALID_REQUEST', 'Message ID already has different content');
      await store().projection.enqueue('message', message, session);
      return message;
    },
    getMessage: (input, session) => store().projection.mirrorMessage(input, session),
    getConversation: (userId, conversationId, tenantId, session) =>
      store().projection.mirrorConversation(userId, conversationId, tenantId, session),
    createPrototypeConversation: async (input, session) => {
      await store().projection.requireAccessible(input);
      const conversation = await model('Conversation').findOneAndUpdate({ conversationId: input.conversationId,
        user: input.user, tenantId: input.tenantId }, { $setOnInsert: input },
      { upsert: true, new: true, runValidators: true, session }).lean();
      await store().projection.enqueue('conversation', conversation, session);
      return conversation;
    },
    allocatePrototypeEventSequence: (jobId, session) => model('PrototypeJob').findOneAndUpdate({ jobId },
      { $inc: { eventSequence: 1 } }, { new: true, runValidators: true, session }).lean(),
    readPrototypeArtifact: input => readArtifact(input, store().mongoose),
    discardPrototypeReplyMessage: async ({ jobId, ...input }) => {
      if (await model('PrototypeTurn').exists({ jobId, sourceMessageId: input.messageId })) return false;
      const { prototypeReplyToMessageId, ...owner } = input;
      const deleted = await primary.models.Message.deleteOne({ ...owner, isCreatedByUser: true,
        'metadata.prototypeReplyToMessageId': prototypeReplyToMessageId });
      return deleted.deletedCount > 0;
    },
  };
}
module.exports = { createPrototypeStoreDependencies };
