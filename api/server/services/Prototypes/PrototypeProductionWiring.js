const { PrototypeModelProxy } = require('./PrototypeModelProxy');
const crypto = require('crypto');
const { createPrototypeTokenRouter } = require('../../routes/internal/prototypeTokens');
const { createPrototypeModelProxyRouter } = require('../../routes/internal/prototypeModelProxy');
const { createPrototypeControlPlaneRouter } = require('../../routes/internal/prototypeControlPlane');

function createTrustedExecutionLoader({ loadJob, loadLease, now = Date.now }) {
  if (typeof loadJob !== 'function' || typeof loadLease !== 'function') {
    throw new Error('Prototype trusted state loaders are required');
  }
  return async ({ jobId, turnId, commandId, attemptId, executionId, stage, fenceToken, leaseId }) => {
    const [job, lease] = await Promise.all([loadJob({ jobId }), loadLease({ jobId })]);
    const leaseExpiryMs = new Date(lease?.leaseExpiresAt).getTime();
    if (
      !job ||
      !lease ||
      ['completed', 'failed', 'canceled'].includes(job.status) ||
      !Number.isFinite(leaseExpiryMs) ||
      leaseExpiryMs <= now() ||
      job.jobId !== jobId ||
      job.activeTurnId !== turnId ||
      job.activeCommandId !== commandId ||
      job.activeAttemptId !== attemptId ||
      job.activeExecutionId !== executionId ||
      job.activeStage !== stage ||
      job.fenceToken !== fenceToken ||
      lease.jobId !== jobId ||
      lease.turnId !== turnId ||
      lease.commandId !== commandId ||
      lease.attemptId !== attemptId ||
      lease.executionId !== executionId ||
      lease.stage !== stage ||
      lease.fenceToken !== fenceToken ||
      lease.leaseId !== leaseId ||
      lease.revision !== job.revision
    ) {
      return null;
    }
    return {
      jobId: job.jobId,
      userId: job.userId,
      tenantId: job.tenantId,
      modelId: job.modelId,
      turnId: job.activeTurnId,
      commandId: job.activeCommandId,
      attemptId: job.activeAttemptId,
      executionId: job.activeExecutionId,
      stage: job.activeStage,
      fenceToken: job.fenceToken,
      revision: job.revision,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.leaseExpiresAt,
    };
  };
}

function createPrototypeInternalRouters({
  config,
  authenticateWorker,
  loadJob,
  loadLease,
  tokenService,
  getUserKeyValues,
  requestUpstream,
  publishControlEvent,
  publishUsage,
  registerLease,
  completeStage,
  completeWaiting,
  completePublication,
  startSession,
  registerArtifacts,
  baseUrl,
}) {
  if (config?.enabled !== true) return null;
  if (typeof authenticateWorker !== 'function') {
    throw new Error('Prototype worker identity seam is required');
  }
  if (
    !tokenService ||
    typeof tokenService.issue !== 'function' ||
    typeof tokenService.verify !== 'function' ||
    typeof getUserKeyValues !== 'function' ||
    typeof requestUpstream !== 'function' ||
    typeof publishControlEvent !== 'function' ||
    typeof baseUrl !== 'string' ||
    baseUrl.length === 0
  ) {
    throw new Error('Prototype proxy dependencies are required');
  }
  const loadExecution = createTrustedExecutionLoader({ loadJob, loadLease });
  const proxy = new PrototypeModelProxy({
    verifyToken: (token) => tokenService.verify(token),
    getUserKeyValues,
    requestUpstream,
    publishControlEvent,
    publishUsage,
    baseUrl,
  });
  const routers = {
    tokens: createPrototypeTokenRouter({ authenticateWorker, loadExecution, tokenService }),
    modelProxy: createPrototypeModelProxyRouter({ proxy }),
  };
  if (typeof registerLease === 'function') {
    const publicationCompletion = completePublication ?? (
      typeof startSession === 'function' && typeof registerArtifacts === 'function'
        ? createDurablePublicationCompletion({
          startSession,
          registerArtifacts,
          publishControlEvent,
        })
        : undefined
    );
    routers.controlPlane = createPrototypeControlPlaneRouter({
      authenticateService: authenticateWorker,
      registerLease,
      completeStage: completeStage ?? publishControlEvent,
      completeWaiting: completeWaiting ?? publishControlEvent,
      completePublication: publicationCompletion,
    });
  }
  return routers;
}

function mountPrototypeInternalRouters({ app, routers }) {
  if (!routers) return false;
  app.use('/internal/prototype-tokens', routers.tokens);
  app.use('/internal/prototype-model/v1', routers.modelProxy);
  if (routers.controlPlane) {
    app.use('/internal/prototype-control/v2', routers.controlPlane);
  }
  return true;
}

function createDurablePauseJob({ applyPause }) {
  if (typeof applyPause !== 'function') {
    throw new Error('Prototype atomic pause adapter is required');
  }
  return ({ job, event, status, checkpointRevision }) =>
    applyPause({
      jobId: job.jobId,
      turnId: event.turnId,
      commandId: event.commandId,
      expectedRevision: job.revision,
      attemptId: event.attemptId,
      executionId: event.executionId,
      stage: event.stage,
      fenceToken: event.fenceToken,
      leaseId: event.leaseId,
      eventId: event.eventId,
      status,
      patch: {
        waitingReason: null,
        ...(checkpointRevision !== undefined ? { checkpointRevision } : {}),
      },
    });
}

function createDurablePublicationCompletion({ startSession, registerArtifacts, publishControlEvent }) {
  if (typeof startSession !== 'function' || typeof registerArtifacts !== 'function' ||
      typeof publishControlEvent !== 'function') {
    throw new Error('Prototype durable publication dependencies are required');
  }
  return async (input) => {
    const session = await startSession();
    let registered;
    try {
      await session.withTransaction(async () => {
        registered = await registerArtifacts({ ...input, session });
      });
    } finally {
      await session.endSession();
    }
    if (!registered?.eventCreatedAt || !Array.isArray(registered.artifacts)) {
      throw new Error('Prototype artifact registration returned an invalid result');
    }
    const order = ['checkpoint', 'html', 'sources_zip', 'qa_evidence'];
    const artifacts = [...registered.artifacts].sort(
      (left, right) => order.indexOf(left.kind) - order.indexOf(right.kind),
    );
    const eventId = `event_${crypto.createHash('sha256').update(JSON.stringify({
      commandId: input.commandId,
      executionId: input.executionId,
      expectedRevision: input.expectedRevision,
      target: input.target,
      artifacts: artifacts.map((artifact) => [artifact.kind, artifact.sha256]),
    })).digest('hex').slice(0, 24)}`;
    const event = {
      schemaVersion: 2,
      eventId,
      jobId: input.jobId,
      turnId: input.turnId,
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      attemptId: input.attemptId,
      executionId: input.executionId,
      stage: 'publish',
      pipelineStep: 5,
      fenceToken: input.fenceToken,
      leaseId: input.leaseId,
      payload: {
        type: input.target,
        checkpoint: input.checkpoint,
        artifacts: artifacts.map((artifact) => ({
          artifactId: String(artifact.artifactId),
          kind: artifact.kind,
          digest: `sha256:${artifact.sha256}`,
          size: artifact.size,
          contentType: artifact.contentType,
          executionId: artifact.executionId,
          revision: artifact.revision,
          templateDigest: artifact.templateDigest,
          toolchainDigest: artifact.toolchainDigest,
        })),
      },
      createdAt: new Date(registered.eventCreatedAt).toISOString(),
    };
    await publishControlEvent(event);
    return { eventId, event };
  };
}

module.exports = {
  createTrustedExecutionLoader,
  createPrototypeInternalRouters,
  mountPrototypeInternalRouters,
  createDurablePauseJob,
  createDurablePublicationCompletion,
};
