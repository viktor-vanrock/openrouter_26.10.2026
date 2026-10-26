import { model, Types } from 'mongoose';
import {
  PROTOTYPE_ACTIVE_STATUSES,
  PROTOTYPE_TERMINAL_STATUSES,
  prototypeArtifactSchema,
  prototypeEventSchema,
  prototypeJobSchema,
  prototypeOutboxSchema,
  prototypeTurnSchema,
  prototypeWorkerEventReceiptSchema,
} from './index';

const PUBLIC_JOB_STATUSES = [
  'queued',
  'preparing',
  'running',
  'waiting_for_input',
  'review',
  'waiting_for_credentials',
  'waiting_for_funds',
  'completed',
  'failed',
  'canceled',
] as const;

const objectId = new Types.ObjectId();
const Job = model(`PrototypeJobSchemaTest_${objectId}`, prototypeJobSchema);
const Event = model(`PrototypeEventSchemaTest_${objectId}`, prototypeEventSchema);
const Artifact = model(`PrototypeArtifactSchemaTest_${objectId}`, prototypeArtifactSchema);
const Outbox = model(`PrototypeOutboxSchemaTest_${objectId}`, prototypeOutboxSchema);
const WorkerEventReceipt = model(
  `PrototypeWorkerEventReceiptSchemaTest_${objectId}`,
  prototypeWorkerEventReceiptSchema,
);

const validJob = {
  jobId: 'job_1',
  userId: objectId,
  tenantId: 'tenant_1',
  conversationId: 'conversation_1',
  originMessageId: 'message_1',
  originToolCallId: 'tool_call_1',
  status: 'queued',
  waitingReason: null,
  phase: null,
  modelId: 'openai/gpt-5',
  modelPolicyVersion: '2026-09-08.1',
  modelRecommendation: 'recommended',
  revision: 0,
  fenceToken: 0,
  activeCommandId: 'command_1',
  activeTurnId: 'turn_1',
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
  completedAt: null,
};

describe('prototype persistence schemas', () => {
  it('keeps generation binding additive and rejects an engine/profile mismatch', () => {
    expect(new Job(validJob).generation).toBeUndefined();
    const generation = {
      schemaVersion: 1,
      engineId: 'direct-react-v1',
      sourceProfile: 'react-source-v1',
      rulesDigest: `sha256:${'a'.repeat(64)}`,
      templateDigest: `sha256:${'b'.repeat(64)}`,
      toolchainDigest: `sha256:${'c'.repeat(64)}`,
    };
    expect(new Job({ ...validJob, generation }).validateSync()).toBeUndefined();
    expect(
      new Job({
        ...validJob,
        generation: { ...generation, engineId: 'opencode-fsd-v1' },
      }).validateSync(),
    ).toBeDefined();
    expect(
      new Job({ ...validJob, generation: { ...generation, arbitrary: 'denied' } }).validateSync(),
    ).toBeDefined();
  });
  it('uses every public status and enforces one job for the conversation lifetime', () => {
    expect(PROTOTYPE_TERMINAL_STATUSES).toEqual(['completed', 'failed', 'canceled']);
    expect(PROTOTYPE_ACTIVE_STATUSES).toEqual(
      PUBLIC_JOB_STATUSES.filter(
        (status) => !(PROTOTYPE_TERMINAL_STATUSES as readonly string[]).includes(status),
      ),
    );
    expect(prototypeJobSchema.indexes()).toContainEqual([
      { tenantId: 1, conversationId: 1 },
      expect.objectContaining({
        unique: true,
        name: 'prototype_conversation_lifetime_unique',
      }),
    ]);
  });

  it.each(PUBLIC_JOB_STATUSES)('accepts public job status %s', (status) => {
    const document = new Job({ ...validJob, status });
    expect(document.validateSync()).toBeUndefined();
  });

  it('rejects an unknown job status and missing ownership', () => {
    const invalidStatus = new Job({ ...validJob, status: 'unknown' });
    const missingOwnership = new Job({
      ...validJob,
      userId: undefined,
      tenantId: undefined,
      conversationId: undefined,
    });

    expect(invalidStatus.validateSync()?.errors.status).toBeDefined();
    expect(missingOwnership.validateSync()?.errors).toEqual(
      expect.objectContaining({
        userId: expect.anything(),
        tenantId: expect.anything(),
        conversationId: expect.anything(),
      }),
    );
  });

  it('defines job identity and origin-tool-call idempotency indexes', () => {
    expect(prototypeJobSchema.indexes()).toEqual(
      expect.arrayContaining([
        [{ jobId: 1 }, expect.objectContaining({ unique: true })],
        [
          { tenantId: 1, userId: 1, originToolCallId: 1 },
          expect.objectContaining({ unique: true }),
        ],
      ]),
    );
  });

  it('defines per-job turn ordinal and command idempotency indexes', () => {
    expect(prototypeTurnSchema.indexes()).toEqual(
      expect.arrayContaining([
        [{ jobId: 1, ordinal: 1 }, expect.objectContaining({ unique: true })],
        [{ commandId: 1 }, expect.objectContaining({ unique: true })],
      ]),
    );
  });

  it('defines per-job event idempotency and validates integer sequence fields', () => {
    expect(prototypeEventSchema.indexes()).toContainEqual([
      { jobId: 1, eventId: 1 },
      expect.objectContaining({ unique: true }),
    ]);

    const event = new Event({
      jobId: 'job_1',
      eventId: 1.5,
      revision: 2.5,
      type: 'status',
      publicPayload: { status: 'running' },
    });
    expect(event.validateSync()?.errors).toEqual(
      expect.objectContaining({ eventId: expect.anything(), revision: expect.anything() }),
    );
  });

  it('accepts only exact job_state card payloads as public events', () => {
    const cardPayload = {
      type: 'prototype',
      jobId: 'job_1',
      conversationId: 'conversation_1',
      turnId: 'turn_1',
      revision: 3,
      cursor: 2,
      status: 'running',
      phase: 'Building',
      waitingReason: null,
      promptMessageId: null,
      modelId: 'openai/gpt-5',
      modelWarning: null,
      prototypeName: 'Checkout flow',
      previewAvailable: false,
      sourcesAvailable: false,
      failure: null,
      activity: [],
      versions: [],
      actions: { approve: false, cancel: true, retry: false, finalize: false, reply: false },
      canCancel: true,
      canReply: false,
      estimatedCost: null,
      actualCostUsd: 0,
    };
    const validPayload = new Event({
      jobId: 'job_1',
      eventId: 2,
      sourceEventId: 'event_2',
      revision: 3,
      type: 'job_state',
      publicPayload: cardPayload,
    });

    expect(validPayload.validateSync()).toBeUndefined();

    for (const selectedVariant of [null, 'A', 'B']) {
      const selected = new Event({
        jobId: 'job_1',
        eventId: 2,
        sourceEventId: 'event_2',
        revision: 3,
        type: 'job_state',
        publicPayload: { ...cardPayload, selectedVariant },
      });
      expect(selected.validateSync()).toBeUndefined();
    }
    for (const selectedVariant of ['C', 0, {}, ['A']]) {
      const invalid = new Event({
        jobId: 'job_1',
        eventId: 2,
        sourceEventId: 'event_2',
        revision: 3,
        type: 'job_state',
        publicPayload: { ...cardPayload, selectedVariant },
      });
      expect(invalid.validateSync()?.errors.publicPayload).toBeDefined();
    }

    for (const eventInput of [
      { type: 'progress', publicPayload: cardPayload },
      { type: 'job_state', publicPayload: { ...cardPayload, status: 'unknown' } },
      { type: 'job_state', publicPayload: { ...cardPayload, jobToken: 'signed-job-token' } },
      { type: 'job_state', publicPayload: { ...cardPayload, providerBody: { choices: [] } } },
      { type: 'job_state', publicPayload: { ...cardPayload, internalPath: '/workspace/job_1' } },
      { type: 'job_state', publicPayload: { ...cardPayload, modelId: undefined } },
      { type: 'job_state', publicPayload: 'raw provider response' },
    ]) {
      const event = new Event({
        jobId: 'job_1',
        eventId: 2,
        revision: 3,
        ...eventInput,
      });

      expect(event.validateSync()).toBeDefined();
    }
  });

  it('rejects an invalid calculatedAt date in a job_state cost estimate', () => {
    const event = new Event({
      jobId: 'job_1',
      eventId: 3,
      revision: 4,
      type: 'job_state',
      publicPayload: {
        type: 'prototype',
        jobId: 'job_1',
        status: 'running',
        phase: null,
        modelId: 'openai/gpt-5',
        modelWarning: null,
        prototypeName: null,
        previewAvailable: false,
        sourcesAvailable: false,
        canCancel: true,
        canReply: false,
        estimatedCost: {
          currency: 'USD',
          low: 1,
          likely: 2,
          high: 3,
          recoveryBufferPercent: 20,
          method: 'admin_default',
          sampleSize: 0,
          modelId: 'openai/gpt-5',
          calculatedAt: new Date('invalid'),
          balanceRemaining: null,
        },
        actualCostUsd: 0,
      },
    });

    expect(event.validateSync()?.errors.publicPayload).toBeDefined();
  });

  it('requires artifact ownership and stores artifact identity as ObjectId', () => {
    expect(prototypeArtifactSchema.path('artifactId').instance).toBe('ObjectId');
    expect(prototypeJobSchema.path('previewArtifactId').instance).toBe('ObjectId');
    expect(prototypeJobSchema.path('sourcesArtifactId').instance).toBe('ObjectId');

    const artifact = new Artifact({
      artifactId: objectId,
      jobId: 'job_1',
      revision: 1,
      kind: 'html',
      objectKey: 'jobs/job_1/artifacts/1/preview.html',
      size: 10,
      sha256: 'a'.repeat(64),
      contentType: 'text/html',
      executionId: 'execution_1',
      templateDigest: `sha256:${'b'.repeat(64)}`,
      toolchainDigest: `sha256:${'c'.repeat(64)}`,
    });
    expect(artifact.validateSync()?.errors).toEqual(
      expect.objectContaining({ userId: expect.anything(), tenantId: expect.anything() }),
    );
  });

  it('keeps outbox commands explicit and uniquely addressable', () => {
    expect(prototypeOutboxSchema.indexes()).toContainEqual([
      { commandId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    expect(prototypeOutboxSchema.path('command')).toBeUndefined();
    expect(prototypeOutboxSchema.path('payload')).toBeUndefined();
    expect(prototypeOutboxSchema.path('jobToken')).toBeUndefined();
    expect(prototypeOutboxSchema.path('credentials')).toBeUndefined();
  });

  it('requires the full v2 attempt, stage, fence, deadline, and budget envelope', () => {
    const valid = new Outbox({
      schemaVersion: 2,
      commandId: 'command_1',
      kind: 'execute_stage',
      jobId: 'job_1',
      turnId: 'turn_1',
      tenantId: 'tenant_1',
      userId: 'user_1',
      modelId: 'openai/gpt-5',
      expectedRevision: 1,
      executionId: 'execution_1',
      attemptId: 'attempt_1',
      stage: 'generation',
      fenceToken: 1,
      checkpointRevision: null,
      checkpointDigest: null,
      sourceDigest: null,
      budget: {
        currency: 'USD',
        maxCostUsd: 1,
        maxRequests: 2,
        maxInputTokens: 100,
        maxOutputTokens: 50,
      },
      deadlineAt: new Date('2026-09-24T12:00:00.000Z'),
      attachmentManifest: [],
      status: 'pending',
      publishAttempts: 0,
    });
    expect(valid.validateSync()).toBeUndefined();
    const incomplete = new Outbox({
      ...valid.toObject(),
      attemptId: undefined,
      budget: undefined,
      deadlineAt: undefined,
    });
    expect(incomplete.validateSync()?.errors).toEqual(
      expect.objectContaining({
        attemptId: expect.anything(),
        budget: expect.anything(),
        deadlineAt: expect.anything(),
      }),
    );
  });

  it('stores a unique digest-bound worker event receipt', () => {
    expect(prototypeWorkerEventReceiptSchema.indexes()).toContainEqual([
      { eventId: 1 },
      expect.objectContaining({ unique: true }),
    ]);
    const receipt = new WorkerEventReceipt({
      eventId: 'event_1',
      jobId: 'job_1',
      commandId: 'command_1',
      payloadType: 'waiting',
      payloadDigest: `sha256:${'a'.repeat(64)}`,
    });
    expect(receipt.validateSync()).toBeUndefined();
    receipt.payloadDigest = 'unsafe';
    expect(receipt.validateSync()?.errors.payloadDigest).toBeDefined();
  });

  it('does not expose an unbounded metadata field', () => {
    for (const schema of [
      prototypeJobSchema,
      prototypeTurnSchema,
      prototypeEventSchema,
      prototypeArtifactSchema,
      prototypeOutboxSchema,
      prototypeWorkerEventReceiptSchema,
    ]) {
      expect(schema.paths.metadata).toBeUndefined();
    }
  });
});
