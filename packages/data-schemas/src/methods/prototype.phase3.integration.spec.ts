import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import Redis from 'ioredis';
import {
  Phase3Pipeline,
  PublicationAdapter,
  S3ArtifactStore,
  artifactDigest,
  type ImmutableStoredObject,
  type StageIdentity,
  type VerifiedArtifactSnapshot,
} from '../../../prototype-worker/src';
import { createModels } from '~/models';
import { createPrototypeMethods } from './prototype';

const { PrototypeS3Client } = require('../../../../api/server/services/Prototypes/PrototypeS3Client');
const { PrototypeEventApplier } = require('../../../../api/server/services/Prototypes/PrototypeEventApplier');
const { PrototypeEventConsumer } = require('../../../../api/server/services/Prototypes/PrototypeEventConsumer');
const {
  PrototypeRedisEventSourceV2,
} = require('../../../../api/server/services/Prototypes/PrototypeEventStream');
const {
  createDurablePublicationCompletion,
} = require('../../../../api/server/services/Prototypes/PrototypeProductionWiring');

const integrationDescribe = process.env.PROTOTYPE_PHASE3_VERTICAL === '1'
  ? describe
  : describe.skip;

const fixedDigest = (letter: string): `sha256:${string}` => `sha256:${letter.repeat(64)}`;

integrationDescribe('phase-3 fake vertical with real Mongo replica set, Redis and MinIO', () => {
  let redis: Redis;
  let s3: InstanceType<typeof PrototypeS3Client>;
  let models: ReturnType<typeof createModels>;
  let methods: ReturnType<typeof createPrototypeMethods>;

  beforeAll(async () => {
    await mongoose.connect(process.env.PROTOTYPE_MONGO_REPLSET_URI!, { serverSelectionTimeoutMS: 15_000 });
    models = createModels(mongoose);
    methods = createPrototypeMethods(mongoose);
    await Promise.all([
      models.PrototypeJob.syncIndexes(), models.PrototypeArtifact.syncIndexes(),
      models.PrototypeWorkerEventReceipt.syncIndexes(),
    ]);
    redis = new Redis(process.env.REDIS_URI!);
    await redis.ping();
    s3 = new PrototypeS3Client({
      endpoint: process.env.AWS_ENDPOINT_URL,
      region: process.env.AWS_REGION || 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }, 30_000);

  afterAll(async () => {
    redis?.disconnect(false);
    s3?.destroy();
    await mongoose.disconnect();
  });

  it('reaches review only after one immutable verified snapshot is durable', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const bucket = process.env.AWS_BUCKET_NAME!;
    const tenantId = `tenant_${suffix}`;
    const jobId = `job_${suffix}`;
    const userId = new Types.ObjectId();
    const templateDigest = fixedDigest('a');
    const toolchainDigest = fixedDigest('b');
    const store = new S3ArtifactStore(s3, bucket);
    const published: ImmutableStoredObject[] = [];
    const streamKey = `prototype:phase3:test:${suffix}`;
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-phase3-'));
    const identity = (stage: string, repair = 0): StageIdentity => ({
      attemptId: `attempt_${suffix}_${repair}`,
      executionId: `${stage}_${suffix}_${repair}`,
      stageId: `${stage}_${suffix}_${repair}`,
    });
    const publishIdentity = identity('publish');
    const checkpoint = Buffer.from('generated immutable checkpoint');
    const checkpointDigest = artifactDigest(checkpoint);
    const snapshot: VerifiedArtifactSnapshot = {
      html: Buffer.from('<main>offline phase 3</main>'),
      sourcesZip: Buffer.from('deterministic zip bytes'),
      qaEvidence: Buffer.from('{"schemaVersion":1,"passed":true}\n'),
      digests: { html: undefined!, sourcesZip: undefined!, qaEvidence: undefined! },
    };
    snapshot.digests = {
      html: artifactDigest(snapshot.html), sourcesZip: artifactDigest(snapshot.sourcesZip),
      qaEvidence: artifactDigest(snapshot.qaEvidence),
    };
    const owner = (stageIdentity: StageIdentity) => ({ tenantId, jobId, executionId: stageIdentity.executionId, revision: 1 });

    await models.PrototypeJob.create({
      jobId, userId, tenantId, conversationId: `conversation_${suffix}`,
      originMessageId: `message_${suffix}`, originToolCallId: `tool_${suffix}`,
      status: 'running', waitingReason: null, phase: 'publish', modelId: 'fake/model',
      modelPolicyVersion: 'test', modelRecommendation: 'recommended', revision: 1, fenceToken: 7,
      activeCommandId: `command_${suffix}`, activeTurnId: `turn_${suffix}`,
      activeAttemptId: publishIdentity.attemptId, activeExecutionId: publishIdentity.executionId,
      activeLeaseId: `lease_${suffix}`, activeStage: 'publish', pipelineStep: 5, checkpointRevision: null,
      checkpointDigest: null, latestPromptMessageId: null, previewArtifactId: null,
      previewDigest: null, sourcesArtifactId: null, sourcesDigest: null, qaArtifactId: null,
      templateDigest: null, toolchainDigest: null, estimatedCost: null, actualCostUsd: 0,
      failure: null, completedAt: null,
    });
    await models.PrototypeOutbox.create({
      schemaVersion: 2, commandId: `command_${suffix}`, kind: 'execute_stage', jobId,
      turnId: `turn_${suffix}`, tenantId, userId: String(userId), modelId: 'fake/model',
      expectedRevision: 1, executionId: publishIdentity.executionId,
      attemptId: publishIdentity.attemptId, stage: 'publish', pipelineStep: 5,
      fenceToken: 7, checkpointRevision: 1, checkpointDigest, sourceDigest: checkpointDigest,
      budget: { currency: 'USD', maxCostUsd: 1, maxRequests: 4, maxInputTokens: null, maxOutputTokens: null },
      deadlineAt: new Date(Date.now() + 60_000), attachmentManifest: [], status: 'published',
      publishAttempts: 1, publishedAt: new Date(), lastAttemptAt: new Date(),
    });

    const pipeline = new Phase3Pipeline({
      createIdentity: identity as never,
      generate: async (stageIdentity) => {
        await redis.xadd(streamKey, '*', 'stage', stageIdentity.stageId);
        await fs.writeFile(path.join(workspace, 'source.tsx'), 'export default true');
        return { checkpoint, sourceDigest: checkpointDigest };
      },
      prepareDependencies: async (_sourceDigest, stageIdentity) => {
        await redis.xadd(streamKey, '*', 'stage', stageIdentity.stageId);
        const bytes = Buffer.from('approved read-only dependencies');
        const reference = await store.publish({ owner: owner(stageIdentity), kind: 'dependency_bundle', bytes,
          digest: artifactDigest(bytes), contentType: 'application/zip', templateDigest, toolchainDigest });
        published.push(reference);
        return reference;
      },
      transfer: async (value, stageIdentity) => {
        await redis.xadd(streamKey, '*', 'stage', stageIdentity.stageId);
        return Buffer.isBuffer(value) ? Buffer.from(value) : store.readVerified(value as ImmutableStoredObject, value as ImmutableStoredObject);
      },
      buildQa: async ({ source, dependencyBundle }, stageIdentity) => {
        await redis.xadd(streamKey, '*', 'stage', stageIdentity.stageId);
        expect(source).toEqual(checkpoint);
        expect(dependencyBundle).toEqual(Buffer.from('approved read-only dependencies'));
        return snapshot;
      },
      repair: async () => { throw new Error('repair was not expected'); },
      publish: async ({ checkpoint: value, snapshot: verified }, stageIdentity) => {
        await redis.xadd(streamKey, '*', 'stage', stageIdentity.stageId);
        const references = await new PublicationAdapter(store).publish({
          owner: owner(stageIdentity), checkpoint: value as Buffer,
          snapshot: verified as VerifiedArtifactSnapshot, checkpointDigest, templateDigest, toolchainDigest,
        });
        published.push(...references);
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => methods.registerPrototypeArtifacts({
            jobId, turnId: `turn_${suffix}`, commandId: `command_${suffix}`, expectedRevision: 1,
            attemptId: publishIdentity.attemptId, executionId: publishIdentity.executionId,
            stage: 'publish', pipelineStep: 5, fenceToken: 7, leaseId: `lease_${suffix}`,
            templateDigest, toolchainDigest,
            artifacts: references.map((reference) => ({
              kind: reference.kind as 'checkpoint' | 'html' | 'sources_zip' | 'qa_evidence',
              objectKey: reference.objectKey, digest: reference.digest, size: reference.size,
              contentType: reference.contentType,
            })),
            session,
          }));
        } finally { await session.endSession(); }
        return references;
      },
      acceptPublication: async () => {
        const artifacts = await models.PrototypeArtifact.find({ jobId, executionId: publishIdentity.executionId }).lean();
        const byKind = new Map(artifacts.map((artifact) => [artifact.kind, artifact]));
        const event = {
          schemaVersion: 2, eventId: `event_${suffix}`, commandId: `command_${suffix}`,
          jobId, turnId: `turn_${suffix}`, expectedRevision: 1,
          attemptId: publishIdentity.attemptId, executionId: publishIdentity.executionId,
          stage: 'publish', fenceToken: 7, leaseId: `lease_${suffix}`, tenantId,
          payload: {
            type: 'review_ready', checkpoint: { revision: 1, digest: checkpointDigest },
            artifacts: ['checkpoint', 'html', 'sources_zip', 'qa_evidence'].map((kind) => {
              const artifact = byKind.get(kind)!;
              return { artifactId: String(artifact.artifactId), kind, digest: `sha256:${artifact.sha256}`,
                size: artifact.size, contentType: artifact.contentType, executionId: artifact.executionId,
                revision: artifact.revision, templateDigest, toolchainDigest };
            }),
          }, createdAt: new Date().toISOString(),
        };
        const applier = new PrototypeEventApplier({
          updateExecution: methods.updatePrototypeExecution,
          finishExecution: methods.finishPrototypeExecution,
          verifyPublication: ({ event: value, session }: any) => methods.verifyPrototypePublication({ event: value, session }),
          acceptPublication: methods.acceptPrototypePublication,
        });
        return applier.apply(event);
      },
    });

    try {
      await expect(pipeline.run()).resolves.toMatchObject({ status: 'review', revision: 2 });
      await fs.rm(workspace, { recursive: true, force: true });
      const htmlReference = published.find((reference) => reference.kind === 'html')!;
      await expect(store.readVerified(htmlReference, htmlReference)).resolves.toEqual(snapshot.html);
      expect(await redis.xlen(streamKey)).toBeGreaterThanOrEqual(5);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await Promise.all(published.map((reference) => s3.deleteObject({ bucket, key: reference.objectKey })));
      await redis.del(streamKey);
      await models.PrototypeArtifact.deleteMany({ jobId });
      await models.PrototypeOutbox.deleteMany({ jobId });
      await models.PrototypeJob.deleteMany({ jobId });
    }
  }, 30_000);

  it('advances generation through publish with one transactional outbox command per stage', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const jobId = `job_${suffix}`;
    const turnId = `turn_${suffix}`;
    const userId = new Types.ObjectId();
    let commandId = `command_${suffix}`;
    let executionId = `execution_${suffix}`;
    const attemptId = `attempt_${suffix}`;
    const stages = ['generation', 'transfer', 'dependency_preparation', 'transfer', 'build_qa', 'publish'] as const;
    const outputs = ['checkpoint', 'checkpoint_restored', 'dependency_bundle', 'dependencies_restored', 'verified_snapshot'] as const;
    await models.PrototypeJob.create({
      jobId, userId, tenantId: `tenant_${suffix}`, conversationId: `conversation_${suffix}`,
      originMessageId: `message_${suffix}`, originToolCallId: `tool_${suffix}`,
      status: 'running', waitingReason: null, phase: 'generation', modelId: 'fake/model',
      modelPolicyVersion: 'test', modelRecommendation: 'recommended', revision: 0, fenceToken: 1,
      activeCommandId: commandId, activeTurnId: turnId, activeAttemptId: attemptId,
      activeExecutionId: executionId, activeLeaseId: `lease_${suffix}_0`, activeStage: 'generation',
      pipelineStep: 0, checkpointRevision: null, checkpointDigest: null, latestPromptMessageId: null,
      previewArtifactId: null, previewDigest: null, sourcesArtifactId: null, sourcesDigest: null,
      qaArtifactId: null, templateDigest: null, toolchainDigest: null,
      estimatedCost: null, actualCostUsd: 0, failure: null, completedAt: null,
    });
    await models.PrototypeOutbox.create({
      schemaVersion: 2, commandId, kind: 'execute_stage', jobId, turnId,
      tenantId: `tenant_${suffix}`, userId: String(userId), modelId: 'fake/model',
      expectedRevision: 0, executionId, attemptId, stage: 'generation', pipelineStep: 0,
      fenceToken: 1, checkpointRevision: null, checkpointDigest: null, sourceDigest: null,
      budget: { currency: 'USD', maxCostUsd: 1, maxRequests: 4, maxInputTokens: null, maxOutputTokens: null },
      deadlineAt: new Date(Date.now() + 60_000), attachmentManifest: [], status: 'published',
      publishAttempts: 1, publishedAt: new Date(), lastAttemptAt: new Date(),
    });
    try {
      for (let step = 0; step < outputs.length; step += 1) {
        const leaseId = `lease_${suffix}_${step}`;
        if (step > 0) {
          await models.PrototypeJob.updateOne({ jobId }, { $set: { activeLeaseId: leaseId } });
        }
        const event = {
          eventId: `event_${suffix}_${step}`, jobId, turnId, commandId,
          expectedRevision: step, attemptId, executionId, stage: stages[step],
          pipelineStep: step, fenceToken: step + 1, leaseId,
          payload: {
            type: 'stage_completed' as const, outputKind: outputs[step],
            outputDigest: `sha256:${String(step + 1).repeat(64)}`,
            ...(step === 0 ? { checkpoint: { revision: 1, digest: `sha256:${'a'.repeat(64)}` } } : {}),
          },
        };
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(async () => methods.advancePrototypeStage({ event, session }));
        } finally { await session.endSession(); }
        const next = await models.PrototypeJob.findOne({ jobId }).lean();
        expect(next).toMatchObject({ revision: step + 1, fenceToken: step + 2, activeStage: stages[step + 1], pipelineStep: step + 1 });
        commandId = next!.activeCommandId!;
        executionId = next!.activeExecutionId!;
      }
      await expect(models.PrototypeOutbox.countDocuments({ jobId })).resolves.toBe(6);
      await expect(models.PrototypeJob.findOne({ jobId }).lean()).resolves.toMatchObject({ activeStage: 'publish', pipelineStep: 5 });
    } finally {
      await models.PrototypeOutbox.deleteMany({ jobId });
      await models.PrototypeJob.deleteMany({ jobId });
    }
  }, 30_000);

  it('recovers a crash after immutable upload and metadata commit without duplicate acceptance', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const bucket = process.env.AWS_BUCKET_NAME!;
    const tenantId = `tenant_${suffix}`;
    const jobId = `job_${suffix}`;
    const turnId = `turn_${suffix}`;
    const commandId = `command_${suffix}`;
    const attemptId = `attempt_${suffix}`;
    const executionId = `execution_${suffix}`;
    const leaseId = `lease_${suffix}`;
    const userId = new Types.ObjectId();
    const streamKey = `prototype:phase4:publication-recovery:${suffix}`;
    const templateDigest = fixedDigest('a');
    const toolchainDigest = fixedDigest('b');
    const checkpoint = Buffer.from('recovery checkpoint');
    const checkpointDigest = artifactDigest(checkpoint);
    const snapshot: VerifiedArtifactSnapshot = {
      html: Buffer.from('<main>publication recovery</main>'),
      sourcesZip: Buffer.from('recovery source archive'),
      qaEvidence: Buffer.from('{"schemaVersion":1,"passed":true}\n'),
      digests: { html: undefined!, sourcesZip: undefined!, qaEvidence: undefined! },
    };
    snapshot.digests = {
      html: artifactDigest(snapshot.html),
      sourcesZip: artifactDigest(snapshot.sourcesZip),
      qaEvidence: artifactDigest(snapshot.qaEvidence),
    };
    const owner = { tenantId, jobId, executionId, revision: 3 };
    const store = new S3ArtifactStore(s3, bucket);
    let references: ImmutableStoredObject[] = [];

    await models.PrototypeJob.create({
      jobId, userId, tenantId, conversationId: `conversation_${suffix}`,
      originMessageId: `message_${suffix}`, originToolCallId: `tool_${suffix}`,
      status: 'running', waitingReason: null, phase: 'publish', modelId: 'fake/model',
      modelPolicyVersion: 'test', modelRecommendation: 'recommended', revision: 3, fenceToken: 4,
      activeCommandId: commandId, activeTurnId: turnId, activeAttemptId: attemptId,
      activeExecutionId: executionId, activeLeaseId: leaseId, activeStage: 'publish', pipelineStep: 5,
      checkpointRevision: 3, checkpointDigest, latestPromptMessageId: null,
      previewArtifactId: null, previewDigest: null, sourcesArtifactId: null, sourcesDigest: null,
      qaArtifactId: null, templateDigest: null, toolchainDigest: null,
      estimatedCost: null, actualCostUsd: 0, failure: null, completedAt: null,
    });
    await models.PrototypeOutbox.create({
      schemaVersion: 2, commandId, kind: 'execute_stage', jobId, turnId, tenantId,
      userId: String(userId), modelId: 'fake/model', expectedRevision: 3, executionId,
      attemptId, stage: 'publish', pipelineStep: 5, fenceToken: 4,
      checkpointRevision: 3, checkpointDigest, sourceDigest: checkpointDigest,
      budget: {
        currency: 'USD', maxCostUsd: 1, maxRequests: 4,
        maxInputTokens: null, maxOutputTokens: null,
      },
      deadlineAt: new Date(Date.now() + 60_000), attachmentManifest: [], status: 'published',
      publishAttempts: 1, publishedAt: new Date(), lastAttemptAt: new Date(),
    });

    try {
      const adapter = new PublicationAdapter(store);
      const publishInput = {
        owner, checkpoint, snapshot, checkpointDigest, templateDigest, toolchainDigest,
      };
      const firstUpload = await adapter.publish(publishInput);
      const retriedUpload = await adapter.publish(publishInput);
      references = retriedUpload;
      expect(retriedUpload.map((item) => item.objectKey))
        .toEqual(firstUpload.map((item) => item.objectKey));

      let publishAttempts = 0;
      const complete = createDurablePublicationCompletion({
        startSession: () => mongoose.startSession(),
        registerArtifacts: methods.registerPrototypeArtifacts,
        publishControlEvent: async (event: unknown) => {
          publishAttempts += 1;
          if (publishAttempts === 1) throw new Error('injected crash before event publish');
          await redis.xadd(streamKey, '*', 'event', JSON.stringify(event));
        },
      });
      const completionInput = {
        jobId, turnId, commandId, expectedRevision: 3, attemptId, executionId,
        stage: 'publish', pipelineStep: 5, fenceToken: 4, leaseId,
        target: 'review_ready', checkpoint: { revision: 3, digest: checkpointDigest },
        templateDigest, toolchainDigest,
        artifacts: retriedUpload.map((reference) => ({
          kind: reference.kind, objectKey: reference.objectKey, digest: reference.digest,
          size: reference.size, contentType: reference.contentType,
        })),
      };
      await expect(complete(completionInput)).rejects.toThrow('injected crash before event publish');
      await expect(models.PrototypeArtifact.countDocuments({ jobId })).resolves.toBe(4);
      await expect(models.PrototypeJob.findOne({ jobId }).lean()).resolves.toMatchObject({
        status: 'running', revision: 3, activeStage: 'publish',
      });

      const recovered = await complete(completionInput);
      const streamEntries = await redis.xrange(streamKey, '-', '+');
      expect(streamEntries).toHaveLength(1);
      const eventField = streamEntries[0][1].indexOf('event');
      const event = JSON.parse(streamEntries[0][1][eventField + 1]);
      expect(event.eventId).toBe(recovered.eventId);

      const applier = new PrototypeEventApplier({
        updateExecution: methods.updatePrototypeExecution,
        finishExecution: methods.finishPrototypeExecution,
        verifyPublication: ({ event: value, session }: any) =>
          methods.verifyPrototypePublication({ event: value, session }),
        acceptPublication: methods.acceptPrototypePublication,
      });
      const consumer = new PrototypeEventConsumer({
        startSession: () => mongoose.startSession(),
        claimEvent: methods.claimPrototypeWorkerEvent,
        loadJob: (value: any, session: any) =>
          models.PrototypeJob.findOne({ jobId: value.jobId }, null, { session }).lean(),
        applyEvent: (value: any, session: any) => applier.apply(value, session),
      });
      await expect(consumer.consume(streamEntries[0][0], event)).resolves.toEqual({
        applied: true, duplicate: false,
      });
      await expect(consumer.consume(streamEntries[0][0], event)).resolves.toEqual({
        applied: false, duplicate: true,
      });
      await expect(models.PrototypeJob.findOne({ jobId }).lean()).resolves.toMatchObject({
        status: 'review', revision: 4, previewDigest: snapshot.digests.html,
        sourcesDigest: snapshot.digests.sourcesZip,
      });
      await expect(models.PrototypeArtifact.countDocuments({ jobId })).resolves.toBe(4);
      await expect(models.PrototypeWorkerEventReceipt.countDocuments({ jobId })).resolves.toBe(1);
    } finally {
      await Promise.all(references.map((reference) =>
        s3.deleteObject({ bucket, key: reference.objectKey })));
      await redis.del(streamKey);
      await models.PrototypeWorkerEventReceipt.deleteMany({ jobId });
      await models.PrototypeArtifact.deleteMany({ jobId });
      await models.PrototypeOutbox.deleteMany({ jobId });
      await models.PrototypeJob.deleteMany({ jobId });
    }
  }, 30_000);

  it('recovers an event-consumer transport partition after Mongo commit but before Redis ACK', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const jobId = `job_${suffix}`;
    const turnId = `turn_${suffix}`;
    const commandId = `command_${suffix}`;
    const attemptId = `attempt_${suffix}`;
    const executionId = `execution_${suffix}`;
    const leaseId = `lease_${suffix}`;
    const userId = new Types.ObjectId();
    const group = `prototype-partition-${suffix}`;
    const redisA = new Redis(process.env.REDIS_URI!, { maxRetriesPerRequest: 1 });
    const redisB = new Redis(process.env.REDIS_URI!, { maxRetriesPerRequest: 1 });
    const sourceA = new PrototypeRedisEventSourceV2({
      redis: redisA, consumer: `api-a-${suffix}`, group, claimIdleMs: 0, blockMs: 10,
    });
    const sourceB = new PrototypeRedisEventSourceV2({
      redis: redisB, consumer: `api-b-${suffix}`, group, claimIdleMs: 0, blockMs: 10,
    });
    const event = {
      schemaVersion: 2,
      eventId: `event_${suffix}`,
      jobId,
      turnId,
      commandId,
      expectedRevision: 1,
      attemptId,
      executionId,
      stage: 'generation',
      pipelineStep: 0,
      fenceToken: 2,
      leaseId,
      payload: { type: 'progress', phase: 'Partition recovery' },
      createdAt: new Date().toISOString(),
    };
    let streamId: string | undefined;
    await models.PrototypeJob.create({
      jobId, userId, tenantId: `tenant_${suffix}`, conversationId: `conversation_${suffix}`,
      originMessageId: `message_${suffix}`, originToolCallId: `tool_${suffix}`,
      status: 'running', waitingReason: null, phase: 'generation', modelId: 'fake/model',
      modelPolicyVersion: 'test', modelRecommendation: 'recommended', revision: 1, fenceToken: 2,
      activeCommandId: commandId, activeTurnId: turnId, activeAttemptId: attemptId,
      activeExecutionId: executionId, activeLeaseId: leaseId, activeStage: 'generation', pipelineStep: 0,
      checkpointRevision: null, checkpointDigest: null, latestPromptMessageId: null,
      previewArtifactId: null, previewDigest: null, sourcesArtifactId: null, sourcesDigest: null,
      qaArtifactId: null, templateDigest: null, toolchainDigest: null,
      estimatedCost: null, actualCostUsd: 0, failure: null, completedAt: null,
    });
    const applier = new PrototypeEventApplier({
      updateExecution: methods.updatePrototypeExecution,
      finishExecution: methods.finishPrototypeExecution,
    });
    const consumer = new PrototypeEventConsumer({
      startSession: () => mongoose.startSession(),
      claimEvent: methods.claimPrototypeWorkerEvent,
      loadJob: (value: any, session: any) =>
        models.PrototypeJob.findOne({ jobId: value.jobId }, null, { session }).lean(),
      applyEvent: (value: any, session: any) => applier.apply(value, session),
      projectEvent: methods.projectPrototypeWorkerEvent,
    });

    try {
      await sourceA.ensureGroup();
      await redisA.xgroup('SETID', 'prototype.events.v2', group, '$');
      streamId = await redisA.xadd('prototype.events.v2', '*', 'event', JSON.stringify(event));
      const first = await sourceA.next();
      expect(first).toEqual({ streamId, event });
      await expect(consumer.consume(streamId, event)).resolves.toEqual({
        applied: true, duplicate: false,
      });

      redisA.disconnect(false);
      await sourceB.ensureGroup();
      const reclaimed = await sourceB.next();
      expect(reclaimed).toEqual({ streamId, event });
      await expect(consumer.consume(streamId, event)).resolves.toEqual({
        applied: false, duplicate: true,
      });
      await sourceB.acknowledge(streamId);

      await expect(models.PrototypeJob.findOne({ jobId }).lean()).resolves.toMatchObject({
        phase: 'Partition recovery', revision: 1, eventSequence: 1,
      });
      await expect(models.PrototypeWorkerEventReceipt.countDocuments({ jobId })).resolves.toBe(1);
      await expect(models.PrototypeEvent.countDocuments({ jobId })).resolves.toBe(1);
      const pending = await redisB.xpending('prototype.events.v2', group);
      expect(Number(pending[0])).toBe(0);
    } finally {
      if (streamId) await redisB.xdel('prototype.events.v2', streamId);
      await redisB.xgroup('DESTROY', 'prototype.events.v2', group).catch(() => undefined);
      redisA.disconnect(false);
      redisB.disconnect(false);
      await models.PrototypeEvent.deleteMany({ jobId });
      await models.PrototypeWorkerEventReceipt.deleteMany({ jobId });
      await models.PrototypeJob.deleteMany({ jobId });
    }
  }, 30_000);

  it('creates at most two durable repair attempts with new identities and safe diagnostics', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const jobId = `job_${suffix}`;
    const turnId = `turn_${suffix}`;
    const userId = new Types.ObjectId();
    const checkpointDigest = `sha256:${'a'.repeat(64)}`;
    const budget = {
      currency: 'USD' as const, maxCostUsd: 1, maxRequests: 8,
      maxInputTokens: null, maxOutputTokens: null,
    };
    const deadlineAt = new Date(Date.now() + 60_000);
    let revision = 0;
    let fenceToken = 1;
    let commandId = `command_${suffix}_0`;
    let attemptId = `attempt_${suffix}_0`;
    let executionId = `execution_${suffix}_0`;
    let leaseId = `lease_${suffix}_0`;
    await models.PrototypeJob.create({
      jobId, userId, tenantId: `tenant_${suffix}`, conversationId: `conversation_${suffix}`,
      originMessageId: `message_${suffix}`, originToolCallId: `tool_${suffix}`,
      status: 'running', waitingReason: null, phase: 'build_qa', modelId: 'fake/model',
      modelPolicyVersion: 'test', modelRecommendation: 'recommended', revision, fenceToken,
      activeCommandId: commandId, activeTurnId: turnId, activeAttemptId: attemptId,
      activeExecutionId: executionId, activeLeaseId: leaseId, activeStage: 'build_qa', pipelineStep: 4,
      checkpointRevision: 1, checkpointDigest, latestPromptMessageId: null,
      previewArtifactId: null, previewDigest: null, sourcesArtifactId: null, sourcesDigest: null,
      qaArtifactId: null, templateDigest: null, toolchainDigest: null,
      estimatedCost: null, actualCostUsd: 0, failure: null, completedAt: null,
    });
    await models.PrototypeTurn.create({
      turnId, jobId, ordinal: 0, kind: 'initial', sourceMessageId: null,
      replyToPrototypeMessageId: null, text: 'Build a prototype', attachmentManifest: [],
      modelId: 'fake/model',
      commandId: `turn_command_${suffix}`, executionAttempts: 0, status: 'running', costUsd: 0,
    });
    const createBuildOutbox = () => models.PrototypeOutbox.create({
      schemaVersion: 2, commandId, kind: 'execute_stage', jobId, turnId,
      tenantId: `tenant_${suffix}`, userId: String(userId), modelId: 'fake/model',
      expectedRevision: revision, executionId, attemptId, stage: 'build_qa', pipelineStep: 4,
      fenceToken, checkpointRevision: 1, checkpointDigest, sourceDigest: checkpointDigest,
      dependencyDigest: `sha256:${'b'.repeat(64)}`,
      budget, deadlineAt, attachmentManifest: [], status: 'published', publishAttempts: 1,
      publishedAt: new Date(), lastAttemptAt: new Date(),
    });
    await createBuildOutbox();
    try {
      for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
        const event = {
          eventId: `event_${suffix}_${ordinal}`, jobId, turnId, commandId, expectedRevision: revision,
          attemptId, executionId, stage: 'build_qa' as const, pipelineStep: 4 as const,
          fenceToken, leaseId,
          payload: {
            type: 'failed' as const, code: ordinal === 1 ? 'PROTOTYPE_QA_FAILED' as const : 'PROTOTYPE_BUILD_FAILED' as const,
            message: ordinal === 1 ? 'Preview runtime failed' : 'Build failed', retryable: true as const,
            diagnostics: [`src/app.tsx: repair ${ordinal}`],
          },
        };
        const session = await mongoose.startSession();
        let result: any;
        try {
          await session.withTransaction(async () => { result = await methods.retryPrototypeBuildStage({ event, session }); });
        } finally { await session.endSession(); }
        expect(result).toMatchObject({ repaired: true, job: { activeStage: 'generation', pipelineStep: 0 } });
        expect(result.outbox).toMatchObject({
          stage: 'generation', pipelineStep: 0,
          dependencyDigest: `sha256:${'b'.repeat(64)}`,
          repair: { ordinal, diagnostics: [`src/app.tsx: repair ${ordinal}`] },
        });
        expect(result.outbox.attemptId).not.toBe(attemptId);
        expect(result.outbox.executionId).not.toBe(executionId);

        const generationLease = `lease_${suffix}_${ordinal}_generation`;
        await models.PrototypeJob.updateOne({ jobId }, { $set: { activeLeaseId: generationLease } });
        const generationSession = await mongoose.startSession();
        let transferResult: any;
        try {
          await generationSession.withTransaction(async () => {
            transferResult = await methods.advancePrototypeStage({
              event: {
                eventId: `event_${suffix}_${ordinal}_generation`, jobId, turnId,
                commandId: result.outbox.commandId, expectedRevision: revision + 1,
                attemptId: result.outbox.attemptId, executionId: result.outbox.executionId,
                stage: 'generation', pipelineStep: 0, fenceToken: fenceToken + 1,
                leaseId: generationLease,
                payload: {
                  type: 'stage_completed', outputKind: 'checkpoint',
                  outputDigest: checkpointDigest,
                  checkpoint: { revision: 1, digest: checkpointDigest },
                },
              },
              session: generationSession,
            });
          });
        } finally { await generationSession.endSession(); }
        expect(transferResult.outbox).toMatchObject({
          stage: 'transfer', pipelineStep: 1,
          dependencyDigest: `sha256:${'b'.repeat(64)}`,
          repair: { ordinal },
        });
        const transferLease = `lease_${suffix}_${ordinal}_transfer`;
        await models.PrototypeJob.updateOne({ jobId }, { $set: { activeLeaseId: transferLease } });
        const transferSession = await mongoose.startSession();
        let buildResult: any;
        try {
          await transferSession.withTransaction(async () => {
            buildResult = await methods.advancePrototypeStage({
              event: {
                eventId: `event_${suffix}_${ordinal}_transfer`, jobId, turnId,
                commandId: transferResult.outbox.commandId, expectedRevision: revision + 2,
                attemptId: transferResult.outbox.attemptId, executionId: transferResult.outbox.executionId,
                stage: 'transfer', pipelineStep: 1, fenceToken: fenceToken + 2,
                leaseId: transferLease,
                payload: {
                  type: 'stage_completed', outputKind: 'checkpoint_restored',
                  outputDigest: checkpointDigest,
                },
              },
              session: transferSession,
            });
          });
        } finally { await transferSession.endSession(); }
        expect(buildResult.outbox).toMatchObject({
          stage: 'build_qa', pipelineStep: 4,
          dependencyDigest: `sha256:${'b'.repeat(64)}`,
          repair: { ordinal },
        });
        revision += 3;
        fenceToken += 3;
        commandId = buildResult.outbox.commandId;
        attemptId = buildResult.outbox.attemptId;
        executionId = buildResult.outbox.executionId;
        leaseId = `lease_${suffix}_${ordinal}_build`;
        await models.PrototypeJob.updateOne({ jobId }, { $set: { activeLeaseId: leaseId } });
      }
      const session = await mongoose.startSession();
      let exhausted: any;
      try {
        await session.withTransaction(async () => {
          exhausted = await methods.retryPrototypeBuildStage({
            event: {
              eventId: `event_${suffix}_3`, jobId, turnId, commandId, expectedRevision: revision,
              attemptId, executionId, stage: 'build_qa', pipelineStep: 4,
              fenceToken, leaseId,
              payload: {
                type: 'failed', code: 'PROTOTYPE_QA_FAILED', message: 'QA failed', retryable: true,
                diagnostics: ['dialog did not open'],
              },
            },
            session,
          });
        });
      } finally { await session.endSession(); }
      expect(exhausted).toEqual({ repaired: false });
      await expect(models.PrototypeTurn.findOne({ turnId }).lean())
        .resolves.toMatchObject({ executionAttempts: 2 });
      await expect(models.PrototypeJob.findOne({ jobId }).lean())
        .resolves.toMatchObject({ revision, activeStage: 'build_qa', pipelineStep: 4 });
    } finally {
      await models.PrototypeOutbox.deleteMany({ jobId });
      await models.PrototypeTurn.deleteMany({ jobId });
      await models.PrototypeJob.deleteMany({ jobId });
    }
  }, 30_000);
});
