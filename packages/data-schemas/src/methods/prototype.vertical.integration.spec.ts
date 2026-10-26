import mongoose, { Types } from 'mongoose';
import Redis from 'ioredis';
import express from 'express';
import {
  parsePrototypeWorkerEventV2,
  RedisPrototypeCommandSourceV2,
} from '../../../prototype-worker/src';
import { createModels } from '~/models';
import { createPrototypeMethods } from './prototype';
import { PrototypeOrchestratorRuntime } from '../../../../apps/prototype-service/src/orchestrator-runtime.js';
import { RedisExecutionRegistry } from '../../../../apps/prototype-service/src/execution-registry.js';
import { RedisConcurrencyQuota } from '../../../../apps/prototype-service/src/quota.js';
import { RedisPrototypeEventPublisherV2 } from '../../../../apps/prototype-service/src/event-publisher.js';
import { PrototypeControlPlaneClient } from '../../../../apps/prototype-service/src/control-plane-client.js';
import {
  OrchestratedStageSupervisor,
  deterministicLeaseId,
} from '../../../../apps/prototype-service/src/stage-supervisor.js';

const { PrototypeService } = require('../../../../api/server/services/Prototypes/PrototypeService');
const {
  createPrototypeTransportRuntime,
} = require('../../../../api/server/services/Prototypes/PrototypeTransportWiring');
const {
  createPrototypeControlPlaneRouter,
} = require('../../../../api/server/routes/internal/prototypeControlPlane');

const integrationDescribe = process.env.PROTOTYPE_VERTICAL_TEST === '1' ? describe : describe.skip;

async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Prototype vertical integration condition timed out');
}

integrationDescribe('prototype fake vertical flow with real Mongo and Redis', () => {
  let models: ReturnType<typeof createModels>;
  let methods: ReturnType<typeof createPrototypeMethods>;
  let redis: Redis;
  let eventRedis: Redis;
  let workerRedis: Redis;

  beforeAll(async () => {
    const mongoUri = process.env.PROTOTYPE_MONGO_REPLSET_URI;
    const redisUrl = process.env.REDIS_URI;
    if (!mongoUri || !redisUrl) throw new Error('Prototype vertical integration endpoints are required');
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15_000 });
    models = createModels(mongoose);
    methods = createPrototypeMethods(mongoose);
    await Promise.all([
      models.PrototypeJob.syncIndexes(), models.PrototypeTurn.syncIndexes(),
      models.PrototypeEvent.syncIndexes(), models.PrototypeOutbox.syncIndexes(),
      models.PrototypeWorkerEventReceipt.syncIndexes(),
    ]);
    redis = new Redis(redisUrl);
    eventRedis = new Redis(redisUrl);
    workerRedis = new Redis(redisUrl);
  });

  afterAll(async () => {
    if (redis?.status !== 'end') redis?.disconnect();
    if (eventRedis?.status !== 'end') eventRedis?.disconnect();
    if (workerRedis?.status !== 'end') workerRedis?.disconnect();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Promise.all([
      models.PrototypeJob.deleteMany({}), models.PrototypeTurn.deleteMany({}),
      models.PrototypeEvent.deleteMany({}), models.PrototypeOutbox.deleteMany({}),
      models.PrototypeWorkerEventReceipt.deleteMany({}),
    ]);
  });

  it('runs create → outbox → service → fake stage → waiting and deduplicates after service restart', async () => {
    const suffix = new Types.ObjectId().toString();
    const userId = new Types.ObjectId();
    const sessionDeps = {
      startSession: () => mongoose.startSession(),
      ...methods,
      createPrototypeTurn: (input: unknown, session: unknown) =>
        models.PrototypeTurn.create([input], { session }).then(([turn]) => turn.toObject()),
      findPrototypeOutbox: (commandId: string, session: unknown) =>
        models.PrototypeOutbox.findOne({ commandId }, null, { session }).lean(),
      findLatestPrototypeTurn: (jobId: string, session: unknown) =>
        models.PrototypeTurn.findOne({ jobId }, null, { session }).sort({ ordinal: -1 }).lean(),
      findOwnedPrototypeJobByConversation: (input: Record<string, unknown>) =>
        models.PrototypeJob.findOne(input).lean(),
      getMessage: async () => ({
        messageId: `message_${suffix}`, conversationId: `conversation_${suffix}`,
        user: String(userId), tenantId: `tenant_${suffix}`, attachments: [],
      }),
      findFileById: async () => null,
      estimateCost: async () => null,
      createId: (kind: string) => `${kind}_${new Types.ObjectId()}`,
    };
    const service = new PrototypeService(sessionDeps);
    const result = await service.acceptToolCall({
      req: {
        user: { id: userId, tenantId: `tenant_${suffix}` },
        body: { conversationId: `conversation_${suffix}` },
        config: { prototypeAgent: { modelPolicy: {
          version: 'test', recommendedPatterns: ['fake/*'], blockedPatterns: [],
          requireToolCalling: true, unknownModelPolicy: 'warn',
        } } },
        prototypeProviderCapabilities: { toolCalling: true },
      },
      spec: 'Build a fake-model prototype',
      toolCallId: `tool_${suffix}`,
      messageId: `message_${suffix}`,
      modelId: 'fake/model',
    });

    const eventGroup = `prototype-control-${suffix}`;
    const commandGroup = `prototype-worker-${suffix}`;
    const transportErrors: Error[] = [];
    const runtime = createPrototypeTransportRuntime({
      redis,
      eventRedis,
      db: methods,
      startSession: () => mongoose.startSession(),
      loadJob: (event: { jobId: string }, session: unknown) =>
        models.PrototypeJob.findOne({ jobId: event.jobId }, null, { session }).lean(),
      parseEvent: parsePrototypeWorkerEventV2,
      consumerId: `api-events-${suffix}`,
      eventGroup,
      eventBlockMs: 100,
      publisherId: `api-outbox-${suffix}`,
      onError: (error: Error) => transportErrors.push(error),
    });
    const source = new RedisPrototypeCommandSourceV2(workerRedis, `worker-${suffix}`, {
      group: commandGroup, blockMs: 100, claimIdleMs: 0,
    });
    const restartedSource = new RedisPrototypeCommandSourceV2(workerRedis, `worker-restarted-${suffix}`, {
      group: commandGroup, blockMs: 100, claimIdleMs: 0,
    });
    let commandStreamId: string | undefined;
    let replayCommandStreamId: string | undefined;
    let eventStreamId: string | undefined;
    let replayStreamId: string | undefined;
    let acceptedCommand: NonNullable<Awaited<ReturnType<typeof source.next>>>['command'] | undefined;
    let scheduledExecutions = 0;
    try {
      await workerRedis.xgroup('CREATE', 'prototype.commands.v2', commandGroup, '$', 'MKSTREAM');
      await workerRedis.xgroup('CREATE', 'prototype.events.v2', eventGroup, '$', 'MKSTREAM');
      await runtime.start();
      let item: Awaited<ReturnType<typeof source.next>> = null;
      await eventually(async () => {
        if (transportErrors[0]) throw transportErrors[0];
        item = await source.next();
        return item !== null;
      });
      expect(item?.command.jobId).toBe(result.jobId);
      commandStreamId = item?.streamId;
      const command = item!.command;
      acceptedCommand = command;
      let event: ReturnType<typeof parsePrototypeWorkerEventV2> | undefined;
      const createServiceRuntime = (
        commandSource: RedisPrototypeCommandSourceV2,
        scheduler: { createExecution: (input: typeof command) => Promise<void> },
      ) => new PrototypeOrchestratorRuntime({
        source: commandSource,
        events: { publishRejected: async () => undefined },
        registry: new RedisExecutionRegistry(workerRedis),
        quota: new RedisConcurrencyQuota(workerRedis, { global: 8, tenant: 4, user: 1 }),
        scheduler,
        buildJobInput: (value: typeof command) => value,
      });
      const fakeScheduler = {
        createExecution: async (execution: typeof command) => {
          scheduledExecutions += 1;
          const leaseId = `lease_${suffix}`;
          await methods.registerPrototypeLease({
            jobId: execution.jobId, turnId: execution.turnId, commandId: execution.commandId,
            expectedRevision: execution.expectedRevision, attemptId: execution.attemptId,
            executionId: execution.executionId, stage: execution.stage,
            fenceToken: execution.fenceToken, leaseId,
          });
          event = parsePrototypeWorkerEventV2({
            schemaVersion: 2,
            eventId: `event_${suffix}`,
            commandId: execution.commandId,
            jobId: execution.jobId,
            turnId: execution.turnId,
            expectedRevision: execution.expectedRevision,
            attemptId: execution.attemptId,
            executionId: execution.executionId,
            stage: execution.stage,
            fenceToken: execution.fenceToken,
            leaseId,
            payload: {
              type: 'waiting', reason: 'clarification', prompt: 'Choose a color scheme',
              checkpoint: { revision: 1, digest: `sha256:${'a'.repeat(64)}` },
            },
            createdAt: new Date().toISOString(),
          });
          eventStreamId = await workerRedis.xadd(
            'prototype.events.v2', '*', 'event', JSON.stringify(event),
          );
        },
      };
      const service = createServiceRuntime(source, fakeScheduler);
      await service.handle(item!);
      await eventually(async () =>
        (await models.PrototypeJob.findOne({ jobId: result.jobId }).lean())?.status === 'waiting_for_input');
      expect(scheduledExecutions).toBe(1);

      replayCommandStreamId = await workerRedis.xadd(
        'prototype.commands.v2', '*', 'command', JSON.stringify(command),
      );
      const replayCommand = await restartedSource.next();
      expect(replayCommand?.streamId).toBe(replayCommandStreamId);
      const restartedService = createServiceRuntime(restartedSource, fakeScheduler);
      await restartedService.handle(replayCommand!);
      expect(scheduledExecutions).toBe(1);

      replayStreamId = await workerRedis.xadd(
        'prototype.events.v2', '*', 'event', JSON.stringify(event!),
      );
      await eventually(async () =>
        (await models.PrototypeWorkerEventReceipt.countDocuments({ eventId: event!.eventId })) === 1);
      await expect(models.PrototypeJob.findOne({ jobId: result.jobId }).lean()).resolves.toMatchObject({
        status: 'waiting_for_input', revision: 1, waitingReason: 'clarification',
        activeLeaseId: null, checkpointRevision: 1,
      });
      await expect(models.PrototypeOutbox.findOne({ jobId: result.jobId }).lean())
        .resolves.toMatchObject({ status: 'published', publishAttempts: 1 });
    } finally {
      await runtime.stop();
      await source.close();
      await restartedSource.close();
      if (acceptedCommand) {
        const registry = new RedisExecutionRegistry(workerRedis);
        const quota = new RedisConcurrencyQuota(workerRedis, { global: 8, tenant: 4, user: 1 });
        await quota.release(acceptedCommand);
        await workerRedis.del(registry.key(acceptedCommand), registry.scheduledKey(acceptedCommand));
      }
      const commandIds = [commandStreamId, replayCommandStreamId].filter(Boolean) as string[];
      const eventIds = [eventStreamId, replayStreamId].filter(Boolean) as string[];
      if (commandIds.length > 0) await workerRedis.xdel('prototype.commands.v2', ...commandIds);
      if (eventIds.length > 0) await workerRedis.xdel('prototype.events.v2', ...eventIds);
      await workerRedis.xgroup('DESTROY', 'prototype.commands.v2', commandGroup).catch(() => undefined);
      await workerRedis.xgroup('DESTROY', 'prototype.events.v2', eventGroup).catch(() => undefined);
    }
  }, 20_000);

  it('crosses the real service HTTP boundary before durable waiting projection', async () => {
    const redisUrl = process.env.REDIS_URI!;
    const apiRedis = new Redis(redisUrl);
    const apiEventRedis = new Redis(redisUrl);
    const serviceRedis = new Redis(redisUrl);
    const suffix = new Types.ObjectId().toString();
    const userId = new Types.ObjectId();
    const jobId = `job_${suffix}`;
    const turnId = `turn_${suffix}`;
    const commandId = `command_${suffix}`;
    const attemptId = `attempt_${suffix}`;
    const executionId = `execution_${suffix}`;
    const tenantId = `tenant_${suffix}`;
    const conversationId = `conversation_${suffix}`;
    const originMessageId = `message_${suffix}`;
    const eventGroup = `prototype-http-${suffix}`;
    const command = {
      schemaVersion: 2,
      commandId,
      kind: 'execute_stage',
      jobId,
      turnId,
      tenantId,
      userId: String(userId),
      modelId: 'fake/model',
      expectedRevision: 1,
      attemptId,
      executionId,
      stage: 'generation',
      pipelineStep: 0,
      fenceToken: 2,
      checkpoint: null,
      sourceDigest: null,
      dependencyDigest: null,
      budget: {
        currency: 'USD', maxCostUsd: 1, maxRequests: 1,
        maxInputTokens: 1_000, maxOutputTokens: 1_000,
      },
      createdAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await models.PrototypeJob.create({
      jobId, userId, tenantId, conversationId, originMessageId,
      originToolCallId: `tool_${suffix}`, status: 'queued', waitingReason: null,
      phase: 'generation', modelId: 'fake/model', modelPolicyVersion: 'test',
      modelRecommendation: 'recommended', revision: 1, fenceToken: 2,
      activeCommandId: commandId, activeTurnId: turnId, activeAttemptId: attemptId,
      activeExecutionId: executionId, activeLeaseId: null, activeStage: 'generation',
      pipelineStep: 0, checkpointRevision: null, checkpointDigest: null,
      latestPromptMessageId: null, previewArtifactId: null, previewDigest: null,
      sourcesArtifactId: null, sourcesDigest: null, qaArtifactId: null,
      templateDigest: null, toolchainDigest: null, estimatedCost: null,
      actualCostUsd: 0, failure: null, completedAt: null,
    });
    await models.PrototypeTurn.create({
      turnId, jobId, ordinal: 1, kind: 'initial', sourceMessageId: originMessageId,
      replyToPrototypeMessageId: null, text: 'Build a prototype', modelId: 'fake/model',
      attachmentManifest: [], commandId, executionAttempts: 1, status: 'running', costUsd: 0,
    });

    const transportErrors: Error[] = [];
    const transport = createPrototypeTransportRuntime({
      redis: apiRedis,
      eventRedis: apiEventRedis,
      db: methods,
      startSession: () => mongoose.startSession(),
      loadJob: (event: { jobId: string }, session: unknown) =>
        models.PrototypeJob.findOne({ jobId: event.jobId }, null, { session }).lean(),
      parseEvent: parsePrototypeWorkerEventV2,
      consumerId: `api-http-${suffix}`,
      eventGroup,
      eventBlockMs: 100,
      publisherId: `unused-http-${suffix}`,
      onError: (error: Error) => transportErrors.push(error),
    });
    const app = express();
    app.use(express.json());
    app.use('/internal/prototype-control/v2', createPrototypeControlPlaneRouter({
      authenticateService: async (req: { get(name: string): string | undefined }) =>
        req.get('X-Prototype-Worker') === 'integration-worker',
      registerLease: methods.registerPrototypeLease,
      completeStage: async (event: unknown) => {
        const parsed = parsePrototypeWorkerEventV2(event);
        await serviceRedis.xadd('prototype.events.v2', '*', 'event', JSON.stringify(parsed));
      },
      completeWaiting: async (event: unknown) => {
        const parsed = parsePrototypeWorkerEventV2(event);
        await serviceRedis.xadd('prototype.events.v2', '*', 'event', JSON.stringify(parsed));
      },
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Control plane address unavailable');
    const client = new PrototypeControlPlaneClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      environment: 'test',
      headers: async () => ({ 'X-Prototype-Worker': 'integration-worker' }),
    });
    const supervisor = new OrchestratedStageSupervisor({
      registerLease: (input: unknown) => client.registerLease(input),
      waitForCompletion: async () => ({
        succeeded: true, writersStopped: true, outputRoot: '/projected/output',
      }),
      readResult: async () => ({
        jobId, turnId, commandId, expectedRevision: 1, attemptId, executionId,
        stage: 'generation', pipelineStep: 0, fenceToken: 2, type: 'waiting',
        reason: 'clarification', prompt: 'Which audience should this target?',
        checkpointDigest: `sha256:${'a'.repeat(64)}`,
      }),
      completeStage: (input: unknown) => client.completeStage(input),
      completeWaiting: (input: unknown) => client.completeWaiting(input),
    });
    const commandGroup = `prototype-waiting-restart-${suffix}`;
    const commandSource = new RedisPrototypeCommandSourceV2(serviceRedis, `restarted-${suffix}`, {
      group: commandGroup, blockMs: 100, claimIdleMs: 0,
    });
    const registry = new RedisExecutionRegistry(serviceRedis);
    let pendingCommandStreamId: string | undefined;

    try {
      await serviceRedis.xgroup('CREATE', 'prototype.events.v2', eventGroup, '$', 'MKSTREAM');
      await transport.start();
      await expect(supervisor.prepare(command)).resolves.toBe(deterministicLeaseId(command));
      await expect(supervisor.complete(command)).resolves.toMatchObject({
        reason: 'clarification', checkpoint: { revision: 2 },
      });
      await eventually(async () => {
        if (transportErrors[0]) throw transportErrors[0];
        return (await models.PrototypeJob.findOne({ jobId }).lean())?.status === 'waiting_for_input';
      });
      await expect(models.PrototypeJob.findOne({ jobId }).lean()).resolves.toMatchObject({
        status: 'waiting_for_input', waitingReason: 'clarification', revision: 2,
        checkpointRevision: 2, checkpointDigest: `sha256:${'a'.repeat(64)}`,
        activeLeaseId: null,
      });
      await expect(models.PrototypeEvent.countDocuments({ jobId })).resolves.toBe(1);
      await expect(mongoose.models.Message.findOne({ messageId: { $regex: /^event_/ }, user: String(userId) }).lean())
        .resolves.toMatchObject({
          conversationId, text: 'Which audience should this target?',
          metadata: { sourceEventId: expect.stringMatching(/^event_/) },
        });
      // Recreate a service replica after Mongo accepted the completion but the
      // prior command delivery remained unACKed. Registry survives the replica;
      // the real HTTP lease CAS must fence the old command before it can rerun.
      await registry.claim(command);
      await registry.markScheduled(command);
      await commandSource.ensureGroup();
      await serviceRedis.xgroup('SETID', 'prototype.commands.v2', commandGroup, '$');
      pendingCommandStreamId = await serviceRedis.xadd(
        'prototype.commands.v2', '*', 'command', JSON.stringify(command),
      );
      const originalDelivery = await commandSource.next();
      expect(originalDelivery?.streamId).toBe(pendingCommandStreamId);
      const restartedSource = new RedisPrototypeCommandSourceV2(serviceRedis, `replica-new-${suffix}`, {
        group: commandGroup, blockMs: 100, claimIdleMs: 0,
      });
      const restartedRuntime = new PrototypeOrchestratorRuntime({
        source: restartedSource, supervisor, registry,
        events: new RedisPrototypeEventPublisherV2(serviceRedis),
        scheduler: {
          createExecution: async () => { throw new Error('accepted stage was scheduled twice'); },
        },
        buildJobInput: (input: unknown) => input,
      });
      const reclaimed = await restartedSource.next();
      expect(reclaimed?.streamId).toBe(pendingCommandStreamId);
      await expect(restartedRuntime.handle(reclaimed)).resolves.toEqual({
        accepted: false, reason: 'stale_execution',
      });
      const pending = await serviceRedis.xpending('prototype.commands.v2', commandGroup);
      expect(Number(pending[0])).toBe(0);
      await expect(models.PrototypeJob.findOne({ jobId }).lean()).resolves.toMatchObject({
        status: 'waiting_for_input', revision: 2, checkpointRevision: 2,
      });
      await expect(models.PrototypeEvent.countDocuments({ jobId })).resolves.toBe(1);
      await expect(mongoose.models.Message.countDocuments({ conversationId })).resolves.toBe(1);
    } finally {
      await transport.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await serviceRedis.xgroup('DESTROY', 'prototype.events.v2', eventGroup).catch(() => undefined);
      if (pendingCommandStreamId) await serviceRedis.xdel('prototype.commands.v2', pendingCommandStreamId);
      await serviceRedis.xgroup('DESTROY', 'prototype.commands.v2', commandGroup).catch(() => undefined);
      await serviceRedis.del(registry.key(command), registry.scheduledKey(command));
      serviceRedis.disconnect(false);
      await mongoose.models.Message.deleteMany({ conversationId });
      await models.PrototypeEvent.deleteMany({ jobId });
      await models.PrototypeWorkerEventReceipt.deleteMany({ jobId });
      await models.PrototypeTurn.deleteMany({ jobId });
      await models.PrototypeJob.deleteMany({ jobId });
    }
  }, 20_000);

  it('crosses the service HTTP boundary and creates one durable repair attempt', async () => {
    const redisUrl = process.env.REDIS_URI!;
    const apiRedis = new Redis(redisUrl);
    const apiEventRedis = new Redis(redisUrl);
    const serviceRedis = new Redis(redisUrl);
    const suffix = new Types.ObjectId().toString();
    const userId = new Types.ObjectId();
    const jobId = `job_${suffix}`;
    const turnId = `turn_${suffix}`;
    const commandId = `command_${suffix}`;
    const attemptId = `attempt_${suffix}`;
    const executionId = `execution_${suffix}`;
    const tenantId = `tenant_${suffix}`;
    const eventGroup = `prototype-repair-http-${suffix}`;
    const checkpointDigest = `sha256:${'a'.repeat(64)}`;
    const dependencyDigest = `sha256:${'b'.repeat(64)}`;
    const command = {
      schemaVersion: 2, commandId, kind: 'execute_stage', jobId, turnId, tenantId,
      userId: String(userId), modelId: 'fake/model', expectedRevision: 7,
      attemptId, executionId, stage: 'build_qa', pipelineStep: 4, fenceToken: 8,
      checkpoint: { revision: 3, digest: checkpointDigest },
      sourceDigest: checkpointDigest, dependencyDigest,
      budget: {
        currency: 'USD', maxCostUsd: 1, maxRequests: 4,
        maxInputTokens: 1_000, maxOutputTokens: 1_000,
      },
      createdAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await models.PrototypeJob.create({
      jobId, userId, tenantId, conversationId: `conversation_${suffix}`,
      originMessageId: `message_${suffix}`, originToolCallId: `tool_${suffix}`,
      status: 'queued', waitingReason: null, phase: 'build_qa', modelId: 'fake/model',
      modelPolicyVersion: 'test', modelRecommendation: 'recommended', revision: 7, fenceToken: 8,
      activeCommandId: commandId, activeTurnId: turnId, activeAttemptId: attemptId,
      activeExecutionId: executionId, activeLeaseId: null, activeStage: 'build_qa', pipelineStep: 4,
      checkpointRevision: 3, checkpointDigest, latestPromptMessageId: null,
      previewArtifactId: null, previewDigest: null, sourcesArtifactId: null, sourcesDigest: null,
      qaArtifactId: null, templateDigest: null, toolchainDigest: null,
      estimatedCost: null, actualCostUsd: 0, failure: null, completedAt: null,
    });
    await models.PrototypeTurn.create({
      turnId, jobId, ordinal: 1, kind: 'initial', sourceMessageId: `message_${suffix}`,
      replyToPrototypeMessageId: null, text: 'Build a prototype', modelId: 'fake/model',
      attachmentManifest: [], commandId, executionAttempts: 0, status: 'running', costUsd: 0,
    });
    await models.PrototypeOutbox.create({
      ...command,
      checkpointRevision: 3,
      checkpointDigest,
      attachmentManifest: [],
      status: 'published',
      publishAttempts: 1,
      publishedAt: new Date(),
      lastAttemptAt: new Date(),
    });

    const transportErrors: Error[] = [];
    const transport = createPrototypeTransportRuntime({
      redis: apiRedis, eventRedis: apiEventRedis, db: methods,
      startSession: () => mongoose.startSession(),
      loadJob: (event: { jobId: string }, session: unknown) =>
        models.PrototypeJob.findOne({ jobId: event.jobId }, null, { session }).lean(),
      parseEvent: parsePrototypeWorkerEventV2,
      consumerId: `api-repair-http-${suffix}`, eventGroup, eventBlockMs: 100,
      publisherId: `unused-repair-http-${suffix}`,
      onError: (error: Error) => transportErrors.push(error),
    });
    const publish = async (event: unknown) => {
      const parsed = parsePrototypeWorkerEventV2(event);
      await serviceRedis.xadd('prototype.events.v2', '*', 'event', JSON.stringify(parsed));
    };
    const app = express();
    app.use(express.json());
    app.use('/internal/prototype-control/v2', createPrototypeControlPlaneRouter({
      authenticateService: async (req: { get(name: string): string | undefined }) =>
        req.get('X-Prototype-Worker') === 'integration-worker',
      registerLease: methods.registerPrototypeLease,
      completeStage: publish,
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Control plane address unavailable');
    const client = new PrototypeControlPlaneClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      environment: 'test',
      headers: async () => ({ 'X-Prototype-Worker': 'integration-worker' }),
    });
    const supervisor = new OrchestratedStageSupervisor({
      registerLease: (input: unknown) => client.registerLease(input),
      waitForCompletion: async () => ({
        succeeded: false, writersStopped: true, outputRoot: '/projected/output',
      }),
      readFailure: async () => ({
        jobId, turnId, commandId, expectedRevision: 7, attemptId, executionId,
        stage: 'build_qa', pipelineStep: 4, fenceToken: 8,
        leaseId: deterministicLeaseId(command), code: 'PROTOTYPE_BUILD_FAILED',
        message: 'Offline build failed.', retryable: true,
        diagnostics: ['src/app.tsx: type mismatch'],
      }),
      completeStage: (input: unknown) => client.completeStage(input),
      failStage: (input: unknown) => client.failStage(input),
    });

    try {
      await serviceRedis.xgroup('CREATE', 'prototype.events.v2', eventGroup, '$', 'MKSTREAM');
      await transport.start();
      await supervisor.prepare(command);
      await expect(supervisor.complete(command)).resolves.toMatchObject({
        code: 'PROTOTYPE_BUILD_FAILED', retryable: true,
      });
      await eventually(async () => {
        if (transportErrors[0]) throw transportErrors[0];
        return (await models.PrototypeJob.findOne({ jobId }).lean())?.activeStage === 'generation';
      });
      const repairedJob = await models.PrototypeJob.findOne({ jobId }).lean();
      expect(repairedJob).toMatchObject({
        status: 'running', revision: 8, fenceToken: 9,
        activeStage: 'generation', pipelineStep: 0, activeLeaseId: null, failure: null,
      });
      const repair = await models.PrototypeOutbox.findOne({
        jobId, commandId: { $ne: commandId },
      }).lean();
      expect(repair).toMatchObject({
        stage: 'generation', pipelineStep: 0, expectedRevision: 8,
        dependencyDigest, repair: {
          ordinal: 1, diagnostics: ['src/app.tsx: type mismatch'],
        },
      });
      await expect(models.PrototypeTurn.findOne({ turnId }).lean()).resolves.toMatchObject({
        executionAttempts: 1,
      });
      await expect(models.PrototypeWorkerEventReceipt.countDocuments({ jobId })).resolves.toBe(1);
    } finally {
      await transport.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await serviceRedis.xgroup('DESTROY', 'prototype.events.v2', eventGroup).catch(() => undefined);
      serviceRedis.disconnect(false);
      await models.PrototypeEvent.deleteMany({ jobId });
      await models.PrototypeWorkerEventReceipt.deleteMany({ jobId });
      await models.PrototypeOutbox.deleteMany({ jobId });
      await models.PrototypeTurn.deleteMany({ jobId });
      await models.PrototypeJob.deleteMany({ jobId });
    }
  }, 20_000);
});
