import mongoose, { Types } from 'mongoose';
import { createModels } from '~/models';
import { createPrototypeMethods, type CreatePrototypeJobInput } from './prototype';

const integrationDescribe = process.env.PROTOTYPE_MONGO_REPLSET_TEST === '1'
  ? describe
  : describe.skip;

integrationDescribe('prototype transactional worker-event acceptance', () => {
  let models: ReturnType<typeof createModels>;
  let methods: ReturnType<typeof createPrototypeMethods>;

  const job = (): CreatePrototypeJobInput => ({
    jobId: `job_${new Types.ObjectId()}`,
    userId: new Types.ObjectId(),
    tenantId: 'tenant_replset',
    conversationId: `conversation_${new Types.ObjectId()}`,
    originMessageId: `message_${new Types.ObjectId()}`,
    originToolCallId: `tool_${new Types.ObjectId()}`,
    status: 'running',
    waitingReason: null,
    phase: null,
    modelId: 'fake/model',
    modelPolicyVersion: 'test',
    modelRecommendation: 'recommended',
    revision: 1,
    fenceToken: 2,
    activeCommandId: 'command_1',
    activeTurnId: 'turn_1',
    activeAttemptId: 'attempt_1',
    activeExecutionId: 'execution_1',
    activeLeaseId: 'lease_1',
    activeStage: 'generation',
    checkpointRevision: null,
    checkpointDigest: null,
    latestPromptMessageId: null,
    previewArtifactId: null,
    previewDigest: null,
    sourcesArtifactId: null,
    sourcesDigest: null,
    qaArtifactId: null,
    templateDigest: null,
    toolchainDigest: null,
    estimatedCost: null,
    actualCostUsd: 0,
    failure: null,
    completedAt: null,
  });

  const identity = (jobId: string) => ({
    jobId, turnId: 'turn_1', commandId: 'command_1', expectedRevision: 1,
    attemptId: 'attempt_1', executionId: 'execution_1', stage: 'generation' as const,
    fenceToken: 2, leaseId: 'lease_1',
  });

  beforeAll(async () => {
    const uri = process.env.PROTOTYPE_MONGO_REPLSET_URI;
    if (!uri) throw new Error('PROTOTYPE_MONGO_REPLSET_URI is required');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
    models = createModels(mongoose);
    methods = createPrototypeMethods(mongoose);
    await Promise.all([
      models.PrototypeJob.syncIndexes(),
      models.PrototypeWorkerEventReceipt.syncIndexes(),
    ]);
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([
      models.PrototypeJob.deleteMany({}),
      models.PrototypeWorkerEventReceipt.deleteMany({}),
    ]);
  });

  it('commits receipt and effect once across duplicate delivery', async () => {
    const input = job();
    await models.PrototypeJob.create(input);
    const receipt = {
      eventId: 'event_once', jobId: input.jobId, commandId: 'command_1', payloadType: 'usage',
      payloadDigest: `sha256:${'a'.repeat(64)}`,
    };
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const claim = await methods.claimPrototypeWorkerEvent(receipt, session);
          if (!claim.created) return;
          await methods.updatePrototypeExecution({
            ...identity(input.jobId), actualCostDelta: 0.25, session,
          });
        });
      } finally {
        await session.endSession();
      }
    }
    await expect(models.PrototypeWorkerEventReceipt.countDocuments()).resolves.toBe(1);
    await expect(models.PrototypeJob.findOne({ jobId: input.jobId }).lean())
      .resolves.toMatchObject({ actualCostUsd: 0.25, revision: 1 });
  });

  it('rolls back the receipt when the event effect fails', async () => {
    const input = job();
    await models.PrototypeJob.create(input);
    const session = await mongoose.startSession();
    try {
      await expect(session.withTransaction(async () => {
        await methods.claimPrototypeWorkerEvent({
          eventId: 'event_rollback', jobId: input.jobId, commandId: 'command_1',
          payloadType: 'progress', payloadDigest: `sha256:${'b'.repeat(64)}`,
        }, session);
        await methods.updatePrototypeExecution({
          ...identity(input.jobId), phase: 'should rollback', session,
        });
        throw new Error('injected crash before commit');
      })).rejects.toThrow('injected crash');
    } finally {
      await session.endSession();
    }
    await expect(models.PrototypeWorkerEventReceipt.countDocuments()).resolves.toBe(0);
    await expect(models.PrototypeJob.findOne({ jobId: input.jobId }).lean())
      .resolves.toMatchObject({ phase: null, revision: 1 });
  });
});
