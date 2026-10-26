import type { ClientSession, FilterQuery, Model, Types, UpdateQuery } from 'mongoose';
import { createHash } from 'node:crypto';
import type {
  PrototypeCardData,
  PrototypeErrorCode,
  PrototypeJobStatus,
} from 'librechat-data-provider';
import type {
  IPrototypeEvent,
  IPrototypeArtifact,
  IPrototypeJob,
  IPrototypeOutbox,
  IPrototypeTurn,
  IPrototypeWorkerEventReceipt,
  PrototypeGenerationBinding,
} from '~/types';

const TERMINAL_STATES = new Set<PrototypeJobStatus>(['completed', 'failed', 'canceled']);
const ACTIVE_STATES: PrototypeJobStatus[] = [
  'queued',
  'preparing',
  'running',
  'waiting_for_input',
  'review',
  'waiting_for_credentials',
  'waiting_for_funds',
];
const PAUSE_OR_TERMINATE: PrototypeJobStatus[] = [
  'waiting_for_credentials',
  'waiting_for_funds',
  'failed',
  'canceled',
];

/** Explicit allowed edges for durable Prototype job state. */
export const PROTOTYPE_TRANSITIONS: Readonly<
  Record<PrototypeJobStatus, readonly PrototypeJobStatus[]>
> = {
  queued: ['preparing', ...PAUSE_OR_TERMINATE],
  preparing: ['running', ...PAUSE_OR_TERMINATE],
  running: ['waiting_for_input', 'review', 'completed', ...PAUSE_OR_TERMINATE],
  waiting_for_input: ['queued', ...PAUSE_OR_TERMINATE],
  review: ['queued', 'completed', ...PAUSE_OR_TERMINATE],
  waiting_for_credentials: ['queued'],
  waiting_for_funds: ['queued'],
  completed: [],
  failed: [],
  canceled: [],
};

export class PrototypeDomainError extends Error {
  constructor(
    public readonly code: Extract<
      PrototypeErrorCode,
      'PROTOTYPE_INVALID_STATE' | 'PROTOTYPE_STALE_REVISION'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'PrototypeDomainError';
  }
}

type PrototypeJobDefaultFields =
  | 'eventSequence'
  | 'activity'
  | 'versions'
  | 'accessRevokedAt'
  | 'cleanupStatus'
  | 'cleanupAttempts'
  | 'cleanupNextAttemptAt';
export type CreatePrototypeJobInput = Omit<
  IPrototypeJob,
  'createdAt' | 'updatedAt' | PrototypeJobDefaultFields
> &
  Partial<Pick<IPrototypeJob, PrototypeJobDefaultFields>>;

export interface CreatePrototypeResult {
  job: IPrototypeJob;
  created: boolean;
}

export interface TransitionPrototypeJobInput {
  jobId: string;
  expectedRevision: number;
  from: PrototypeJobStatus;
  to: PrototypeJobStatus;
  patch: Partial<
    Omit<
      IPrototypeJob,
      | 'jobId'
      | 'userId'
      | 'tenantId'
      | 'conversationId'
      | 'originMessageId'
      | 'originToolCallId'
      | 'status'
      | 'revision'
      | 'createdAt'
      | 'updatedAt'
    >
  >;
  executionId?: string;
  attemptId?: string;
  leaseId?: string;
  fenceToken?: number;
  session?: ClientSession;
}

export interface RegisterPrototypeLeaseInput {
  jobId: string;
  turnId: string;
  commandId: string;
  expectedRevision: number;
  executionId: string;
  attemptId: string;
  stage: NonNullable<IPrototypeJob['activeStage']>;
  leaseId: string;
  fenceToken: number;
  session?: ClientSession;
}

export interface AcceptPrototypePublicationInput {
  jobId: string;
  expectedRevision: number;
  fenceToken: number;
  attemptId: string;
  executionId: string;
  leaseId: string;
  to: 'review' | 'completed';
  checkpointRevision: number;
  checkpointDigest: string;
  previewArtifactId: Types.ObjectId;
  previewDigest: string;
  sourcesArtifactId: Types.ObjectId;
  sourcesDigest: string;
  qaArtifactId: Types.ObjectId;
  templateDigest: string;
  toolchainDigest: string;
  session?: ClientSession;
}

export interface AdvancePrototypeStageInput {
  event: {
    eventId: string;
    jobId: string;
    turnId: string;
    commandId: string;
    expectedRevision: number;
    attemptId: string;
    executionId: string;
    stage: NonNullable<IPrototypeJob['activeStage']>;
    pipelineStep: number;
    fenceToken: number;
    leaseId: string;
    payload: {
      type: 'stage_completed';
      outputKind: string;
      outputDigest: string;
      checkpoint?: { revision: number; digest: string };
    };
  };
  session: ClientSession;
}

export interface RegisterPrototypeArtifactsInput {
  storageBucket?: string;
  jobId: string;
  turnId: string;
  commandId: string;
  expectedRevision: number;
  attemptId: string;
  executionId: string;
  stage: 'publish';
  pipelineStep: 5;
  fenceToken: number;
  leaseId: string;
  templateDigest: string;
  toolchainDigest: string;
  artifacts: Array<{
    kind: 'checkpoint' | 'html' | 'sources_zip' | 'qa_evidence';
    objectKey: string;
    digest: string;
    size: number;
    contentType: string;
  }>;
  session: ClientSession;
}

export interface RetryPrototypeBuildStageInput {
  event: {
    eventId: string;
    jobId: string;
    turnId: string;
    commandId: string;
    expectedRevision: number;
    attemptId: string;
    executionId: string;
    stage: 'build_qa';
    pipelineStep: 4;
    fenceToken: number;
    leaseId: string;
    payload: {
      type: 'failed';
      code: 'PROTOTYPE_BUILD_FAILED' | 'PROTOTYPE_QA_FAILED';
      message: string;
      retryable: true;
      diagnostics?: string[];
    };
  };
  session: ClientSession;
  maxRepairs?: number;
}

export interface AppendPrototypeEventInput {
  jobId: string;
  eventId: number;
  revision: number;
  sourceEventId?: string;
  type: 'job_state';
  publicPayload: PrototypeCardData;
}

export interface ClaimPrototypeOutboxInput {
  publisherId: string;
  now: Date;
  leaseMs: number;
}

export interface ClaimPrototypeWorkerEventInput {
  eventId: string;
  jobId: string;
  commandId: string;
  payloadType: string;
  payloadDigest: string;
}

export interface PrototypeExecutionIdentityInput {
  jobId: string;
  turnId: string;
  commandId: string;
  expectedRevision: number;
  attemptId: string;
  executionId: string;
  stage: NonNullable<IPrototypeJob['activeStage']>;
  fenceToken: number;
  leaseId: string;
  session?: ClientSession;
}

export interface UpdatePrototypeExecutionInput extends PrototypeExecutionIdentityInput {
  phase?: string;
  checkpointRevision?: number;
  checkpointDigest?: string;
  actualCostDelta?: number;
}

export interface FinishPrototypeExecutionInput extends PrototypeExecutionIdentityInput {
  to:
    | 'waiting_for_input'
    | 'waiting_for_credentials'
    | 'waiting_for_funds'
    | 'failed'
    | 'canceled';
  waitingReason?: 'clarification' | 'plan_approval' | null;
  checkpointRevision?: number;
  checkpointDigest?: string;
  latestPromptMessageId?: string;
  failure?: { code: string; message: string } | null;
}

export interface ClaimPrototypeReplyInput {
  selectedVariant?: 'A' | 'B';
  jobId: string;
  expectedRevision: number;
  replyToPrototypeMessageId: string;
  turn: Omit<IPrototypeTurn, 'modelId'> & { modelId?: string };
  executionId?: string;
  currentExecutionId?: string | null;
  attemptId?: string;
}

export interface ClaimPrototypeReplyResult {
  job: IPrototypeJob;
  turn: IPrototypeTurn;
}

export interface ClaimPrototypeTurnInput {
  selectedVariant?: 'A' | 'B';
  jobId: string;
  expectedRevision: number;
  turn: IPrototypeTurn;
  executionId: string;
  attemptId: string;
  modelId: string;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function createPrototypeMethods(mongoose: typeof import('mongoose')) {
  const Job = mongoose.models.PrototypeJob as Model<IPrototypeJob>;
  const Turn = mongoose.models.PrototypeTurn as Model<IPrototypeTurn>;
  const Event = mongoose.models.PrototypeEvent as Model<IPrototypeEvent>;
  const Artifact = mongoose.models.PrototypeArtifact as Model<IPrototypeArtifact>;
  const Outbox = mongoose.models.PrototypeOutbox as Model<IPrototypeOutbox>;
  const WorkerEventReceipt = mongoose.models
    .PrototypeWorkerEventReceipt as Model<IPrototypeWorkerEventReceipt>;

  async function createPrototypeJob(
    input: CreatePrototypeJobInput,
    session?: ClientSession,
  ): Promise<CreatePrototypeResult> {
    const result = await Job.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        userId: input.userId,
        originToolCallId: input.originToolCallId,
      },
      { $setOnInsert: input },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        includeResultMetadata: true,
        lean: true,
        session,
      },
    );
    if (!result.value) {
      throw new Error(`Prototype job ${input.originToolCallId} upsert returned no document`);
    }
    return {
      job: result.value as IPrototypeJob,
      created: result.lastErrorObject?.upserted != null,
    };
  }

  async function getOwnedPrototypeJob({
    jobId,
    userId,
    tenantId,
  }: {
    jobId: string;
    userId: Types.ObjectId | string;
    tenantId: string;
  }): Promise<IPrototypeJob | null> {
    return Job.findOne({ jobId, userId, tenantId }).lean<IPrototypeJob>();
  }

  async function transitionPrototypeJob({
    jobId,
    expectedRevision,
    from,
    to,
    patch,
    executionId,
    attemptId,
    leaseId,
    fenceToken,
    session,
  }: TransitionPrototypeJobInput): Promise<IPrototypeJob> {
    if (TERMINAL_STATES.has(from) || !PROTOTYPE_TRANSITIONS[from].includes(to)) {
      throw new PrototypeDomainError(
        'PROTOTYPE_INVALID_STATE',
        `Prototype job cannot transition from ${from} to ${to}`,
      );
    }
    if ('status' in patch || 'revision' in patch) {
      throw new PrototypeDomainError(
        'PROTOTYPE_INVALID_STATE',
        'Prototype status and revision may only be changed by the state machine',
      );
    }

    const filter: FilterQuery<IPrototypeJob> = {
      jobId,
      revision: expectedRevision,
      status: from,
      ...(executionId !== undefined ? { activeExecutionId: executionId } : {}),
      ...(attemptId !== undefined ? { activeAttemptId: attemptId } : {}),
      ...(leaseId !== undefined ? { activeLeaseId: leaseId } : {}),
      ...(fenceToken !== undefined ? { fenceToken } : {}),
    };
    const update: UpdateQuery<IPrototypeJob> = {
      $set: stripUndefined({
        ...patch,
        ...(!['preparing', 'running'].includes(to) ? { activeLeaseId: null } : {}),
        status: to,
      }),
      $inc: { revision: 1 },
    };
    const updated = await Job.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
      session,
    }).lean<IPrototypeJob>();
    if (updated) {
      return updated;
    }

    // This diagnostic read never drives a write or revision value. It only chooses
    // the stable error code after the atomic compare-and-set has already failed.
    const current = await Job.findOne({ jobId }, { status: 1, revision: 1 }, { session }).lean<
      Pick<IPrototypeJob, 'status' | 'revision'>
    >();
    if (current && TERMINAL_STATES.has(current.status)) {
      throw new PrototypeDomainError(
        'PROTOTYPE_INVALID_STATE',
        `Prototype job is in ${current.status}, not ${from}`,
      );
    }
    throw new PrototypeDomainError(
      'PROTOTYPE_STALE_REVISION',
      `Prototype job ${jobId} revision or execution no longer matches`,
    );
  }

  async function appendPrototypeEvent(
    input: AppendPrototypeEventInput,
    session?: ClientSession,
  ): Promise<IPrototypeEvent> {
    const normalized = {
      ...input,
      sourceEventId: input.sourceEventId ?? `transition:${input.eventId}`,
    };
    const event = await Event.findOneAndUpdate(
      { jobId: input.jobId, eventId: input.eventId },
      { $setOnInsert: normalized },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        lean: true,
        session,
      },
    );
    if (!event) {
      throw new Error(
        `Prototype event ${input.jobId}/${input.eventId} upsert returned no document`,
      );
    }
    return event as IPrototypeEvent;
  }

  async function registerPrototypeLease({
    jobId,
    turnId,
    commandId,
    expectedRevision,
    executionId,
    attemptId,
    stage,
    leaseId,
    fenceToken,
    session,
  }: RegisterPrototypeLeaseInput): Promise<IPrototypeJob> {
    const updated = await Job.findOneAndUpdate(
      {
        jobId,
        revision: expectedRevision,
        fenceToken,
        status: { $in: ['queued', 'preparing', 'running'] },
        activeTurnId: turnId,
        activeCommandId: commandId,
        activeAttemptId: attemptId,
        activeExecutionId: executionId,
        activeStage: stage,
        activeLeaseId: { $in: [null, leaseId] },
      },
      { $set: { activeLeaseId: leaseId, status: 'running' } },
      { new: true, runValidators: true, session },
    ).lean<IPrototypeJob>();
    if (updated) return updated;
    throw new PrototypeDomainError(
      'PROTOTYPE_STALE_REVISION',
      `Prototype job ${jobId} execution lease is stale`,
    );
  }

  async function acceptPrototypePublication({
    jobId,
    expectedRevision,
    fenceToken,
    attemptId,
    executionId,
    leaseId,
    to,
    checkpointRevision,
    checkpointDigest,
    previewArtifactId,
    previewDigest,
    sourcesArtifactId,
    sourcesDigest,
    qaArtifactId,
    templateDigest,
    toolchainDigest,
    session,
  }: AcceptPrototypePublicationInput): Promise<IPrototypeJob> {
    const updated = await Job.findOneAndUpdate(
      {
        jobId,
        revision: expectedRevision,
        fenceToken,
        status: 'running',
        activeStage: 'publish',
        activeAttemptId: attemptId,
        activeExecutionId: executionId,
        activeLeaseId: leaseId,
      },
      {
        $set: {
          status: to,
          checkpointRevision,
          checkpointDigest,
          previewArtifactId,
          previewDigest,
          sourcesArtifactId,
          sourcesDigest,
          qaArtifactId,
          templateDigest,
          toolchainDigest,
          activeLeaseId: null,
          activeStage: null,
          ...(to === 'completed' ? { completedAt: new Date() } : {}),
        },
        $inc: { revision: 1 },
      },
      { new: true, runValidators: true, session },
    ).lean<IPrototypeJob>();
    if (updated) return updated;
    throw new PrototypeDomainError(
      'PROTOTYPE_STALE_REVISION',
      `Prototype job ${jobId} publication identity or digest is stale`,
    );
  }

  async function verifyPrototypePublication({ event, session }: { event: any; session?: ClientSession }) {
    const job = await Job.findOne({
      jobId: event.jobId,
      revision: event.expectedRevision,
      fenceToken: event.fenceToken,
      status: 'running',
      activeStage: 'publish',
      activeAttemptId: event.attemptId,
      activeExecutionId: event.executionId,
      activeLeaseId: event.leaseId,
    }).session(session ?? null).lean<IPrototypeJob>();
    if (!job) throw new PrototypeDomainError('PROTOTYPE_STALE_REVISION', `Prototype job ${event.jobId} publication identity is stale`);
    const references = event.payload.artifacts;
    const artifacts = await Artifact.find({ artifactId: { $in: references.map((item: any) => item.artifactId) } })
      .session(session ?? null).lean<IPrototypeArtifact[]>();
    if (artifacts.length !== references.length) throw new Error('PROTOTYPE_ARTIFACT_METADATA_MISMATCH');
    const template = artifacts[0]?.templateDigest;
    const toolchain = artifacts[0]?.toolchainDigest;
    for (const artifact of artifacts) {
      const reference = references.find((item: any) => String(item.artifactId) === String(artifact.artifactId));
      if (!reference || artifact.jobId !== job.jobId || artifact.tenantId !== job.tenantId || String(artifact.userId) !== String(job.userId) ||
          artifact.executionId !== event.executionId || artifact.revision !== event.expectedRevision ||
          `sha256:${artifact.sha256}` !== reference.digest || artifact.templateDigest !== template || artifact.toolchainDigest !== toolchain) {
        throw new Error('PROTOTYPE_ARTIFACT_METADATA_MISMATCH');
      }
    }
    return artifacts.map((artifact) => ({ ...artifact, digest: `sha256:${artifact.sha256}` }));
  }

  async function registerPrototypeArtifacts(input: RegisterPrototypeArtifactsInput) {
    if (!input.session?.inTransaction()) {
      throw new Error('registerPrototypeArtifacts requires an active MongoDB transaction');
    }
    const job = await Job.findOne({
      jobId: input.jobId,
      revision: input.expectedRevision,
      fenceToken: input.fenceToken,
      status: 'running',
      activeTurnId: input.turnId,
      activeCommandId: input.commandId,
      activeAttemptId: input.attemptId,
      activeExecutionId: input.executionId,
      activeStage: 'publish',
      activeLeaseId: input.leaseId,
      pipelineStep: 5,
    }).session(input.session).lean<IPrototypeJob>();
    if (!job) {
      throw new PrototypeDomainError(
        'PROTOTYPE_STALE_REVISION',
        `Prototype job ${input.jobId} publication identity is stale`,
      );
    }
    const command = await Outbox.findOne({
      commandId: input.commandId,
      jobId: input.jobId,
      executionId: input.executionId,
      stage: 'publish',
      pipelineStep: 5,
    }, null, { session: input.session }).lean<IPrototypeOutbox>();
    if (!command?.createdAt) throw new Error('PROTOTYPE_PIPELINE_COMMAND_CONTEXT_MISSING');

    const artifacts: IPrototypeArtifact[] = [];
    for (const artifact of input.artifacts) {
      const sha256 = artifact.digest.replace(/^sha256:/, '');
      const artifactId = new mongoose.Types.ObjectId(
        createHash('sha256')
          .update(`${input.jobId}:${input.executionId}:${input.expectedRevision}:${artifact.kind}:${artifact.digest}`)
          .digest('hex')
          .slice(0, 24),
      );
      const document = {
        artifactId,
        jobId: input.jobId,
        tenantId: job.tenantId,
        userId: job.userId,
        revision: input.expectedRevision,
        kind: artifact.kind,
        objectKey: artifact.objectKey,
        ...(input.storageBucket ? { storageBucket: input.storageBucket } : {}),
        size: artifact.size,
        sha256,
        contentType: artifact.contentType,
        executionId: input.executionId,
        templateDigest: input.templateDigest,
        toolchainDigest: input.toolchainDigest,
      };
      const stored = await Artifact.findOneAndUpdate(
        {
          jobId: input.jobId,
          executionId: input.executionId,
          revision: input.expectedRevision,
          kind: artifact.kind,
        },
        { $setOnInsert: document },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true,
          lean: true,
          session: input.session,
        },
      ) as IPrototypeArtifact | null;
      if (!stored || String(stored.artifactId) !== String(artifactId) ||
          stored.objectKey !== artifact.objectKey || stored.size !== artifact.size ||
          (input.storageBucket !== undefined && stored.storageBucket !== input.storageBucket) ||
          stored.sha256 !== sha256 || stored.contentType !== artifact.contentType ||
          stored.templateDigest !== input.templateDigest ||
          stored.toolchainDigest !== input.toolchainDigest ||
          stored.tenantId !== job.tenantId || String(stored.userId) !== String(job.userId)) {
        throw new Error('PROTOTYPE_ARTIFACT_METADATA_MISMATCH');
      }
      artifacts.push(stored);
    }
    return { artifacts, eventCreatedAt: command.createdAt };
  }

  async function advancePrototypeStage({ event, session }: AdvancePrototypeStageInput) {
    if (!session?.inTransaction()) throw new Error('advancePrototypeStage requires an active MongoDB transaction');
    const pipeline = [
      { stage: 'generation', output: 'checkpoint' },
      { stage: 'transfer', output: 'checkpoint_restored' },
      { stage: 'dependency_preparation', output: 'dependency_bundle' },
      { stage: 'transfer', output: 'dependencies_restored' },
      { stage: 'build_qa', output: 'verified_snapshot' },
      { stage: 'publish', output: null },
    ] as const;
    const current = pipeline[event.pipelineStep];
    if (!current || current.stage !== event.stage || current.output !== event.payload.outputKind) {
      throw new Error('PROTOTYPE_PIPELINE_TRANSITION_INVALID');
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(event.payload.outputDigest)) {
      throw new Error('PROTOTYPE_PIPELINE_DIGEST_INVALID');
    }
    if (event.pipelineStep === 0 && !event.payload.checkpoint) {
      throw new Error('PROTOTYPE_PIPELINE_CHECKPOINT_REQUIRED');
    }
    const previous = await Outbox.findOne({ commandId: event.commandId }, null, { session }).lean<IPrototypeOutbox>();
    if (!previous?.budget || !previous.deadlineAt || !previous.userId) {
      throw new Error('PROTOTYPE_PIPELINE_COMMAND_CONTEXT_MISSING');
    }
    const nextStep = event.pipelineStep === 1 && previous.repair ? 4 : event.pipelineStep + 1;
    const next = pipeline[nextStep];
    if (!next || (previous.repair && nextStep === 4 && !previous.dependencyDigest)) {
      throw new Error('PROTOTYPE_PIPELINE_TRANSITION_INVALID');
    }
    const suffix = createHash('sha256').update(`${event.eventId}:${nextStep}`).digest('hex').slice(0, 24);
    const commandId = `command_${suffix}`;
    const executionId = `execution_${suffix}`;
    const nextRevision = event.expectedRevision + 1;
    const nextFence = event.fenceToken + 1;
    const checkpointRevision = event.payload.checkpoint?.revision ?? previous.checkpointRevision ?? null;
    const checkpointDigest = event.payload.checkpoint?.digest ?? previous.checkpointDigest ?? null;
    const dependencyDigest = event.pipelineStep === 3
      ? event.payload.outputDigest
      : (previous.dependencyDigest ?? null);
    const job = await Job.findOneAndUpdate(
      {
        jobId: event.jobId, revision: event.expectedRevision, fenceToken: event.fenceToken,
        activeTurnId: event.turnId, activeCommandId: event.commandId,
        activeAttemptId: event.attemptId, activeExecutionId: event.executionId,
        activeStage: event.stage, activeLeaseId: event.leaseId,
        pipelineStep: event.pipelineStep,
        status: 'running',
      },
      {
        $set: {
          phase: next.stage,
          activeCommandId: commandId,
          activeExecutionId: executionId,
          activeStage: next.stage,
          activeLeaseId: null,
          pipelineStep: nextStep,
          checkpointRevision,
          checkpointDigest,
        },
        $inc: { revision: 1, fenceToken: 1 },
      },
      { new: true, runValidators: true, session },
    ).lean<IPrototypeJob>();
    if (!job) throw new PrototypeDomainError('PROTOTYPE_STALE_REVISION', `Prototype job ${event.jobId} pipeline event is stale`);
    const outbox = await enqueuePrototypeOutbox({
      schemaVersion: 2,
      commandId,
      kind: 'execute_stage',
      jobId: event.jobId,
      turnId: event.turnId,
      tenantId: previous.tenantId,
      userId: previous.userId,
      modelId: previous.modelId,
      expectedRevision: nextRevision,
      executionId,
      attemptId: event.attemptId,
      stage: next.stage,
      pipelineStep: nextStep,
      fenceToken: nextFence,
      checkpointRevision,
      checkpointDigest,
      sourceDigest: event.payload.outputDigest,
      dependencyDigest,
      repair: previous.repair ?? null,
      budget: previous.budget,
      deadlineAt: previous.deadlineAt,
      attachmentManifest: [],
      status: 'pending',
      publishAttempts: 0,
      publishedAt: null,
      lastAttemptAt: null,
    }, session);
    return { job, outbox };
  }

  async function retryPrototypeBuildStage({
    event,
    session,
    maxRepairs = 2,
  }: RetryPrototypeBuildStageInput) {
    if (!session?.inTransaction()) {
      throw new Error('retryPrototypeBuildStage requires an active MongoDB transaction');
    }
    if (event.stage !== 'build_qa' || event.pipelineStep !== 4 ||
        event.payload.type !== 'failed' || event.payload.retryable !== true ||
        !['PROTOTYPE_BUILD_FAILED', 'PROTOTYPE_QA_FAILED'].includes(event.payload.code) ||
        !Number.isSafeInteger(maxRepairs) || maxRepairs < 1 || maxRepairs > 2) {
      throw new Error('PROTOTYPE_REPAIR_TRANSITION_INVALID');
    }
    const diagnostics = (event.payload.diagnostics?.length
      ? event.payload.diagnostics
      : [event.payload.message]).slice(0, 20);
    if (diagnostics.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 2_048)) {
      throw new Error('PROTOTYPE_REPAIR_DIAGNOSTICS_INVALID');
    }
    const turn = await Turn.findOneAndUpdate(
      { jobId: event.jobId, turnId: event.turnId, executionAttempts: { $lt: maxRepairs } },
      { $inc: { executionAttempts: 1 }, $set: { status: 'running' } },
      { new: true, runValidators: true, lean: true, session },
    ) as IPrototypeTurn | null;
    if (!turn) {
      const current = await Turn.findOne(
        { jobId: event.jobId, turnId: event.turnId }, null, { session },
      ).lean<IPrototypeTurn>();
      if (current && current.executionAttempts >= maxRepairs) return { repaired: false as const };
      throw new Error('PROTOTYPE_REPAIR_TURN_CONTEXT_MISSING');
    }
    const previous = await Outbox.findOne(
      { commandId: event.commandId, jobId: event.jobId, executionId: event.executionId },
      null,
      { session },
    ).lean<IPrototypeOutbox>();
    if (!previous?.budget || !previous.deadlineAt || !previous.userId ||
        previous.checkpointRevision == null || !previous.checkpointDigest ||
        !previous.dependencyDigest) {
      throw new Error('PROTOTYPE_REPAIR_COMMAND_CONTEXT_MISSING');
    }
    const suffix = createHash('sha256')
      .update(`${event.eventId}:repair:${turn.executionAttempts}`)
      .digest('hex')
      .slice(0, 24);
    const commandId = `command_${suffix}`;
    const executionId = `execution_${suffix}`;
    const attemptId = `attempt_${suffix}`;
    const nextRevision = event.expectedRevision + 1;
    const nextFence = event.fenceToken + 1;
    const job = await Job.findOneAndUpdate(
      {
        jobId: event.jobId, revision: event.expectedRevision, fenceToken: event.fenceToken,
        status: 'running', activeTurnId: event.turnId, activeCommandId: event.commandId,
        activeAttemptId: event.attemptId, activeExecutionId: event.executionId,
        activeStage: 'build_qa', activeLeaseId: event.leaseId, pipelineStep: 4,
      },
      {
        $set: {
          phase: 'generation', activeCommandId: commandId, activeAttemptId: attemptId,
          activeExecutionId: executionId, activeStage: 'generation', activeLeaseId: null,
          pipelineStep: 0, failure: null,
        },
        $inc: { revision: 1, fenceToken: 1 },
      },
      { new: true, runValidators: true, session },
    ).lean<IPrototypeJob>();
    if (!job) {
      throw new PrototypeDomainError(
        'PROTOTYPE_STALE_REVISION',
        `Prototype job ${event.jobId} repair identity is stale`,
      );
    }
    const outbox = await enqueuePrototypeOutbox({
      schemaVersion: 2,
      commandId,
      kind: 'execute_stage',
      jobId: event.jobId,
      turnId: event.turnId,
      tenantId: previous.tenantId,
      userId: previous.userId,
      modelId: previous.modelId,
      expectedRevision: nextRevision,
      executionId,
      attemptId,
      stage: 'generation',
      pipelineStep: 0,
      fenceToken: nextFence,
      checkpointRevision: previous.checkpointRevision,
      checkpointDigest: previous.checkpointDigest,
      sourceDigest: previous.checkpointDigest,
      dependencyDigest: previous.dependencyDigest,
      repair: { ordinal: turn.executionAttempts, diagnostics },
      budget: previous.budget,
      deadlineAt: previous.deadlineAt,
      attachmentManifest: [],
      status: 'pending',
      publishAttempts: 0,
      publishedAt: null,
      lastAttemptAt: null,
    }, session);
    return { repaired: true as const, job, outbox };
  }

  async function claimPrototypeReply(
    input: ClaimPrototypeReplyInput,
    session: ClientSession,
  ): Promise<ClaimPrototypeReplyResult> {
    if (!session?.inTransaction()) {
      throw new Error('claimPrototypeReply requires an active MongoDB transaction');
    }

    const replyStatusFilter: PrototypeJobStatus[] = ['waiting_for_input', 'review'];
    const filter: FilterQuery<IPrototypeJob> = {
      jobId: input.jobId,
      revision: input.expectedRevision,
      status: { $in: replyStatusFilter },
      latestPromptMessageId: input.replyToPrototypeMessageId,
      ...(input.selectedVariant ? { selectedVariant: null, status: 'review' } : {}),
      ...(input.currentExecutionId !== undefined
        ? { activeExecutionId: input.currentExecutionId }
        : {}),
    };
    const updated = await Job.findOneAndUpdate(
      filter,
      {
        $set: {
          status: 'queued',
          ...(input.selectedVariant ? { selectedVariant: input.selectedVariant } : {}),
          waitingReason: null,
          latestPromptMessageId: null,
          activeCommandId: input.turn.commandId,
          activeTurnId: input.turn.turnId,
          ...(input.turn.modelId ? { modelId: input.turn.modelId } : {}),
          activeAttemptId: input.attemptId ?? null,
          activeExecutionId: input.executionId ?? null,
          activeLeaseId: null,
          activeStage: 'generation',
          pipelineStep: 0,
        },
        $inc: { revision: 1, fenceToken: 1 },
      },
      { new: true, runValidators: true, session },
    ).lean<IPrototypeJob>();
    if (!updated) {
      const current = await Job.findOne({ jobId: input.jobId }, { status: 1 }, { session }).lean<
        Pick<IPrototypeJob, 'status'>
      >();
      if (current && !replyStatusFilter.includes(current.status)) {
        throw new PrototypeDomainError(
          'PROTOTYPE_INVALID_STATE',
          `Prototype job cannot accept a reply while ${current.status}`,
        );
      }
      throw new PrototypeDomainError(
        'PROTOTYPE_STALE_REVISION',
        `Prototype job ${input.jobId} reply was already claimed or is stale`,
      );
    }

    const [createdTurn] = await Turn.create([{ ...input.turn, modelId: input.turn.modelId ?? updated.modelId }], { session });
    return { job: updated, turn: createdTurn.toObject<IPrototypeTurn>() };
  }

  async function claimPrototypeTurn(
    input: ClaimPrototypeTurnInput,
    session: ClientSession,
  ): Promise<ClaimPrototypeReplyResult> {
    if (!session?.inTransaction()) {
      throw new Error('claimPrototypeTurn requires an active MongoDB transaction');
    }
    const updated = await Job.findOneAndUpdate(
      {
        jobId: input.jobId,
        revision: input.expectedRevision,
        status: 'completed',
        accessRevokedAt: null,
        ...(input.selectedVariant ? { selectedVariant: null } : {}),
      },
      {
        $set: {
          status: 'queued',
          phase: null,
          ...(input.selectedVariant ? { selectedVariant: input.selectedVariant } : {}),
          waitingReason: null,
          latestPromptMessageId: null,
          modelId: input.modelId,
          activeCommandId: input.turn.commandId,
          activeTurnId: input.turn.turnId,
          activeAttemptId: input.attemptId,
          activeExecutionId: input.executionId,
          activeLeaseId: null,
          activeStage: 'generation',
          pipelineStep: 0,
          failure: null,
          completedAt: null,
        },
        $inc: { revision: 1, fenceToken: 1 },
      },
      { new: true, runValidators: true, session },
    ).lean<IPrototypeJob>();
    if (!updated) {
      throw new PrototypeDomainError(
        'PROTOTYPE_STALE_REVISION',
        `Prototype job ${input.jobId} cannot start a new turn`,
      );
    }
    const [createdTurn] = await Turn.create([input.turn], { session });
    return { job: updated, turn: createdTurn.toObject<IPrototypeTurn>() };
  }

  async function retryFailedPrototypeJob(
    input: {
      jobId: string;
      expectedRevision: number;
      commandId: string;
      attemptId: string;
      executionId: string;
    },
    session: ClientSession,
  ): Promise<IPrototypeJob> {
    const updated = await Job.findOneAndUpdate(
      {
        jobId: input.jobId,
        revision: input.expectedRevision,
        status: 'failed',
        accessRevokedAt: null,
      },
      {
        $set: {
          status: 'queued',
          waitingReason: null,
          failure: null,
          activeCommandId: input.commandId,
          activeAttemptId: input.attemptId,
          activeExecutionId: input.executionId,
          activeLeaseId: null,
          activeStage: 'generation',
          pipelineStep: 0,
        },
        $inc: { revision: 1, fenceToken: 1 },
      },
      { new: true, runValidators: true, session },
    ).lean<IPrototypeJob>();
    if (!updated) {
      throw new PrototypeDomainError(
        'PROTOTYPE_STALE_REVISION',
        `Prototype job ${input.jobId} retry is stale`,
      );
    }
    return updated;
  }

  async function enqueuePrototypeOutbox(
    input: IPrototypeOutbox,
    session?: ClientSession,
  ): Promise<IPrototypeOutbox> {
    const command = await Outbox.findOneAndUpdate(
      { commandId: input.commandId },
      { $setOnInsert: input },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        lean: true,
        session,
      },
    );
    if (!command) {
      throw new Error(`Prototype outbox command ${input.commandId} upsert returned no document`);
    }
    return command as IPrototypeOutbox;
  }

  async function claimPrototypeOutbox({
    publisherId,
    now,
    leaseMs,
  }: ClaimPrototypeOutboxInput): Promise<IPrototypeOutbox | null> {
    if (!publisherId || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) {
      throw new Error('Prototype outbox publisher identity or lease is invalid');
    }
    return Outbox.findOneAndUpdate(
      {
        $or: [
          { status: 'pending' },
          { status: 'publishing', claimExpiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          status: 'publishing',
          publisherId,
          claimExpiresAt: new Date(now.getTime() + leaseMs),
          lastAttemptAt: now,
        },
        $inc: { publishAttempts: 1 },
      },
      { sort: { createdAt: 1 }, new: true, runValidators: true, lean: true },
    );
  }

  async function markPrototypeOutboxPublished(
    commandId: string,
    publisherId: string,
    publishedAt = new Date(),
  ): Promise<IPrototypeOutbox> {
    const command = await Outbox.findOneAndUpdate(
      { commandId, status: 'publishing', publisherId },
      {
        $set: { status: 'published', publishedAt },
        $unset: { publisherId: 1, claimExpiresAt: 1 },
      },
      { new: true, runValidators: true, lean: true },
    );
    if (!command) throw new Error(`Prototype outbox command ${commandId} publication claim is stale`);
    return command as IPrototypeOutbox;
  }

  async function releasePrototypeOutboxClaim(
    commandId: string,
    publisherId: string,
  ): Promise<boolean> {
    const result = await Outbox.updateOne(
      { commandId, status: 'publishing', publisherId },
      {
        $set: { status: 'pending' },
        $unset: { publisherId: 1, claimExpiresAt: 1 },
      },
    );
    return result.modifiedCount === 1;
  }

  async function reconcilePrototypeOutboxClaims(now = new Date()): Promise<number> {
    const result = await Outbox.updateMany(
      { status: 'publishing', claimExpiresAt: { $lte: now } },
      {
        $set: { status: 'pending' },
        $unset: { publisherId: 1, claimExpiresAt: 1 },
      },
    );
    return result.modifiedCount;
  }

  async function claimPrototypeWorkerEvent(
    input: ClaimPrototypeWorkerEventInput,
    session: ClientSession,
  ): Promise<{ receipt: IPrototypeWorkerEventReceipt; created: boolean }> {
    if (!session?.inTransaction()) {
      throw new Error('claimPrototypeWorkerEvent requires an active MongoDB transaction');
    }
    const result = await WorkerEventReceipt.findOneAndUpdate(
      { eventId: input.eventId },
      { $setOnInsert: input },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        includeResultMetadata: true,
        lean: true,
        session,
      },
    );
    if (!result.value) throw new Error(`Prototype worker event ${input.eventId} claim returned no document`);
    const receipt = result.value as IPrototypeWorkerEventReceipt;
    if (
      receipt.jobId !== input.jobId ||
      receipt.commandId !== input.commandId ||
      receipt.payloadType !== input.payloadType ||
      receipt.payloadDigest !== input.payloadDigest
    ) {
      throw new Error(`Prototype worker event ${input.eventId} payload conflicts with its receipt`);
    }
    return { receipt, created: result.lastErrorObject?.upserted != null };
  }

  function executionFilter(input: PrototypeExecutionIdentityInput): FilterQuery<IPrototypeJob> {
    return {
      jobId: input.jobId,
      revision: input.expectedRevision,
      status: 'running',
      activeTurnId: input.turnId,
      activeCommandId: input.commandId,
      activeAttemptId: input.attemptId,
      activeExecutionId: input.executionId,
      activeStage: input.stage,
      fenceToken: input.fenceToken,
      activeLeaseId: input.leaseId,
    };
  }

  async function updatePrototypeExecution(
    input: UpdatePrototypeExecutionInput,
  ): Promise<IPrototypeJob> {
    const patch = stripUndefined({
      phase: input.phase,
      checkpointRevision: input.checkpointRevision,
      checkpointDigest: input.checkpointDigest,
    });
    if (
      input.actualCostDelta !== undefined &&
      (!Number.isFinite(input.actualCostDelta) || input.actualCostDelta < 0)
    ) throw new Error('Prototype execution cost delta is invalid');
    if (Object.keys(patch).length === 0 && input.actualCostDelta === undefined) {
      throw new Error('Prototype execution update is empty');
    }
    const update: UpdateQuery<IPrototypeJob> = {
      ...(Object.keys(patch).length > 0 ? { $set: patch } : {}),
      ...(input.actualCostDelta !== undefined
        ? { $inc: { actualCostUsd: input.actualCostDelta } }
        : {}),
    };
    const job = await Job.findOneAndUpdate(executionFilter(input), update, {
      new: true,
      runValidators: true,
      session: input.session,
    }).lean<IPrototypeJob>();
    if (job) return job;
    throw new PrototypeDomainError(
      'PROTOTYPE_STALE_REVISION',
      `Prototype job ${input.jobId} execution event is stale`,
    );
  }

  async function finishPrototypeExecution(
    input: FinishPrototypeExecutionInput,
  ): Promise<IPrototypeJob> {
    const job = await Job.findOneAndUpdate(
      executionFilter(input),
      {
        $set: stripUndefined({
          status: input.to,
          waitingReason: input.waitingReason ?? null,
          checkpointRevision: input.checkpointRevision,
          checkpointDigest: input.checkpointDigest,
          latestPromptMessageId: input.latestPromptMessageId,
          failure: input.failure ?? null,
          activeLeaseId: null,
          activeStage: null,
        }),
        $inc: { revision: 1 },
      },
      { new: true, runValidators: true, session: input.session },
    ).lean<IPrototypeJob>();
    if (job) return job;
    throw new PrototypeDomainError(
      'PROTOTYPE_STALE_REVISION',
      `Prototype job ${input.jobId} terminal event is stale`,
    );
  }

  async function projectPrototypeWorkerEvent(
    input: {
      event: {
        eventId: string;
        jobId: string;
        turnId: string;
        createdAt: string;
        payload: {
          type: string;
          phase?: string;
          prompt?: string;
          message?: string;
        };
      };
      effect?: unknown;
    },
    session: ClientSession,
  ): Promise<IPrototypeEvent> {
    const { event } = input;
    const current = await Job.findOne({ jobId: event.jobId }, null, { session }).lean<IPrototypeJob>();
    if (!current) {
      throw new Error(`Prototype job ${event.jobId} disappeared during projection`);
    }
    const activityMessage =
      event.payload.type === 'progress'
        ? event.payload.phase ?? 'Prototype is running'
        : event.payload.type === 'waiting'
          ? 'Prototype is waiting for your response'
          : event.payload.type === 'review_ready'
            ? 'A verified prototype version is ready for review'
            : event.payload.type === 'completed'
              ? 'Prototype version completed'
              : event.payload.type === 'failed'
                ? event.payload.message ?? 'Prototype execution failed'
                : event.payload.type === 'canceled'
                  ? 'Prototype execution canceled'
                  : `Prototype ${event.payload.type.replace(/_/g, ' ')}`;
    const activity = {
      id: event.eventId,
      phase: event.payload.phase ?? current.phase ?? null,
      message: activityMessage.slice(0, 2048),
      createdAt: event.createdAt,
    };
    const version =
      (event.payload.type === 'review_ready' || event.payload.type === 'completed') &&
      current.previewDigest &&
      current.sourcesDigest
        ? {
            revision: current.revision,
            turnId: event.turnId,
            htmlDigest: current.previewDigest,
            sourcesDigest: current.sourcesDigest,
            acceptedAt: event.createdAt,
            selectedVariant: current.selectedVariant ?? null,
          }
        : null;
    const updated = await Job.findOneAndUpdate(
      { jobId: event.jobId },
      {
        $inc: { eventSequence: 1 },
        ...(event.payload.type === 'review_ready'
          ? { $set: { latestPromptMessageId: event.eventId } }
          : event.payload.type === 'completed'
            ? { $set: { latestPromptMessageId: null } }
            : {}),
        $push: {
          activity: { $each: [activity], $slice: -100 },
          ...(version ? { versions: { $each: [version], $slice: -100 } } : {}),
        },
      },
      { new: true, runValidators: true, session },
    ).lean<IPrototypeJob>();
    if (!updated) {
      throw new Error(`Prototype job ${event.jobId} projection update failed`);
    }
    const active = !['completed', 'failed', 'canceled'].includes(updated.status);
    const actions = {
      approve: updated.status === 'waiting_for_input' && updated.waitingReason === 'plan_approval',
      cancel: active,
      retry:
        updated.status === 'failed' ||
        updated.status === 'waiting_for_credentials' ||
        updated.status === 'waiting_for_funds',
      finalize: updated.status === 'review' && updated.selectedVariant != null &&
        updated.versions.at(-1)?.selectedVariant === updated.selectedVariant,
      reply:
        updated.status === 'review' ||
        (updated.status === 'waiting_for_input' && ['clarification', 'plan_approval'].includes(updated.waitingReason ?? '')),
    };
    const publicPayload: PrototypeCardData = {
      type: 'prototype',
      jobId: updated.jobId,
      conversationId: updated.conversationId,
      turnId: updated.activeTurnId,
      revision: updated.revision,
      cursor: updated.eventSequence,
      status: updated.status,
      phase: updated.phase,
      waitingReason: updated.waitingReason,
      promptMessageId: updated.latestPromptMessageId,
      modelId: updated.modelId,
      selectedVariant: updated.selectedVariant ?? null,
      modelWarning:
        updated.modelRecommendation === 'not_recommended'
          ? 'The selected model is not recommended for prototype generation.'
          : null,
      prototypeName: null,
      previewAvailable: updated.previewArtifactId != null,
      sourcesAvailable: updated.sourcesArtifactId != null,
      failure: updated.failure,
      activity: updated.activity,
      versions: updated.versions,
      actions,
      canCancel: actions.cancel,
      canReply: actions.reply,
      estimatedCost: updated.estimatedCost,
      actualCostUsd: updated.actualCostUsd,
    };
    const projected = await appendPrototypeEvent(
      {
        jobId: updated.jobId,
        eventId: updated.eventSequence,
        sourceEventId: event.eventId,
        revision: updated.revision,
        type: 'job_state',
        publicPayload,
      },
      session,
    );
    const assistantText =
      event.payload.type === 'waiting'
        ? event.payload.prompt
        : event.payload.type === 'failed'
          ? updated.failure?.message
          : event.payload.type === 'review_ready'
            ? 'Прототип готов к проверке. Можно добавить пожелания в чате.'
            : event.payload.type === 'completed'
              ? 'Работа над прототипом завершена.'
              : null;
    if (assistantText) {
      const Message = mongoose.models.Message;
      const turn = await Turn.findOne({ turnId: event.turnId, jobId: updated.jobId }, null, {
        session,
      }).lean<IPrototypeTurn>();
      await Message.findOneAndUpdate(
        { messageId: event.eventId, user: String(updated.userId) },
        {
          $setOnInsert: {
            messageId: event.eventId,
            conversationId: updated.conversationId,
            parentMessageId: turn?.sourceMessageId ?? updated.originMessageId,
            user: String(updated.userId),
            tenantId: updated.tenantId,
            sender: 'Prototype',
            text: assistantText,
            isCreatedByUser: false,
            model: updated.modelId,
            metadata: { prototypeAgent: publicPayload, sourceEventId: event.eventId },
          },
        },
        { upsert: true, new: true, runValidators: true, session },
      );
    }
    return projected;
  }

  async function revokePrototypeConversation(
    {
      conversationId,
      userId,
      tenantId,
      now = new Date(),
    }: { conversationId: string; userId: string; tenantId: string; now?: Date },
    session?: ClientSession,
  ): Promise<IPrototypeJob | null> {
    return Job.findOneAndUpdate(
      {
        conversationId,
        userId,
        tenantId,
        accessRevokedAt: null,
      },
      {
        $set: {
          accessRevokedAt: now,
          cleanupStatus: 'pending',
          cleanupAttempts: 0,
          cleanupNextAttemptAt: now,
          activeLeaseId: null,
        },
        $inc: { fenceToken: 1, revision: 1 },
      },
      { new: true, runValidators: true, session },
    ).lean<IPrototypeJob>();
  }

  async function revokePrototypeUserConversations({
    userId,
    tenantId,
    now = new Date(),
  }: {
    userId: string;
    tenantId: string;
    now?: Date;
  }): Promise<number> {
    const result = await Job.updateMany(
      { userId, tenantId, accessRevokedAt: null },
      {
        $set: {
          accessRevokedAt: now,
          cleanupStatus: 'pending',
          cleanupAttempts: 0,
          cleanupNextAttemptAt: now,
          activeLeaseId: null,
        },
        $inc: { fenceToken: 1, revision: 1 },
      },
      { runValidators: true },
    );
    return result.modifiedCount;
  }

  async function claimPrototypeCleanup({
    now = new Date(),
    maxAttempts = 20,
    leaseMs = 60_000,
  }: { now?: Date; maxAttempts?: number; leaseMs?: number } = {}): Promise<IPrototypeJob | null> {
    return Job.findOneAndUpdate(
      {
        accessRevokedAt: { $ne: null },
        cleanupStatus: { $in: ['pending', 'failed', 'running'] },
        cleanupAttempts: { $lt: maxAttempts },
        $or: [{ cleanupNextAttemptAt: null }, { cleanupNextAttemptAt: { $lte: now } }],
      },
      {
        $set: {
          cleanupStatus: 'running',
          cleanupNextAttemptAt: new Date(now.getTime() + leaseMs),
        },
        $inc: { cleanupAttempts: 1 },
      },
      { new: true, runValidators: true, sort: { cleanupNextAttemptAt: 1, updatedAt: 1 } },
    ).lean<IPrototypeJob>();
  }

  async function completePrototypeCleanup(jobId: string): Promise<boolean> {
    const result = await Job.updateOne(
      { jobId, accessRevokedAt: { $ne: null }, cleanupStatus: 'running' },
      { $set: { cleanupStatus: 'completed', cleanupNextAttemptAt: null } },
    );
    return result.modifiedCount === 1;
  }

  async function failPrototypeCleanup(
    jobId: string,
    now = new Date(),
  ): Promise<boolean> {
    const job = await Job.findOne({ jobId }, { cleanupAttempts: 1 }).lean<
      Pick<IPrototypeJob, 'cleanupAttempts'>
    >();
    if (!job) return false;
    const backoffMs = Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.min(job.cleanupAttempts, 12));
    const result = await Job.updateOne(
      { jobId, accessRevokedAt: { $ne: null }, cleanupStatus: 'running' },
      { $set: { cleanupStatus: 'failed', cleanupNextAttemptAt: new Date(now.getTime() + backoffMs) } },
    );
    return result.modifiedCount === 1;
  }

  async function listPrototypeCleanupArtifacts(jobId: string): Promise<Array<Pick<IPrototypeArtifact, 'objectKey' | 'storageBucket'>>> {
    return Artifact.find({ jobId }, { objectKey: 1, storageBucket: 1, _id: 0 }).lean<
      Array<Pick<IPrototypeArtifact, 'objectKey' | 'storageBucket'>>
    >();
  }

  async function deletePrototypeCleanupArtifacts(jobId: string): Promise<number> {
    const result = await Artifact.deleteMany({ jobId });
    return result.deletedCount;
  }

  async function pinPrototypeGeneration(input: {
    jobId: string; turnId: string; commandId: string; attemptId: string; executionId: string;
    tenantId: string; userId: string; modelId: string; expectedRevision: number; fenceToken: number;
    leaseId: string; generation: PrototypeGenerationBinding;
  }, session: ClientSession): Promise<PrototypeGenerationBinding> {
    if (!session?.inTransaction()) throw new Error('pinPrototypeGeneration requires an active MongoDB transaction');
    // Validate as a complete value before using it in filters; runValidators also protects persisted fields.
    const job = await Job.findOne({ jobId: input.jobId, tenantId: input.tenantId, userId: input.userId,
      modelId: input.modelId, activeTurnId: input.turnId, activeCommandId: input.commandId,
      activeAttemptId: input.attemptId, activeExecutionId: input.executionId, activeLeaseId: input.leaseId,
      activeStage: 'generation', pipelineStep: 0, revision: input.expectedRevision, fenceToken: input.fenceToken,
      status: { $in: ['preparing', 'running'] } }, null, { session }).lean();
    if (!job) throw new PrototypeDomainError('PROTOTYPE_STALE_REVISION', 'Generation execution is no longer active');
    const same = (current?: PrototypeGenerationBinding | null) => !current ||
      Object.keys(input.generation).length === 6 &&
      Object.entries(input.generation).every(([key, value]) => current[key as keyof PrototypeGenerationBinding] === value);
    if (!same(job.generation)) throw new PrototypeDomainError('PROTOTYPE_INVALID_STATE', 'Generation pins cannot change within a job');
    const turn = await Turn.findOne({ turnId: input.turnId, jobId: input.jobId, modelId: input.modelId }, null, { session }).lean();
    if (!turn || !same(turn.generation)) throw new PrototypeDomainError('PROTOTYPE_INVALID_STATE', 'Generation turn binding conflicts');
    await Job.updateOne({ _id: job._id, revision: input.expectedRevision, fenceToken: input.fenceToken },
      { $set: { generation: input.generation } }, { session, runValidators: true });
    await Turn.updateOne({ _id: turn._id }, { $set: { generation: input.generation } }, { session, runValidators: true });
    return input.generation;
  }

  return {
    pinPrototypeGeneration,
    createPrototypeJob,
    getOwnedPrototypeJob,
    transitionPrototypeJob,
    registerPrototypeLease,
    acceptPrototypePublication,
    registerPrototypeArtifacts,
    retryPrototypeBuildStage,
    verifyPrototypePublication,
    advancePrototypeStage,
    appendPrototypeEvent,
    claimPrototypeReply,
    claimPrototypeTurn,
    retryFailedPrototypeJob,
    enqueuePrototypeOutbox,
    claimPrototypeOutbox,
    markPrototypeOutboxPublished,
    releasePrototypeOutboxClaim,
    reconcilePrototypeOutboxClaims,
    claimPrototypeWorkerEvent,
    updatePrototypeExecution,
    finishPrototypeExecution,
    projectPrototypeWorkerEvent,
    revokePrototypeConversation,
    revokePrototypeUserConversations,
    claimPrototypeCleanup,
    completePrototypeCleanup,
    failPrototypeCleanup,
    listPrototypeCleanupArtifacts,
    deletePrototypeCleanupArtifacts,
  };
}

export type PrototypeMethods = ReturnType<typeof createPrototypeMethods>;
