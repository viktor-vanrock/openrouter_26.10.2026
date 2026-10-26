import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,256}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

const PIPELINE = [
  { stage: 'generation', outputKind: 'checkpoint', digestField: 'checkpointDigest' },
  { stage: 'transfer', outputKind: 'checkpoint_restored', digestField: 'restoredDigest' },
  { stage: 'dependency_preparation', outputKind: 'dependency_bundle', digestField: 'bundleDigest' },
  { stage: 'transfer', outputKind: 'dependencies_restored', digestField: 'restoredDigest' },
  { stage: 'build_qa', outputKind: 'verified_snapshot', digestField: 'snapshotDigest' },
];

const DEFAULT_LIMITS = {
  resultBytes: 64 * 1024,
  checkpointBytes: 100_000_000,
  dependencyBytes: 250_000_000,
  htmlBytes: 20_000_000,
  sourcesBytes: 100_000_000,
  qaEvidenceBytes: 5_000_000,
  publicationBytes: 128 * 1024,
  failureBytes: 64 * 1024,
};

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function verifiedSnapshotDigest(digests) {
  return digestBytes(
    Buffer.from(
      JSON.stringify({
        html: digests.html,
        sourcesZip: digests.sourcesZip,
        qaEvidence: digests.qaEvidence,
      }),
    ),
  );
}

async function readBoundedRegularFile(filename, maxBytes) {
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('PROTOTYPE_STAGE_OUTPUT_INVALID');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readVerifiedStageResult(command, outputRoot, configuredLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...configuredLimits };
  const root = path.resolve(outputRoot);
  const resultBytes = await readBoundedRegularFile(
    path.join(root, 'result.json'),
    limits.resultBytes,
  );
  let result;
  try {
    result = JSON.parse(resultBytes.toString('utf8'));
  } catch {
    throw new Error('PROTOTYPE_STAGE_RESULT_INVALID');
  }
  const step = PIPELINE[command?.pipelineStep];
  if (!step || step.stage !== command.stage)
    throw new Error('PROTOTYPE_PIPELINE_TRANSITION_INVALID');

  if (step.stage === 'generation') {
    const checkpoint = await readBoundedRegularFile(
      path.join(root, 'checkpoint.tar.zst'),
      limits.checkpointBytes,
    );
    if (
      result.checkpointSize !== checkpoint.length ||
      result.checkpointDigest !== digestBytes(checkpoint)
    ) {
      throw new Error('PROTOTYPE_STAGE_RESULT_DIGEST_INVALID');
    }
  } else if (step.stage === 'dependency_preparation') {
    const bundle = await readBoundedRegularFile(
      path.join(root, 'dependencies.zip'),
      limits.dependencyBytes,
    );
    if (result.size !== bundle.length || result.bundleDigest !== digestBytes(bundle)) {
      throw new Error('PROTOTYPE_STAGE_RESULT_DIGEST_INVALID');
    }
  } else if (step.stage === 'build_qa') {
    const [html, sourcesZip, qaEvidence] = await Promise.all([
      readBoundedRegularFile(path.join(root, 'preview.html'), limits.htmlBytes),
      readBoundedRegularFile(path.join(root, 'sources.zip'), limits.sourcesBytes),
      readBoundedRegularFile(path.join(root, 'qa.json'), limits.qaEvidenceBytes),
    ]);
    const digests = {
      html: digestBytes(html),
      sourcesZip: digestBytes(sourcesZip),
      qaEvidence: digestBytes(qaEvidence),
    };
    if (
      result.digests?.html !== digests.html ||
      result.digests?.sourcesZip !== digests.sourcesZip ||
      result.digests?.qaEvidence !== digests.qaEvidence ||
      result.snapshotDigest !== verifiedSnapshotDigest(digests)
    ) {
      throw new Error('PROTOTYPE_STAGE_RESULT_DIGEST_INVALID');
    }
  }
  return result;
}

function safeObjectKey(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.split('/').includes('..')
  );
}

export async function readVerifiedPublicationResult(command, outputRoot, configuredLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...configuredLimits };
  const bytes = await readBoundedRegularFile(
    path.join(path.resolve(outputRoot), 'publication.json'),
    limits.publicationBytes,
  );
  let result;
  try {
    result = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('PROTOTYPE_PUBLICATION_RESULT_INVALID');
  }
  if (
    !validIdentity(command, result) ||
    command.stage !== 'publish' ||
    command.pipelineStep !== 5 ||
    !['review_ready', 'completed'].includes(result.target) ||
    !DIGEST.test(result.templateDigest) ||
    !DIGEST.test(result.toolchainDigest) ||
    !result.checkpoint ||
    !Number.isSafeInteger(result.checkpoint.revision) ||
    result.checkpoint.revision < 0 ||
    !DIGEST.test(result.checkpoint.digest) ||
    !Array.isArray(result.references) ||
    result.references.length !== 4
  ) {
    throw new Error('PROTOTYPE_PUBLICATION_RESULT_INVALID');
  }
  const required = new Set(['checkpoint', 'html', 'sources_zip', 'qa_evidence']);
  const artifacts = [];
  for (const reference of result.references) {
    if (
      !required.delete(reference?.kind) ||
      !safeObjectKey(reference.objectKey) ||
      !DIGEST.test(reference.digest) ||
      !Number.isSafeInteger(reference.size) ||
      reference.size < 0 ||
      typeof reference.contentType !== 'string' ||
      reference.contentType.length < 1 ||
      reference.contentType.length > 256 ||
      reference.jobId !== command.jobId ||
      reference.executionId !== command.executionId ||
      reference.revision !== command.expectedRevision ||
      reference.tenantId !== command.tenantId ||
      reference.templateDigest !== result.templateDigest ||
      reference.toolchainDigest !== result.toolchainDigest
    ) {
      throw new Error('PROTOTYPE_PUBLICATION_RESULT_INVALID');
    }
    artifacts.push({
      kind: reference.kind,
      objectKey: reference.objectKey,
      digest: reference.digest,
      size: reference.size,
      contentType: reference.contentType,
    });
  }
  if (
    required.size > 0 ||
    artifacts.find((artifact) => artifact.kind === 'checkpoint')?.digest !==
      result.checkpoint.digest
  ) {
    throw new Error('PROTOTYPE_PUBLICATION_RESULT_INVALID');
  }
  return {
    jobId: command.jobId,
    turnId: command.turnId,
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
    attemptId: command.attemptId,
    executionId: command.executionId,
    stage: 'publish',
    pipelineStep: 5,
    fenceToken: command.fenceToken,
    leaseId: deterministicLeaseId(command),
    target: result.target,
    checkpoint: result.checkpoint,
    templateDigest: result.templateDigest,
    toolchainDigest: result.toolchainDigest,
    artifacts,
  };
}

export async function readVerifiedStageFailure(command, outputRoot, configuredLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...configuredLimits };
  const bytes = await readBoundedRegularFile(
    path.join(path.resolve(outputRoot), 'failure.json'),
    limits.failureBytes,
  );
  let result;
  try {
    result = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('PROTOTYPE_STAGE_FAILURE_INVALID');
  }
  const codes = new Set([
    'PROTOTYPE_EXECUTION_FAILED',
    'PROTOTYPE_BUILD_FAILED',
    'PROTOTYPE_QA_FAILED',
    'PROTOTYPE_QA_INFRASTRUCTURE_FAILED',
  ]);
  const unsafeDiagnostic =
    /authorization|credential|api[_-]?key|signed.?url|object.?key|(?:^|\s)(?:\/(?:Users|home|workspace|tmp|private|var|run)\/|[a-zA-Z]:\\)/i;
  if (
    !validIdentity(command, result) ||
    result.type !== 'failed' ||
    !codes.has(result.code) ||
    typeof result.message !== 'string' ||
    result.message.length < 1 ||
    result.message.length > 2_048 ||
    typeof result.retryable !== 'boolean' ||
    !Array.isArray(result.diagnostics) ||
    result.diagnostics.length < 1 ||
    result.diagnostics.length > 20 ||
    result.diagnostics.some(
      (entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 2_048,
    ) ||
    unsafeDiagnostic.test(result.message) ||
    result.diagnostics.some((entry) => unsafeDiagnostic.test(entry)) ||
    (result.retryable &&
      (command.stage !== 'build_qa' ||
        !['PROTOTYPE_BUILD_FAILED', 'PROTOTYPE_QA_FAILED'].includes(result.code)))
  ) {
    throw new Error('PROTOTYPE_STAGE_FAILURE_INVALID');
  }
  return {
    jobId: command.jobId,
    turnId: command.turnId,
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
    attemptId: command.attemptId,
    executionId: command.executionId,
    stage: command.stage,
    pipelineStep: command.pipelineStep,
    fenceToken: command.fenceToken,
    leaseId: deterministicLeaseId(command),
    code: result.code,
    message: result.message,
    retryable: result.retryable,
    diagnostics: result.diagnostics,
  };
}

function validIdentity(command, result) {
  return (
    ['jobId', 'turnId', 'commandId', 'attemptId', 'executionId', 'stage'].every(
      (field) =>
        typeof command[field] === 'string' &&
        SAFE_ID.test(command[field]) &&
        result[field] === command[field],
    ) &&
    Number.isSafeInteger(command.expectedRevision) &&
    command.expectedRevision >= 0 &&
    result.expectedRevision === command.expectedRevision &&
    Number.isSafeInteger(command.fenceToken) &&
    command.fenceToken > 0 &&
    result.fenceToken === command.fenceToken &&
    result.pipelineStep === command.pipelineStep
  );
}

function assertExpectedResult(step, command, result) {
  if (step.stage === 'generation' && result.type !== 'code_done') {
    throw new Error('PROTOTYPE_STAGE_NOT_COMPLETABLE');
  }
  if (step.stage === 'transfer' && result.kind !== 'restored_workspace') {
    throw new Error('PROTOTYPE_STAGE_RESULT_INVALID');
  }
  if (step.stage === 'dependency_preparation' && result.kind !== 'dependency_bundle') {
    throw new Error('PROTOTYPE_STAGE_RESULT_INVALID');
  }
  if (step.stage === 'build_qa' && result.kind !== 'verified_snapshot') {
    throw new Error('PROTOTYPE_STAGE_RESULT_INVALID');
  }
  const outputDigest = result[step.digestField];
  if (typeof outputDigest !== 'string' || !DIGEST.test(outputDigest)) {
    throw new Error('PROTOTYPE_STAGE_RESULT_DIGEST_INVALID');
  }
  if (step.stage === 'transfer' && command.sourceDigest !== outputDigest) {
    throw new Error('PROTOTYPE_STAGE_RESULT_DIGEST_INVALID');
  }
  return outputDigest;
}

export function buildStageCompletion({ command, leaseId, result, checkpointRevision }) {
  if (
    !command ||
    !result ||
    !SAFE_ID.test(command.commandId ?? '') ||
    !SAFE_ID.test(leaseId ?? '') ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0 ||
    !Number.isSafeInteger(command.pipelineStep) ||
    command.pipelineStep < 0 ||
    command.pipelineStep > 4 ||
    !validIdentity(command, result)
  ) {
    throw new Error('PROTOTYPE_STAGE_RESULT_IDENTITY_INVALID');
  }
  const step = PIPELINE[command.pipelineStep];
  if (step.stage !== command.stage) throw new Error('PROTOTYPE_PIPELINE_TRANSITION_INVALID');
  const outputDigest = assertExpectedResult(step, command, result);
  if (
    command.pipelineStep === 0 &&
    (!Number.isSafeInteger(checkpointRevision) || checkpointRevision < 0)
  ) {
    throw new Error('PROTOTYPE_CHECKPOINT_REVISION_INVALID');
  }
  if (command.pipelineStep !== 0 && checkpointRevision !== undefined) {
    throw new Error('PROTOTYPE_CHECKPOINT_REVISION_INVALID');
  }
  return {
    jobId: command.jobId,
    turnId: command.turnId,
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
    attemptId: command.attemptId,
    executionId: command.executionId,
    stage: command.stage,
    fenceToken: command.fenceToken,
    leaseId,
    pipelineStep: command.pipelineStep,
    outputKind: step.outputKind,
    outputDigest,
    ...(command.pipelineStep === 0
      ? { checkpoint: { revision: checkpointRevision, digest: outputDigest } }
      : {}),
  };
}

export function buildStageWaiting({ command, leaseId, result, checkpointRevision }) {
  if (
    !command ||
    !result ||
    command.stage !== 'generation' ||
    command.pipelineStep !== 0 ||
    result.type !== 'waiting' ||
    !validIdentity(command, result) ||
    !['clarification', 'plan_approval'].includes(result.reason) ||
    typeof result.prompt !== 'string' ||
    result.prompt.length < 1 ||
    result.prompt.length > 2_048 ||
    !DIGEST.test(result.checkpointDigest) ||
    !SAFE_ID.test(leaseId ?? '') ||
    !Number.isSafeInteger(checkpointRevision) ||
    checkpointRevision < 0
  ) {
    throw new Error('PROTOTYPE_STAGE_WAITING_INVALID');
  }
  return {
    jobId: command.jobId,
    turnId: command.turnId,
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
    attemptId: command.attemptId,
    executionId: command.executionId,
    stage: 'generation',
    fenceToken: command.fenceToken,
    leaseId,
    pipelineStep: 0,
    reason: result.reason,
    prompt: result.prompt,
    checkpoint: { revision: checkpointRevision, digest: result.checkpointDigest },
  };
}

export class TrustedStageSupervisor {
  constructor({ writersStopped, readResult, completeStage }) {
    if (
      typeof writersStopped !== 'function' ||
      typeof readResult !== 'function' ||
      typeof completeStage !== 'function'
    ) {
      throw new Error('Prototype stage supervisor dependencies are required');
    }
    this.writersStopped = writersStopped;
    this.readResult = readResult;
    this.completeStage = completeStage;
  }

  async complete({ command, leaseId, checkpointRevision }) {
    if (!(await this.writersStopped(command))) {
      throw new Error('PROTOTYPE_WRITERS_NOT_QUIESCED');
    }
    const result = await this.readResult(command);
    const completion = buildStageCompletion({ command, leaseId, result, checkpointRevision });
    await this.completeStage(completion);
    return completion;
  }
}

export function deterministicLeaseId(command) {
  const ids = [
    command?.jobId,
    command?.turnId,
    command?.commandId,
    command?.attemptId,
    command?.executionId,
    command?.stage,
  ];
  if (
    !ids.every((value) => typeof value === 'string' && SAFE_ID.test(value)) ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0 ||
    !Number.isSafeInteger(command.fenceToken) ||
    command.fenceToken < 1
  ) {
    throw new Error('PROTOTYPE_STAGE_RESULT_IDENTITY_INVALID');
  }
  const tuple = [
    command.jobId,
    command.turnId,
    command.commandId,
    command.expectedRevision,
    command.attemptId,
    command.executionId,
    command.stage,
    command.fenceToken,
  ];
  return `lease_${createHash('sha256').update(tuple.join(':')).digest('hex').slice(0, 24)}`;
}

export class OrchestratedStageSupervisor {
  constructor({
    registerLease,
    waitForCompletion,
    completeStage,
    completeWaiting,
    completePublication,
    failStage,
    readResult = readVerifiedStageResult,
    readPublication = readVerifiedPublicationResult,
    readFailure = readVerifiedStageFailure,
  }) {
    if (
      typeof registerLease !== 'function' ||
      typeof waitForCompletion !== 'function' ||
      typeof completeStage !== 'function' ||
      typeof readResult !== 'function'
    ) {
      throw new Error('Prototype orchestrated supervisor dependencies are required');
    }
    this.registerLease = registerLease;
    this.waitForCompletion = waitForCompletion;
    this.completeStage = completeStage;
    this.completeWaiting = completeWaiting;
    this.completePublication = completePublication;
    this.failStage = failStage;
    this.readResult = readResult;
    this.readPublication = readPublication;
    this.readFailure = readFailure;
  }

  async prepare(command) {
    const leaseId = deterministicLeaseId(command);
    await this.registerLease({
      jobId: command.jobId,
      turnId: command.turnId,
      commandId: command.commandId,
      expectedRevision: command.expectedRevision,
      attemptId: command.attemptId,
      executionId: command.executionId,
      stage: command.stage,
      fenceToken: command.fenceToken,
      leaseId,
    });
    return leaseId;
  }

  async complete(command) {
    const leaseId = deterministicLeaseId(command);
    const outcome = await this.waitForCompletion(command);
    if (outcome.writersStopped !== true) throw new Error('PROTOTYPE_WRITERS_NOT_QUIESCED');
    if (typeof outcome.outputRoot !== 'string' || outcome.outputRoot.length === 0) {
      throw new Error('PROTOTYPE_STAGE_OUTPUT_INVALID');
    }
    if (outcome?.succeeded !== true) {
      if (typeof this.failStage !== 'function') throw new Error('PROTOTYPE_STAGE_EXECUTION_FAILED');
      const failure = await this.readFailure(command, outcome.outputRoot);
      await this.failStage(failure);
      return failure;
    }
    if (command.pipelineStep === 5) {
      if (typeof this.completePublication !== 'function') {
        throw new Error('PROTOTYPE_PUBLICATION_COMPLETION_UNAVAILABLE');
      }
      const publication = await this.readPublication(command, outcome.outputRoot);
      await this.completePublication(publication);
      return publication;
    }
    const result = await this.readResult(command, outcome.outputRoot);
    if (command.stage === 'generation' && result.type === 'waiting') {
      if (typeof this.completeWaiting !== 'function') {
        throw new Error('PROTOTYPE_WAITING_COMPLETION_UNAVAILABLE');
      }
      const waiting = buildStageWaiting({
        command,
        leaseId,
        result,
        checkpointRevision: command.expectedRevision + 1,
      });
      await this.completeWaiting(waiting);
      return waiting;
    }
    const completion = buildStageCompletion({
      command,
      leaseId,
      result,
      ...(command.pipelineStep === 0 ? { checkpointRevision: command.expectedRevision + 1 } : {}),
    });
    await this.completeStage(completion);
    return completion;
  }
}

export function createControlPlaneStageSupervisor({ client, waitForCompletion, readResult }) {
  if (
    !client ||
    typeof client.registerLease !== 'function' ||
    typeof client.completeStage !== 'function' ||
    typeof client.completePublication !== 'function' ||
    typeof client.completeWaiting !== 'function' ||
    typeof client.failStage !== 'function'
  ) {
    throw new Error('Prototype control plane client is required');
  }
  return new OrchestratedStageSupervisor({
    registerLease: (input) => client.registerLease(input),
    completeStage: (input) => client.completeStage(input),
    completeWaiting: (input) => client.completeWaiting(input),
    completePublication: (input) => client.completePublication(input),
    failStage: (input) => client.failStage(input),
    waitForCompletion,
    ...(readResult ? { readResult } : {}),
  });
}

export function createKubernetesStageSupervisor({
  client,
  scheduler,
  buildJobInput,
  outputRootFor,
  signal,
  readResult,
}) {
  if (
    !scheduler ||
    typeof scheduler.waitForExecution !== 'function' ||
    typeof buildJobInput !== 'function' ||
    typeof outputRootFor !== 'function'
  ) {
    throw new Error('Prototype Kubernetes supervisor dependencies are required');
  }
  return createControlPlaneStageSupervisor({
    client,
    readResult,
    waitForCompletion: async (command) => {
      const input = buildJobInput(command);
      const outcome = await scheduler.waitForExecution(input, { signal });
      const outputRoot = await outputRootFor(command, outcome);
      if (typeof outputRoot !== 'string' || outputRoot.length === 0) {
        throw new Error('PROTOTYPE_STAGE_OUTPUT_INVALID');
      }
      return { ...outcome, outputRoot };
    },
  });
}
