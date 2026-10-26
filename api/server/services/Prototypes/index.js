const mongoose = require('mongoose');
const crypto = require('node:crypto');
const db = require('~/models');
const { PrototypeService } = require('./PrototypeService');
const { evaluateModel, listRecommendedModels } = require('./PrototypeModelPolicy');
const { PrototypeCostEstimator, classifyBalance } = require('./PrototypeCostEstimator');
const {
  createPrototypeStreamingHttpAdapter,
} = require('./PrototypeStreamingHttpAdapter');
const {
  createAdvisoryCostEstimator,
  loadCompletedPrototypeCosts,
  resolvePrototypeGatewayBaseUrl,
} = require('./PrototypeCostWiring');
const {
  createTrustedExecutionLoader,
  createPrototypeInternalRouters,
  mountPrototypeInternalRouters,
  createDurablePauseJob,
  createDurablePublicationCompletion,
} = require('./PrototypeProductionWiring');
const {
  PrototypeRedisEventSource,
  PrototypeRedisEventSourceV2,
  runPrototypeEventLoop,
} = require('./PrototypeEventStream');
const { PrototypeEventConsumer } = require('./PrototypeEventConsumer');
const { PrototypeEventApplier } = require('./PrototypeEventApplier');
const { PrototypeS3Client } = require('./PrototypeS3Client');
const {
  createPrototypeControlPlaneRouter,
} = require('../../routes/internal/prototypeControlPlane');
const {
  createPrototypeControlPlaneStartup,
  createPrototypeServiceAuthenticator,
} = require('./PrototypeControlPlaneStartup');
const {
  PrototypeOutboxPublisher,
  runPrototypeOutboxLoop,
} = require('./PrototypeOutboxPublisher');
const {
  PrototypeTransportRuntime,
  runPrototypeReconcilerLoop,
} = require('./PrototypeTransportRuntime');
const {
  PrototypeRedisCommandPublisherV2,
  assertPrototypeRedisDurability,
  createPrototypeOutboxPublisher,
  createPrototypeTransportRuntime,
  createPrototypeCleanupReconciler,
} = require('./PrototypeTransportWiring');

function createPrototypeTurn(input, session) {
  return mongoose.models.PrototypeTurn.create([input], { session }).then(([turn]) =>
    turn.toObject(),
  );
}

function findPrototypeOutbox(commandId, session) {
  return mongoose.models.PrototypeOutbox.findOne({ commandId }, null, { session }).lean();
}

function findLatestPrototypeTurn(jobId, session) {
  return mongoose.models.PrototypeTurn.findOne({ jobId }, null, { session })
    .sort({ ordinal: -1 })
    .lean();
}

function findOwnedPrototypeJobByConversation({ conversationId, userId, tenantId }, session) {
  return mongoose.models.PrototypeJob.findOne({ conversationId, userId, tenantId })
    .sort({ updatedAt: -1 })
    .session(session ?? null)
    .lean();
}

function listPrototypeEvents(jobId, after, limit) {
  return mongoose.models.PrototypeEvent.find({ jobId, eventId: { $gt: after } })
    .sort({ eventId: 1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .lean();
}

function createPrototypeUserMessage(input, session) {
  return mongoose.models.Message.findOneAndUpdate(
    { messageId: input.messageId, user: input.user, tenantId: input.tenantId },
    { $setOnInsert: input },
    { upsert: true, new: true, runValidators: true, session },
  ).lean();
}

function getPrototypeMessage({ user, tenantId, conversationId, messageId }, session) {
  return mongoose.models.Message.findOne(
    { user, tenantId, conversationId, messageId },
    null,
    { session },
  ).lean();
}

async function discardPrototypeReplyMessage({
  jobId,
  user,
  tenantId,
  conversationId,
  messageId,
  prototypeReplyToMessageId,
}) {
  const accepted = await mongoose.models.PrototypeTurn.exists({ jobId, sourceMessageId: messageId });
  if (accepted) return false;
  const deleted = await mongoose.models.Message.deleteOne({
    user,
    tenantId,
    conversationId,
    messageId,
    isCreatedByUser: true,
    'metadata.prototypeReplyToMessageId': prototypeReplyToMessageId,
  });
  return deleted.deletedCount > 0;
}

function getConversation(userId, conversationId, tenantId, session) {
  return mongoose.models.Conversation.findOne({ user: userId, conversationId, tenantId }, null, {
    session,
  }).lean();
}

function createPrototypeConversation(input, session) {
  return mongoose.models.Conversation.findOneAndUpdate(
    { conversationId: input.conversationId, user: input.user, tenantId: input.tenantId },
    { $setOnInsert: input },
    { upsert: true, new: true, runValidators: true, session },
  ).lean();
}

function allocatePrototypeEventSequence(jobId, session) {
  return mongoose.models.PrototypeJob.findOneAndUpdate(
    { jobId },
    { $inc: { eventSequence: 1 } },
    { new: true, runValidators: true, session },
  ).lean();
}

async function readPrototypeArtifact({ job, artifactId, digest, kind }, scope = mongoose) {
  const artifact = await scope.models.PrototypeArtifact.findOne({
    ...(artifactId ? { artifactId } : { sha256: digest.replace(/^sha256:/, '') }),
    jobId: job.jobId,
    tenantId: job.tenantId,
    userId: job.userId,
    kind,
  }).lean();
  if (!artifact || `sha256:${artifact.sha256}` !== digest) {
    const { PrototypeServiceError } = require('./errors');
    throw new PrototypeServiceError('PROTOTYPE_ARTIFACT_NOT_READY', 'Prototype artifact is not ready');
  }
  const bucket = artifact.storageBucket;
  if (!bucket || bucket !== process.env.AWS_BUCKET_NAME) {
    const { PrototypeServiceError } = require('./errors');
    // Root AWS changes never implicitly migrate historical objects to a different store.
    throw new PrototypeServiceError('PROTOTYPE_STORAGE_UNAVAILABLE', 'This artifact needs its original storage binding');
  }
  const { prototypeS3Config } = require('./PrototypeSharedConfig');
  const client = new PrototypeS3Client(prototypeS3Config());
  try {
    const bytes = await client.getObject({ bucket, key: artifact.objectKey });
    const actual = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    if (actual !== digest) throw new Error('Prototype artifact digest mismatch');
    return {
      bytes,
      contentType: kind === 'html' ? 'text/html; charset=utf-8' : 'application/zip',
      filename: kind === 'html' ? `prototype-${job.jobId}.html` : `prototype-${job.jobId}-sources.zip`,
      digest,
    };
  } finally {
    client.destroy();
  }
}

function estimateCost(input) {
  const config = input?.req?.config?.prototypeAgent;
  if (!config?.costDefaults || Object.keys(config.costDefaults).length === 0) return null;
  const baseUrl = resolvePrototypeGatewayBaseUrl(input?.req?.config);
  if (!baseUrl) return null;
  const pkg = require('../../../../packages/api/dist/index.js');
  const loadBalance = pkg.getOpenRouterBalanceSnapshot ?? pkg.default?.getOpenRouterBalanceSnapshot;
  if (typeof loadBalance !== 'function') return null;
  const estimator = createAdvisoryCostEstimator({
    config,
    loadCompletedCosts: loadCompletedPrototypeCosts,
    resolveCredential: async ({ userId }) => {
      const values = await db.getUserKeyValues({ userId, name: 'OpenRouter' });
      if (typeof values?.apiKey !== 'string' || values.apiKey.length === 0) {
        throw new Error('OpenRouter credential is unavailable');
      }
      return values.apiKey;
    },
    loadBalance: ({ apiKey, timeoutMs }) => loadBalance({ apiKey, timeoutMs, baseUrl }),
  });
  return estimator(input);
}

function createId(kind) {
  return `${kind}_${new mongoose.Types.ObjectId()}`;
}

function createPrototypeService(overrides = {}) {
  const legacyDependencies = {
    isAvailable: () => require('./PrototypeAvailability').prototypeAvailability.isAvailable(),
    startSession: () => mongoose.startSession(),
    createPrototypeJob: db.createPrototypeJob,
    getOwnedPrototypeJob: db.getOwnedPrototypeJob,
    transitionPrototypeJob: db.transitionPrototypeJob,
    appendPrototypeEvent: db.appendPrototypeEvent,
    claimPrototypeReply: db.claimPrototypeReply,
    claimPrototypeTurn: db.claimPrototypeTurn,
    retryFailedPrototypeJob: db.retryFailedPrototypeJob,
    enqueuePrototypeOutbox: db.enqueuePrototypeOutbox,
    createPrototypeTurn,
    findPrototypeOutbox,
    findLatestPrototypeTurn,
    findPrototypeAcceptedTurn: ({ jobId, turnId }, session) =>
      mongoose.models.PrototypeTurn.findOne({ jobId, turnId }, null, { session }).lean(),
    findOwnedPrototypeJobByConversation,
    listPrototypeEvents,
    createPrototypeUserMessage,
    getConversation,
    createPrototypeConversation,
    allocatePrototypeEventSequence,
    readPrototypeArtifact,
    getMessage: getPrototypeMessage,
    discardPrototypeReplyMessage,
    findFileById: db.findFileById,
    estimateCost,
    createId,
    ...overrides,
  };
  const legacy = new PrototypeService(legacyDependencies);
  if (!process.env.PROTOTYPE_MONGO_URI || Object.keys(overrides).length) return legacy;
  const { createPrototypeStoreDependencies } = require('./PrototypeStoreService');
  const scoped = new PrototypeService({ ...legacyDependencies, ...createPrototypeStoreDependencies({ readArtifact: readPrototypeArtifact }) });
  // Historical records retain their original repository and artifact bindings. No data migration.
  return new Proxy(scoped, { get(target, name) {
    if (typeof target[name] !== 'function') return target[name];
    return async (input) => {
      const userId = input?.req?.user?.id ?? input?.req?.user?._id;
      const tenantId = input?.req?.user?.tenantId ?? input?.req?.user?.orgId ?? '__default__';
      const conversationId = input?.conversationId ?? input?.req?.body?.conversationId;
      let historical;
      if (mongoose.models.PrototypeJob && userId && conversationId) {
        historical = await mongoose.models.PrototypeJob.findOne({ userId, tenantId, conversationId,
          ...(input.jobId ? { jobId: input.jobId } : {}) }).lean();
      }
      if (historical) return legacy[name](input);
      return target[name](input);
    };
  } });
}

module.exports = {
  PrototypeService,
  PrototypeCostEstimator,
  createPrototypeStreamingHttpAdapter,
  classifyBalance,
  createAdvisoryCostEstimator,
  resolvePrototypeGatewayBaseUrl,
  createTrustedExecutionLoader,
  createPrototypeInternalRouters,
  mountPrototypeInternalRouters,
  createDurablePauseJob,
  createDurablePublicationCompletion,
  PrototypeRedisEventSource,
  PrototypeRedisEventSourceV2,
  PrototypeEventConsumer,
  PrototypeEventApplier,
  PrototypeS3Client,
  createPrototypeControlPlaneRouter,
  createPrototypeControlPlaneStartup,
  createPrototypeServiceAuthenticator,
  runPrototypeEventLoop,
  PrototypeOutboxPublisher,
  runPrototypeOutboxLoop,
  PrototypeTransportRuntime,
  runPrototypeReconcilerLoop,
  PrototypeRedisCommandPublisherV2,
  assertPrototypeRedisDurability,
  createPrototypeOutboxPublisher,
  createPrototypeTransportRuntime,
  createPrototypeCleanupReconciler,
  createPrototypeService,
  evaluateModel,
  listRecommendedModels,
};
