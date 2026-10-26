import mongoose, { Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import type { PrototypeCardData, PrototypeJobStatus } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IPrototypeOutbox, IPrototypeTurn } from '~/types';
import { createModels } from '~/models';
import {
  PrototypeDomainError,
  createPrototypeMethods,
  type CreatePrototypeJobInput,
} from './prototype';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createPrototypeMethods>;
let models: ReturnType<typeof createModels>;

const userId = new Types.ObjectId();

function job(overrides: Partial<CreatePrototypeJobInput> = {}): CreatePrototypeJobInput {
  return {
    jobId: `job-${new Types.ObjectId()}`,
    userId,
    tenantId: 'tenant-1',
    conversationId: `conversation-${new Types.ObjectId()}`,
    originMessageId: `message-${new Types.ObjectId()}`,
    originToolCallId: `tool-${new Types.ObjectId()}`,
    status: 'queued',
    waitingReason: null,
    phase: null,
    modelId: 'openai/gpt-5',
    modelPolicyVersion: 'v1',
    modelRecommendation: 'recommended',
    revision: 0,
    eventSequence: 0,
    fenceToken: 0,
    activeCommandId: null,
    activeTurnId: null,
    activeAttemptId: null,
    activeExecutionId: null,
    activeLeaseId: null,
    activeStage: null,
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
    activity: [],
    versions: [],
    accessRevokedAt: null,
    cleanupStatus: 'none',
    cleanupAttempts: 0,
    cleanupNextAttemptAt: null,
    completedAt: null,
    ...overrides,
  };
}

function turn(jobId: string, overrides: Partial<IPrototypeTurn> = {}): IPrototypeTurn {
  return {
    turnId: `turn-${new Types.ObjectId()}`,
    jobId,
    ordinal: 1,
    kind: 'user_reply',
    sourceMessageId: `message-${new Types.ObjectId()}`,
    replyToPrototypeMessageId: 'prototype-prompt-1',
    text: 'Make the header smaller',
    modelId: 'openai/gpt-5',
    attachmentManifest: [],
    commandId: `command-${new Types.ObjectId()}`,
    executionAttempts: 0,
    status: 'pending',
    costUsd: 0,
    ...overrides,
  };
}

function outbox(jobId: string, commandId: string, turnId: string): IPrototypeOutbox {
  return {
    schemaVersion: 1,
    commandId,
    kind: 'start_turn',
    jobId,
    turnId,
    tenantId: 'tenant-1',
    modelId: 'openai/gpt-5',
    expectedRevision: 1,
    executionId: `execution-${new Types.ObjectId()}`,
    checkpointRevision: null,
    attachmentManifest: [],
    status: 'pending',
    publishAttempts: 0,
    publishedAt: null,
    lastAttemptAt: null,
  };
}

function card(jobId: string, status: PrototypeJobStatus): PrototypeCardData {
  return {
    type: 'prototype',
    jobId,
    conversationId: 'conversation-1',
    turnId: null,
    revision: 0,
    cursor: 0,
    status,
    phase: null,
    waitingReason: null,
    promptMessageId: null,
    modelId: 'openai/gpt-5',
    modelWarning: null,
    prototypeName: null,
    previewAvailable: false,
    sourcesAvailable: false,
    failure: null,
    activity: [],
    versions: [],
    actions: {
      approve: false,
      cancel: !['completed', 'failed', 'canceled'].includes(status),
      retry: status === 'failed',
      finalize: status === 'review',
      reply: status === 'waiting_for_input' || status === 'review',
    },
    canCancel: !['completed', 'failed', 'canceled'].includes(status),
    canReply: status === 'waiting_for_input' || status === 'review',
    estimatedCost: null,
    actualCostUsd: 0,
  };
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  models = createModels(mongoose);
  methods = createPrototypeMethods(mongoose);
  await Promise.all([
    models.PrototypeJob.syncIndexes(),
    models.PrototypeTurn.syncIndexes(),
    models.PrototypeEvent.syncIndexes(),
    models.PrototypeOutbox.syncIndexes(),
    models.PrototypeWorkerEventReceipt.syncIndexes(),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await Promise.all([
    models.PrototypeJob.deleteMany({}),
    models.PrototypeTurn.deleteMany({}),
    models.PrototypeEvent.deleteMany({}),
    models.PrototypeOutbox.deleteMany({}),
    models.PrototypeWorkerEventReceipt.deleteMany({}),
  ]);
});

describe('prototype state machine', () => {
  it.each<[PrototypeJobStatus, PrototypeJobStatus]>([
    ['queued', 'preparing'],
    ['preparing', 'running'],
    ['running', 'waiting_for_input'],
    ['running', 'review'],
    ['running', 'completed'],
    ['waiting_for_input', 'queued'],
    ['review', 'queued'],
    ['review', 'completed'],
    ['waiting_for_credentials', 'queued'],
    ['waiting_for_funds', 'queued'],
  ])('allows %s -> %s and increments revision', async (from, to) => {
    const input = job({ status: from, revision: 4 });
    await models.PrototypeJob.create(input);

    const updated = await methods.transitionPrototypeJob({
      jobId: input.jobId,
      expectedRevision: 4,
      from,
      to,
      patch: {},
    });

    expect(updated.status).toBe(to);
    expect(updated.revision).toBe(5);
  });

  it.each<PrototypeJobStatus>(['completed', 'failed', 'canceled'])(
    'rejects transitions from terminal state %s',
    async (from) => {
      const input = job({ status: from });
      await models.PrototypeJob.create(input);

      await expect(
        methods.transitionPrototypeJob({
          jobId: input.jobId,
          expectedRevision: 0,
          from,
          to: 'queued',
          patch: {},
        }),
      ).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_STATE' });
    },
  );

  it.each<[PrototypeJobStatus, PrototypeJobStatus]>(
    (['queued', 'preparing', 'running', 'waiting_for_input', 'review'] as const).flatMap((from) =>
      (['waiting_for_credentials', 'waiting_for_funds', 'failed', 'canceled'] as const).map(
        (to): [PrototypeJobStatus, PrototypeJobStatus] => [from, to],
      ),
    ),
  )('allows active source %s to pause or terminate as %s', async (from, to) => {
    const input = job({ status: from });
    await models.PrototypeJob.create(input);

    await expect(
      methods.transitionPrototypeJob({
        jobId: input.jobId,
        expectedRevision: 0,
        from,
        to,
        patch: {},
      }),
    ).resolves.toMatchObject({ status: to, revision: 1 });
  });

  it('rejects stale revisions and permits only one concurrent CAS writer', async () => {
    const input = job({ status: 'queued' });
    await models.PrototypeJob.create(input);

    const results = await Promise.allSettled([
      methods.transitionPrototypeJob({
        jobId: input.jobId,
        expectedRevision: 0,
        from: 'queued',
        to: 'preparing',
        patch: {},
      }),
      methods.transitionPrototypeJob({
        jobId: input.jobId,
        expectedRevision: 0,
        from: 'queued',
        to: 'preparing',
        patch: {},
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find(
      (result) => result.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ code: 'PROTOTYPE_STALE_REVISION' });
  });

  it('includes activeExecutionId in worker-owned compare-and-set updates', async () => {
    const input = job({ status: 'running', activeExecutionId: 'execution-current' });
    await models.PrototypeJob.create(input);

    await expect(
      methods.transitionPrototypeJob({
        jobId: input.jobId,
        expectedRevision: 0,
        from: 'running',
        to: 'completed',
        patch: {},
        executionId: 'execution-stale',
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_STALE_REVISION' });
    expect(await models.PrototypeJob.findOne({ jobId: input.jobId }).lean()).toMatchObject({
      status: 'running',
      revision: 0,
    });
  });

  it('registers only one lease for the active attempt, execution, revision, and fence', async () => {
    const input = job({
      status: 'preparing',
      fenceToken: 2,
      activeTurnId: 'turn-current',
      activeCommandId: 'command-current',
      activeAttemptId: 'attempt-current',
      activeExecutionId: 'execution-current',
      activeStage: 'generation',
    });
    await models.PrototypeJob.create(input);

    const results = await Promise.allSettled([
      methods.registerPrototypeLease({
        jobId: input.jobId,
        turnId: 'turn-current',
        commandId: 'command-current',
        expectedRevision: 0,
        attemptId: 'attempt-current',
        executionId: 'execution-current',
        stage: 'generation',
        leaseId: 'lease-a',
        fenceToken: 2,
      }),
      methods.registerPrototypeLease({
        jobId: input.jobId,
        turnId: 'turn-current',
        commandId: 'command-current',
        expectedRevision: 0,
        attemptId: 'attempt-current',
        executionId: 'execution-current',
        stage: 'generation',
        leaseId: 'lease-b',
        fenceToken: 2,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await models.PrototypeJob.findOne({ jobId: input.jobId }).lean()).toMatchObject({
      status: 'running',
      activeLeaseId: expect.stringMatching(/^lease-[ab]$/),
    });
  });

  it('activates the initial queued command without changing its command revision', async () => {
    const input = job({
      status: 'queued', revision: 0, fenceToken: 1,
      activeTurnId: 'turn-current', activeCommandId: 'command-current',
      activeAttemptId: 'attempt-current', activeExecutionId: 'execution-current',
      activeStage: 'generation',
    });
    await models.PrototypeJob.create(input);
    await expect(methods.registerPrototypeLease({
      jobId: input.jobId, turnId: 'turn-current', commandId: 'command-current',
      expectedRevision: 0, attemptId: 'attempt-current', executionId: 'execution-current',
      stage: 'generation', leaseId: 'lease-current', fenceToken: 1,
    })).resolves.toMatchObject({ status: 'running', revision: 0, activeLeaseId: 'lease-current' });
  });

  it('applies progress, checkpoint, and usage only for the full active execution tuple', async () => {
    const input = job({
      status: 'running', revision: 2, fenceToken: 4,
      activeTurnId: 'turn-current', activeCommandId: 'command-current',
      activeAttemptId: 'attempt-current', activeExecutionId: 'execution-current',
      activeStage: 'generation', activeLeaseId: 'lease-current', actualCostUsd: 0.1,
    });
    await models.PrototypeJob.create(input);
    const identity = {
      jobId: input.jobId, turnId: 'turn-current', commandId: 'command-current',
      expectedRevision: 2, attemptId: 'attempt-current', executionId: 'execution-current',
      stage: 'generation' as const, fenceToken: 4, leaseId: 'lease-current',
    };
    await expect(methods.updatePrototypeExecution({
      ...identity, phase: 'Generating files', checkpointRevision: 3,
      checkpointDigest: `sha256:${'a'.repeat(64)}`, actualCostDelta: 0.25,
    })).resolves.toMatchObject({
      revision: 2, phase: 'Generating files', checkpointRevision: 3, actualCostUsd: 0.35,
    });
    await expect(methods.updatePrototypeExecution({
      ...identity, attemptId: 'attempt-stale', phase: 'stale',
    })).rejects.toMatchObject({ code: 'PROTOTYPE_STALE_REVISION' });
  });

  it('finishes a running execution once and clears its live lease without losing the tuple', async () => {
    const input = job({
      status: 'running', revision: 5, fenceToken: 6,
      activeTurnId: 'turn-current', activeCommandId: 'command-current',
      activeAttemptId: 'attempt-current', activeExecutionId: 'execution-current',
      activeStage: 'generation', activeLeaseId: 'lease-current',
    });
    await models.PrototypeJob.create(input);
    const identity = {
      jobId: input.jobId, turnId: 'turn-current', commandId: 'command-current',
      expectedRevision: 5, attemptId: 'attempt-current', executionId: 'execution-current',
      stage: 'generation' as const, fenceToken: 6, leaseId: 'lease-current',
    };
    await expect(methods.finishPrototypeExecution({
      ...identity, to: 'waiting_for_input', waitingReason: 'clarification',
      latestPromptMessageId: 'event_prompt_1', checkpointRevision: 4,
      checkpointDigest: `sha256:${'b'.repeat(64)}`,
    })).resolves.toMatchObject({
      status: 'waiting_for_input', revision: 6, activeLeaseId: null, activeStage: null,
      latestPromptMessageId: 'event_prompt_1', waitingReason: 'clarification',
    });
    await expect(methods.finishPrototypeExecution({
      ...identity, to: 'failed', failure: { code: 'PROTOTYPE_EXECUTION_FAILED', message: 'Failed' },
    })).rejects.toMatchObject({ code: 'PROTOTYPE_STALE_REVISION' });
  });

  it('rejects a lease registered with a stale fence token', async () => {
    const input = job({
      status: 'running',
      fenceToken: 3,
      activeTurnId: 'turn-current',
      activeCommandId: 'command-current',
      activeAttemptId: 'attempt-current',
      activeExecutionId: 'execution-current',
      activeStage: 'generation',
    });
    await models.PrototypeJob.create(input);

    await expect(
      methods.registerPrototypeLease({
        jobId: input.jobId,
        turnId: 'turn-current',
        commandId: 'command-current',
        expectedRevision: 0,
        attemptId: 'attempt-current',
        executionId: 'execution-current',
        stage: 'generation',
        leaseId: 'lease-stale',
        fenceToken: 2,
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_STALE_REVISION' });
  });

  it('accepts digest-bound publication only for the current publish identity', async () => {
    const input = job({
      status: 'running',
      fenceToken: 4,
      activeAttemptId: 'attempt-current',
      activeExecutionId: 'execution-current',
      activeLeaseId: 'lease-current',
      activeStage: 'publish',
    });
    await models.PrototypeJob.create(input);
    const previewArtifactId = new Types.ObjectId();
    const sourcesArtifactId = new Types.ObjectId();
    const qaArtifactId = new Types.ObjectId();
    const digest = (character: string) => `sha256:${character.repeat(64)}`;

    await expect(methods.acceptPrototypePublication({
      jobId: input.jobId,
      expectedRevision: 0,
      fenceToken: 4,
      attemptId: 'attempt-current',
      executionId: 'execution-current',
      leaseId: 'lease-current',
      to: 'review',
      checkpointRevision: 1,
      checkpointDigest: digest('a'),
      previewArtifactId,
      previewDigest: digest('b'),
      sourcesArtifactId,
      sourcesDigest: digest('c'),
      qaArtifactId,
      templateDigest: digest('d'),
      toolchainDigest: digest('e'),
    })).resolves.toMatchObject({
      status: 'review',
      revision: 1,
      checkpointDigest: digest('a'),
      previewDigest: digest('b'),
      sourcesDigest: digest('c'),
      activeLeaseId: null,
      activeStage: null,
    });
  });

  it('rejects publication from a stale lease or fence', async () => {
    const input = job({
      status: 'running',
      fenceToken: 5,
      activeAttemptId: 'attempt-current',
      activeExecutionId: 'execution-current',
      activeLeaseId: 'lease-current',
      activeStage: 'publish',
    });
    await models.PrototypeJob.create(input);
    const digest = `sha256:${'a'.repeat(64)}`;
    await expect(methods.acceptPrototypePublication({
      jobId: input.jobId,
      expectedRevision: 0,
      fenceToken: 4,
      attemptId: 'attempt-current',
      executionId: 'execution-current',
      leaseId: 'lease-stale',
      to: 'review',
      checkpointRevision: 1,
      checkpointDigest: digest,
      previewArtifactId: new Types.ObjectId(),
      previewDigest: digest,
      sourcesArtifactId: new Types.ObjectId(),
      sourcesDigest: digest,
      qaArtifactId: new Types.ObjectId(),
      templateDigest: digest,
      toolchainDigest: digest,
    })).rejects.toMatchObject({ code: 'PROTOTYPE_STALE_REVISION' });
  });

  it('does not let callers patch status or revision around the state machine', async () => {
    const input = job({ status: 'queued' });
    await models.PrototypeJob.create(input);

    await expect(
      methods.transitionPrototypeJob({
        jobId: input.jobId,
        expectedRevision: 0,
        from: 'queued',
        to: 'preparing',
        patch: { status: 'completed', revision: 99 } as never,
      }),
    ).rejects.toBeInstanceOf(PrototypeDomainError);
  });
});

describe('prototype persistence methods', () => {
  it('returns the existing job for duplicate origin tool calls, including concurrent calls', async () => {
    const input = job();
    const results = await Promise.all([
      methods.createPrototypeJob(input),
      methods.createPrototypeJob({ ...input, jobId: `job-${new Types.ObjectId()}` }),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].job.jobId).toBe(results[1].job.jobId);
    expect(
      await models.PrototypeJob.countDocuments({ originToolCallId: input.originToolCallId }),
    ).toBe(1);
  });

  it('allows the same origin tool call id for independent tenants', async () => {
    const first = job({ tenantId: 'tenant-a', originToolCallId: 'shared-origin' });
    const second = job({
      jobId: `job-${new Types.ObjectId()}`,
      userId: new Types.ObjectId(),
      tenantId: 'tenant-b',
      conversationId: 'conversation-b',
      originMessageId: 'message-b',
      originToolCallId: 'shared-origin',
    });

    await expect(methods.createPrototypeJob(first)).resolves.toMatchObject({ created: true });
    await expect(methods.createPrototypeJob(second)).resolves.toMatchObject({ created: true });
    await expect(
      models.PrototypeJob.countDocuments({ originToolCallId: 'shared-origin' }),
    ).resolves.toBe(2);
  });

  it('scopes reads by user and tenant ownership', async () => {
    const input = job();
    await models.PrototypeJob.create(input);

    await expect(
      methods.getOwnedPrototypeJob({ jobId: input.jobId, userId, tenantId: input.tenantId }),
    ).resolves.toMatchObject({ jobId: input.jobId });
    await expect(
      methods.getOwnedPrototypeJob({
        jobId: input.jobId,
        userId: new Types.ObjectId(),
        tenantId: input.tenantId,
      }),
    ).resolves.toBeNull();
  });

  it('atomically claims a reply once and rejects concurrent duplicates', async () => {
    const input = job({
      status: 'waiting_for_input',
      waitingReason: 'clarification',
      latestPromptMessageId: 'prototype-prompt-1',
    });
    await models.PrototypeJob.create(input);
    const replyTurn = turn(input.jobId, { sourceMessageId: 'reply-message-1' });

    const session = { inTransaction: () => true } as unknown as ClientSession;
    const originalFindOneAndUpdate = models.PrototypeJob.findOneAndUpdate.bind(models.PrototypeJob);
    const originalTurnCreate = models.PrototypeTurn.create.bind(models.PrototypeTurn);
    const originalFindOne = models.PrototypeJob.findOne.bind(models.PrototypeJob);
    jest
      .spyOn(models.PrototypeJob, 'findOneAndUpdate')
      .mockImplementation(
        (filter, update, options) =>
          originalFindOneAndUpdate(filter, update, { ...options, session: undefined }) as never,
      );
    jest
      .spyOn(models.PrototypeTurn, 'create')
      .mockImplementation((docs) => originalTurnCreate(docs) as never);
    (jest.spyOn(models.PrototypeJob, 'findOne') as jest.MockInstance<any, any>).mockImplementation(
      (filter: unknown, projection?: unknown) =>
        originalFindOne(filter as never, projection as never) as never,
    );
    try {
      const first = await methods.claimPrototypeReply(
        {
          jobId: input.jobId,
          expectedRevision: 0,
          replyToPrototypeMessageId: 'prototype-prompt-1',
          turn: replyTurn,
        },
        session,
      );
      expect(first.job).toMatchObject({ status: 'queued', revision: 1 });

      await expect(
        methods.claimPrototypeReply(
          {
            jobId: input.jobId,
            expectedRevision: 0,
            replyToPrototypeMessageId: 'prototype-prompt-1',
            turn: replyTurn,
          },
          session,
        ),
      ).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_STATE' });
    } finally {
      jest.restoreAllMocks();
    }
    expect(await models.PrototypeTurn.countDocuments({ jobId: input.jobId })).toBe(1);
  });

  it('rejects a session that is not in a transaction before applying the reply CAS', async () => {
    const input = job({
      status: 'review',
      waitingReason: 'plan_approval',
      latestPromptMessageId: 'prototype-prompt-1',
    });
    await models.PrototypeJob.create(input);
    const session = await mongoose.startSession();

    await expect(
      methods.claimPrototypeReply(
        {
          jobId: input.jobId,
          expectedRevision: 0,
          replyToPrototypeMessageId: 'prototype-prompt-1',
          turn: turn(input.jobId),
        },
        session,
      ),
    ).rejects.toThrow('active MongoDB transaction');
    await session.endSession();

    expect(await models.PrototypeJob.findOne({ jobId: input.jobId }).lean()).toMatchObject({
      status: 'review',
      revision: 0,
    });
    expect(await models.PrototypeTurn.countDocuments({ jobId: input.jobId })).toBe(0);
  });

  it('uses nonthrowing upserts for transaction-bound idempotent creates', async () => {
    const input = job();
    const eventInput = {
      jobId: input.jobId,
      eventId: 1,
      revision: 0,
      type: 'job_state' as const,
      publicPayload: card(input.jobId, 'queued'),
    };
    const command = outbox(input.jobId, 'command-transaction', 'turn-transaction');
    const session = { inTransaction: () => true } as unknown as ClientSession;
    const jobUpdate = jest.spyOn(models.PrototypeJob, 'findOneAndUpdate').mockResolvedValueOnce({
      value: input,
      lastErrorObject: { upserted: new Types.ObjectId() },
      ok: 1,
    } as never);
    const eventUpdate = jest
      .spyOn(models.PrototypeEvent, 'findOneAndUpdate')
      .mockResolvedValueOnce(eventInput as never);
    const outboxUpdate = jest
      .spyOn(models.PrototypeOutbox, 'findOneAndUpdate')
      .mockResolvedValueOnce(command as never);

    await expect(methods.createPrototypeJob(input, session)).resolves.toMatchObject({
      created: true,
    });
    await expect(methods.appendPrototypeEvent(eventInput, session)).resolves.toMatchObject({
      eventId: 1,
    });
    await expect(methods.enqueuePrototypeOutbox(command, session)).resolves.toMatchObject({
      commandId: command.commandId,
    });

    expect(jobUpdate).toHaveBeenCalledWith(
      {
        tenantId: input.tenantId,
        userId: input.userId,
        originToolCallId: input.originToolCallId,
      },
      { $setOnInsert: input },
      expect.objectContaining({ upsert: true, session, includeResultMetadata: true }),
    );
    expect(eventUpdate).toHaveBeenCalledWith(
      { jobId: eventInput.jobId, eventId: eventInput.eventId },
      { $setOnInsert: { ...eventInput, sourceEventId: 'transition:1' } },
      expect.objectContaining({ upsert: true, session }),
    );
    expect(outboxUpdate).toHaveBeenCalledWith(
      { commandId: command.commandId },
      { $setOnInsert: command },
      expect.objectContaining({ upsert: true, session }),
    );
    jest.restoreAllMocks();
  });

  it('idempotently appends events and outbox commands', async () => {
    const input = job();
    await models.PrototypeJob.create(input);
    const eventInput = {
      jobId: input.jobId,
      eventId: 1,
      revision: 0,
      type: 'job_state' as const,
      publicPayload: card(input.jobId, 'queued'),
    };
    const command = outbox(input.jobId, 'command-1', 'turn-1');

    const [eventA, eventB] = await Promise.all([
      methods.appendPrototypeEvent(eventInput),
      methods.appendPrototypeEvent(eventInput),
    ]);
    const [commandA, commandB] = await Promise.all([
      methods.enqueuePrototypeOutbox(command),
      methods.enqueuePrototypeOutbox(command),
    ]);

    expect(eventA.eventId).toBe(eventB.eventId);
    expect(commandA.commandId).toBe(commandB.commandId);
    expect(await models.PrototypeEvent.countDocuments({ jobId: input.jobId })).toBe(1);
    expect(await models.PrototypeOutbox.countDocuments({ jobId: input.jobId })).toBe(1);
  });

  it('leases outbox publication atomically and reclaims only expired claims', async () => {
    const input = job();
    const command = outbox(input.jobId, 'command-lease', 'turn-lease');
    await models.PrototypeOutbox.create(command);
    const now = new Date('2026-09-24T10:00:00.000Z');

    await expect(methods.claimPrototypeOutbox({ publisherId: 'api-a', now, leaseMs: 30_000 }))
      .resolves.toMatchObject({
        commandId: command.commandId, status: 'publishing', publisherId: 'api-a', publishAttempts: 1,
      });
    await expect(methods.claimPrototypeOutbox({ publisherId: 'api-b', now, leaseMs: 30_000 }))
      .resolves.toBeNull();

    const reclaimedAt = new Date(now.getTime() + 30_001);
    await expect(methods.claimPrototypeOutbox({ publisherId: 'api-b', now: reclaimedAt, leaseMs: 30_000 }))
      .resolves.toMatchObject({ publisherId: 'api-b', publishAttempts: 2 });
    await expect(methods.markPrototypeOutboxPublished(command.commandId, 'api-a'))
      .rejects.toThrow('claim is stale');
    await expect(methods.markPrototypeOutboxPublished(command.commandId, 'api-b', reclaimedAt))
      .resolves.toMatchObject({ status: 'published', publishedAt: reclaimedAt });
  });

  it('releases a live outbox claim for immediate retry after a handled publish failure', async () => {
    const input = job();
    const command = outbox(input.jobId, 'command-release', 'turn-release');
    await models.PrototypeOutbox.create(command);
    const now = new Date('2026-09-24T10:00:00.000Z');
    await methods.claimPrototypeOutbox({ publisherId: 'api-a', now, leaseMs: 30_000 });
    await expect(methods.releasePrototypeOutboxClaim(command.commandId, 'api-a')).resolves.toBe(true);
    await expect(methods.claimPrototypeOutbox({ publisherId: 'api-b', now, leaseMs: 30_000 }))
      .resolves.toMatchObject({ publisherId: 'api-b', publishAttempts: 2 });
  });

  it('reconciles only expired outbox claims after an API crash', async () => {
    const input = job();
    const now = new Date('2026-09-24T10:00:00.000Z');
    await models.PrototypeOutbox.create([
      {
        ...outbox(input.jobId, 'command-expired', 'turn-1'), status: 'publishing',
        publisherId: 'api-dead', claimExpiresAt: new Date(now.getTime() - 1),
      },
      {
        ...outbox(input.jobId, 'command-live', 'turn-2'), status: 'publishing',
        publisherId: 'api-live', claimExpiresAt: new Date(now.getTime() + 30_000),
      },
    ]);
    await expect(methods.reconcilePrototypeOutboxClaims(now)).resolves.toBe(1);
    const expired = await models.PrototypeOutbox.findOne({ commandId: 'command-expired' }).lean();
    expect(expired).toMatchObject({ status: 'pending' });
    expect(expired).not.toHaveProperty('publisherId');
    expect(expired).not.toHaveProperty('claimExpiresAt');
    await expect(models.PrototypeOutbox.findOne({ commandId: 'command-live' }).lean())
      .resolves.toMatchObject({ status: 'publishing', publisherId: 'api-live' });
  });

  it('claims an exact worker event receipt inside the state transaction', async () => {
    const receipt = {
      eventId: 'event_1', jobId: 'job-1', commandId: 'command-1', payloadType: 'waiting',
      payloadDigest: `sha256:${'a'.repeat(64)}`,
    };
    const session = { inTransaction: () => true } as unknown as ClientSession;
    const update = jest.spyOn(models.PrototypeWorkerEventReceipt, 'findOneAndUpdate')
      .mockResolvedValueOnce({
        value: receipt, lastErrorObject: { upserted: new Types.ObjectId() }, ok: 1,
      } as never)
      .mockResolvedValueOnce({ value: receipt, lastErrorObject: {}, ok: 1 } as never);
    await expect(methods.claimPrototypeWorkerEvent(receipt, session)).resolves.toMatchObject({
      created: true, receipt,
    });
    await expect(methods.claimPrototypeWorkerEvent(receipt, session)).resolves.toMatchObject({
      created: false, receipt,
    });
    expect(update).toHaveBeenCalledWith(
      { eventId: receipt.eventId }, { $setOnInsert: receipt },
      expect.objectContaining({ upsert: true, session, includeResultMetadata: true }),
    );
    jest.restoreAllMocks();
  });

  it('revokes access before lease-based cleanup and reclaims a crashed cleanup attempt', async () => {
    const input = job();
    await models.PrototypeJob.create(input);
    const now = new Date('2026-09-28T00:00:00.000Z');
    await expect(methods.revokePrototypeConversation({
      conversationId: input.conversationId,
      userId: String(input.userId),
      tenantId: input.tenantId,
      now,
    })).resolves.toMatchObject({
      jobId: input.jobId,
      cleanupStatus: 'pending',
      accessRevokedAt: now,
    });

    await expect(methods.claimPrototypeCleanup({ now, leaseMs: 1_000 })).resolves.toMatchObject({
      jobId: input.jobId,
      cleanupStatus: 'running',
      cleanupAttempts: 1,
    });
    await expect(
      methods.claimPrototypeCleanup({ now: new Date(now.getTime() + 500), leaseMs: 1_000 }),
    ).resolves.toBeNull();
    await expect(
      methods.claimPrototypeCleanup({ now: new Date(now.getTime() + 1_001), leaseMs: 1_000 }),
    ).resolves.toMatchObject({ cleanupStatus: 'running', cleanupAttempts: 2 });
    await expect(methods.completePrototypeCleanup(input.jobId)).resolves.toBe(true);
  });

  it('revokes every active Prototype job before bulk conversation deletion', async () => {
    const first = job({ jobId: 'job_bulk_1', conversationId: 'conversation-bulk-1' });
    const second = job({ jobId: 'job_bulk_2', conversationId: 'conversation-bulk-2' });
    await models.PrototypeJob.create([first, second]);
    const now = new Date('2026-09-28T01:00:00.000Z');

    await expect(methods.revokePrototypeUserConversations({
      userId: String(first.userId),
      tenantId: first.tenantId,
      now,
    })).resolves.toBe(2);

    const revoked = await models.PrototypeJob.find({ jobId: { $in: [first.jobId, second.jobId] } })
      .sort({ jobId: 1 })
      .lean();
    expect(revoked).toHaveLength(2);
    expect(revoked).toEqual(expect.arrayContaining([
      expect.objectContaining({ cleanupStatus: 'pending', accessRevokedAt: now }),
      expect.objectContaining({ cleanupStatus: 'pending', accessRevokedAt: now }),
    ]));
  });
});
