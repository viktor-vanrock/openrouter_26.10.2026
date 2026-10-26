const express = require('express');
const crypto = require('crypto');

const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,256}$/;
const STAGES = new Set(['generation', 'transfer', 'dependency_preparation', 'build_qa', 'publish']);
const ID_FIELDS = ['jobId', 'turnId', 'commandId', 'attemptId', 'executionId', 'leaseId'];

function leaseInput(body) {
  if (
    !body ||
    Object.keys(body).length !== 9 ||
    !ID_FIELDS.every((field) => typeof body[field] === 'string' && SAFE_ID.test(body[field])) ||
    !STAGES.has(body.stage) ||
    !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
    !Number.isSafeInteger(body.fenceToken) || body.fenceToken < 1
  ) return null;
  return {
    jobId: body.jobId,
    turnId: body.turnId,
    commandId: body.commandId,
    expectedRevision: body.expectedRevision,
    attemptId: body.attemptId,
    executionId: body.executionId,
    stage: body.stage,
    fenceToken: body.fenceToken,
    leaseId: body.leaseId,
  };
}

const COMPLETION_KINDS = new Set([
  'checkpoint', 'checkpoint_restored', 'dependency_bundle', 'dependencies_restored', 'verified_snapshot',
]);
const COMPLETION_PIPELINE = [
  { stage: 'generation', outputKind: 'checkpoint' },
  { stage: 'transfer', outputKind: 'checkpoint_restored' },
  { stage: 'dependency_preparation', outputKind: 'dependency_bundle' },
  { stage: 'transfer', outputKind: 'dependencies_restored' },
  { stage: 'build_qa', outputKind: 'verified_snapshot' },
];

function stageCompletionInput(body) {
  const allowed = new Set([
    ...ID_FIELDS, 'expectedRevision', 'stage', 'fenceToken', 'pipelineStep',
    'outputKind', 'outputDigest', 'checkpoint',
  ]);
  if (
    !body || Object.keys(body).some((key) => !allowed.has(key)) ||
    !ID_FIELDS.every((field) => typeof body[field] === 'string' && SAFE_ID.test(body[field])) ||
    !STAGES.has(body.stage) || !COMPLETION_KINDS.has(body.outputKind) ||
    !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
    !Number.isSafeInteger(body.fenceToken) || body.fenceToken < 1 ||
    !Number.isSafeInteger(body.pipelineStep) || body.pipelineStep < 0 || body.pipelineStep > 4 ||
    !/^sha256:[a-f0-9]{64}$/.test(body.outputDigest)
  ) return null;
  const expected = COMPLETION_PIPELINE[body.pipelineStep];
  if (!expected || expected.stage !== body.stage || expected.outputKind !== body.outputKind) return null;
  if ((body.pipelineStep === 0) !== (body.checkpoint !== undefined)) return null;
  if (body.checkpoint !== undefined && (
    !body.checkpoint || Object.keys(body.checkpoint).some((key) => !['revision', 'digest'].includes(key)) ||
    !Number.isSafeInteger(body.checkpoint.revision) || body.checkpoint.revision < 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(body.checkpoint.digest)
  )) return null;
  return {
    schemaVersion: 2,
    eventId: `event_${crypto.createHash('sha256').update(`${body.executionId}:${body.pipelineStep}`).digest('hex').slice(0, 24)}`,
    jobId: body.jobId, turnId: body.turnId, commandId: body.commandId,
    expectedRevision: body.expectedRevision, attemptId: body.attemptId,
    executionId: body.executionId, stage: body.stage, pipelineStep: body.pipelineStep,
    fenceToken: body.fenceToken, leaseId: body.leaseId,
    payload: {
      type: 'stage_completed', outputKind: body.outputKind, outputDigest: body.outputDigest,
      artifacts: [],
      ...(body.checkpoint ? { checkpoint: body.checkpoint } : {}),
    },
    createdAt: new Date().toISOString(),
  };
}

function waitingInput(body) {
  const allowed = new Set([
    ...ID_FIELDS, 'expectedRevision', 'stage', 'fenceToken', 'pipelineStep',
    'reason', 'prompt', 'checkpoint',
  ]);
  const unsafeText = /authorization|credential|api[_-]?key|signed.?url|object.?key|(?:^|\s)(?:\/(?:Users|home|private|var|run)\/|[a-zA-Z]:\\)/i;
  if (
    !body || Object.keys(body).some((key) => !allowed.has(key)) ||
    !ID_FIELDS.every((field) => typeof body[field] === 'string' && SAFE_ID.test(body[field])) ||
    body.stage !== 'generation' || body.pipelineStep !== 0 ||
    !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
    !Number.isSafeInteger(body.fenceToken) || body.fenceToken < 1 ||
    !['clarification', 'plan_approval'].includes(body.reason) ||
    typeof body.prompt !== 'string' || body.prompt.length < 1 || body.prompt.length > 2_048 ||
    unsafeText.test(body.prompt) ||
    !body.checkpoint || Object.keys(body.checkpoint).some((key) => !['revision', 'digest'].includes(key)) ||
    !Number.isSafeInteger(body.checkpoint.revision) || body.checkpoint.revision < 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(body.checkpoint.digest)
  ) return null;
  return {
    schemaVersion: 2,
    eventId: `event_${crypto.createHash('sha256').update(
      `${body.executionId}:waiting:${body.reason}:${body.checkpoint.digest}`,
    ).digest('hex').slice(0, 24)}`,
    jobId: body.jobId, turnId: body.turnId, commandId: body.commandId,
    expectedRevision: body.expectedRevision, attemptId: body.attemptId,
    executionId: body.executionId, stage: 'generation', pipelineStep: 0,
    fenceToken: body.fenceToken, leaseId: body.leaseId,
    payload: {
      type: 'waiting', reason: body.reason, prompt: body.prompt,
      checkpoint: body.checkpoint,
    },
    createdAt: new Date().toISOString(),
  };
}

const FAILURE_CODES = new Set([
  'PROTOTYPE_EXECUTION_FAILED', 'PROTOTYPE_DEADLINE_EXCEEDED',
  'PROTOTYPE_BUDGET_EXCEEDED', 'PROTOTYPE_DEPENDENCY_REJECTED',
  'PROTOTYPE_BUILD_FAILED', 'PROTOTYPE_QA_FAILED',
  'PROTOTYPE_ARTIFACT_REJECTED', 'PROTOTYPE_LEASE_LOST',
  'PROTOTYPE_SERVICE_UNAVAILABLE',
]);

function stageFailureInput(body) {
  const allowed = new Set([
    ...ID_FIELDS, 'expectedRevision', 'stage', 'fenceToken', 'pipelineStep',
    'code', 'message', 'retryable', 'diagnostics',
  ]);
  const pipeline = ['generation', 'transfer', 'dependency_preparation', 'transfer', 'build_qa', 'publish'];
  const unsafeDiagnostic = /authorization|credential|api[_-]?key|signed.?url|object.?key|(?:^|\s)(?:\/(?:Users|home|private|var|run)\/|[a-zA-Z]:\\)/i;
  if (!body || Object.keys(body).some((key) => !allowed.has(key)) ||
      !ID_FIELDS.every((field) => typeof body[field] === 'string' && SAFE_ID.test(body[field])) ||
      !STAGES.has(body.stage) || !Number.isSafeInteger(body.pipelineStep) ||
      pipeline[body.pipelineStep] !== body.stage ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
      !Number.isSafeInteger(body.fenceToken) || body.fenceToken < 1 ||
      !FAILURE_CODES.has(body.code) || typeof body.message !== 'string' ||
      body.message.length < 1 || body.message.length > 2_048 || typeof body.retryable !== 'boolean' ||
      !Array.isArray(body.diagnostics) || body.diagnostics.length < 1 || body.diagnostics.length > 20 ||
      body.diagnostics.some((entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 2_048) ||
      unsafeDiagnostic.test(body.message) || body.diagnostics.some((entry) => unsafeDiagnostic.test(entry)) ||
      (body.retryable && (body.stage !== 'build_qa' ||
        !['PROTOTYPE_BUILD_FAILED', 'PROTOTYPE_QA_FAILED'].includes(body.code)))) return null;
  return {
    schemaVersion: 2,
    eventId: `event_${crypto.createHash('sha256').update(
      `${body.commandId}:${body.executionId}:${body.pipelineStep}:failed:${body.code}`,
    ).digest('hex').slice(0, 24)}`,
    jobId: body.jobId, turnId: body.turnId, commandId: body.commandId,
    expectedRevision: body.expectedRevision, attemptId: body.attemptId,
    executionId: body.executionId, stage: body.stage, pipelineStep: body.pipelineStep,
    fenceToken: body.fenceToken, leaseId: body.leaseId,
    payload: {
      type: 'failed', code: body.code, message: body.message,
      retryable: body.retryable, diagnostics: [...body.diagnostics],
    },
    createdAt: new Date().toISOString(),
  };
}

const PUBLICATION_KINDS = new Set(['checkpoint', 'html', 'sources_zip', 'qa_evidence']);

function safeObjectKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_024 &&
    !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') &&
    !value.split('/').includes('..');
}

function publicationInput(body) {
  const allowed = new Set([
    ...ID_FIELDS, 'expectedRevision', 'stage', 'fenceToken', 'pipelineStep',
    'target', 'checkpoint', 'templateDigest', 'toolchainDigest', 'artifacts',
  ]);
  if (
    !body || Object.keys(body).some((key) => !allowed.has(key)) ||
    !ID_FIELDS.every((field) => typeof body[field] === 'string' && SAFE_ID.test(body[field])) ||
    body.stage !== 'publish' || body.pipelineStep !== 5 ||
    !['review_ready', 'completed'].includes(body.target) ||
    !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0 ||
    !Number.isSafeInteger(body.fenceToken) || body.fenceToken < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(body.templateDigest) ||
    !/^sha256:[a-f0-9]{64}$/.test(body.toolchainDigest) ||
    !body.checkpoint || Object.keys(body.checkpoint).some((key) => !['revision', 'digest'].includes(key)) ||
    !Number.isSafeInteger(body.checkpoint.revision) || body.checkpoint.revision < 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(body.checkpoint.digest) ||
    !Array.isArray(body.artifacts) || body.artifacts.length !== 4
  ) return null;
  const kinds = new Set();
  for (const artifact of body.artifacts) {
    if (!artifact || Object.keys(artifact).some((key) =>
      !['kind', 'objectKey', 'digest', 'size', 'contentType'].includes(key)) ||
      !PUBLICATION_KINDS.has(artifact.kind) || kinds.has(artifact.kind) ||
      !safeObjectKey(artifact.objectKey) || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
      !Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > 2_000_000_000 ||
      typeof artifact.contentType !== 'string' || artifact.contentType.length < 1 ||
      artifact.contentType.length > 256
    ) return null;
    kinds.add(artifact.kind);
  }
  if ([...PUBLICATION_KINDS].some((kind) => !kinds.has(kind))) return null;
  const checkpoint = body.artifacts.find((artifact) => artifact.kind === 'checkpoint');
  if (checkpoint.digest !== body.checkpoint.digest) return null;
  return {
    jobId: body.jobId, turnId: body.turnId, commandId: body.commandId,
    expectedRevision: body.expectedRevision, attemptId: body.attemptId,
    executionId: body.executionId, stage: body.stage, pipelineStep: body.pipelineStep,
    fenceToken: body.fenceToken, leaseId: body.leaseId, target: body.target,
    checkpoint: body.checkpoint, templateDigest: body.templateDigest,
    toolchainDigest: body.toolchainDigest,
    artifacts: body.artifacts.map((artifact) => ({ ...artifact })),
  };
}

function createPrototypeControlPlaneRouter({
  authenticateService, registerLease, completeStage, completeWaiting, completePublication, heartbeat,
}) {
  if (typeof authenticateService !== 'function' || typeof registerLease !== 'function') {
    throw new Error('Prototype control plane dependencies are required');
  }
  const router = express.Router();
  router.post('/heartbeat', async (req, res) => {
    let authenticated;
    try {
      authenticated = await authenticateService(req);
    } catch {
      return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
    }
    if (!authenticated) {
      return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED' } });
    }
    if (!req.body || Object.keys(req.body).length !== 1 || req.body.ready !== true) {
      return res.status(422).json({ error: { code: 'PROTOTYPE_INVALID_REQUEST' } });
    }
    if (typeof heartbeat !== 'function') {
      return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
    }
    try {
      await heartbeat();
      return res.status(200).json({ accepted: true });
    } catch {
      return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
    }
  });
  router.post('/leases', async (req, res) => {
    if (!(await authenticateService(req))) {
      return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED' } });
    }
    const input = leaseInput(req.body);
    if (!input) return res.status(422).json({ error: { code: 'PROTOTYPE_INVALID_REQUEST' } });
    try {
      const job = await registerLease(input);
      return res.status(200).json({
        jobId: job.jobId,
        revision: job.revision,
        fenceToken: job.fenceToken,
        leaseId: job.activeLeaseId,
      });
    } catch (error) {
      const code = error?.code === 'PROTOTYPE_STALE_REVISION'
        ? 'PROTOTYPE_STALE_REVISION'
        : 'PROTOTYPE_SERVICE_UNAVAILABLE';
      return res.status(code === 'PROTOTYPE_STALE_REVISION' ? 409 : 503).json({ error: { code } });
    }
  });
  router.post('/stage-completions', async (req, res) => {
    if (!(await authenticateService(req))) {
      return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED' } });
    }
    if (typeof completeStage !== 'function') {
      return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
    }
    const event = stageCompletionInput(req.body);
    if (!event) return res.status(422).json({ error: { code: 'PROTOTYPE_INVALID_REQUEST' } });
    try {
      await completeStage(event);
      return res.status(202).json({
        eventId: event.eventId,
        accepted: true,
      });
    } catch (error) {
      const stale = error?.code === 'PROTOTYPE_STALE_REVISION';
      return res.status(stale ? 409 : 503).json({
        error: { code: stale ? 'PROTOTYPE_STALE_REVISION' : 'PROTOTYPE_SERVICE_UNAVAILABLE' },
      });
    }
  });
  router.post('/waiting', async (req, res) => {
    if (!(await authenticateService(req))) {
      return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED' } });
    }
    if (typeof completeWaiting !== 'function') {
      return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
    }
    const event = waitingInput(req.body);
    if (!event) return res.status(422).json({ error: { code: 'PROTOTYPE_INVALID_REQUEST' } });
    try {
      await completeWaiting(event);
      return res.status(202).json({ eventId: event.eventId, accepted: true });
    } catch (error) {
      const stale = error?.code === 'PROTOTYPE_STALE_REVISION';
      return res.status(stale ? 409 : 503).json({
        error: { code: stale ? 'PROTOTYPE_STALE_REVISION' : 'PROTOTYPE_SERVICE_UNAVAILABLE' },
      });
    }
  });
  router.post('/stage-failures', async (req, res) => {
    if (!(await authenticateService(req))) {
      return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED' } });
    }
    if (typeof completeStage !== 'function') {
      return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
    }
    const event = stageFailureInput(req.body);
    if (!event) return res.status(422).json({ error: { code: 'PROTOTYPE_INVALID_REQUEST' } });
    try {
      await completeStage(event);
      return res.status(202).json({ eventId: event.eventId, accepted: true });
    } catch (error) {
      const stale = error?.code === 'PROTOTYPE_STALE_REVISION';
      return res.status(stale ? 409 : 503).json({
        error: { code: stale ? 'PROTOTYPE_STALE_REVISION' : 'PROTOTYPE_SERVICE_UNAVAILABLE' },
      });
    }
  });
  router.post('/publications', async (req, res) => {
    if (!(await authenticateService(req))) {
      return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED' } });
    }
    if (typeof completePublication !== 'function') {
      return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
    }
    const input = publicationInput(req.body);
    if (!input) return res.status(422).json({ error: { code: 'PROTOTYPE_INVALID_REQUEST' } });
    try {
      const publication = await completePublication(input);
      return res.status(202).json({ eventId: publication.eventId, accepted: true });
    } catch (error) {
      const stale = error?.code === 'PROTOTYPE_STALE_REVISION';
      return res.status(stale ? 409 : 503).json({
        error: { code: stale ? 'PROTOTYPE_STALE_REVISION' : 'PROTOTYPE_SERVICE_UNAVAILABLE' },
      });
    }
  });
  return router;
}

module.exports = {
  createPrototypeControlPlaneRouter,
  leaseInput,
  publicationInput,
  stageCompletionInput,
  waitingInput,
  stageFailureInput,
};
