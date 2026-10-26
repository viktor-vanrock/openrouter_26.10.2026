function iso(value, name) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Prototype outbox ${name} is invalid`);
  return date.toISOString();
}

function serializePrototypeOutboxCommand(command) {
  if (command.schemaVersion === 1) {
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      kind: command.kind,
      jobId: command.jobId,
      turnId: command.turnId,
      tenantId: command.tenantId,
      modelId: command.modelId,
      expectedRevision: command.expectedRevision,
      executionId: command.executionId,
      checkpointRevision: command.checkpointRevision ?? null,
      attachmentManifest: command.attachmentManifest ?? [],
      createdAt: iso(command.createdAt, 'createdAt'),
    };
  }
  if (command.schemaVersion !== 2) throw new Error('Prototype outbox schema version is unsupported');
  if (typeof command.userId !== 'string' || command.userId.length === 0) {
    throw new Error('Prototype v2 outbox command requires a user scope');
  }
  if ((command.attachmentManifest?.length ?? 0) > 0) {
    throw new Error('Prototype v2 first release does not accept attachments');
  }
  const checkpoint = command.checkpointRevision == null
    ? null
    : { revision: command.checkpointRevision, digest: command.checkpointDigest };
  return {
    schemaVersion: 2,
    commandId: command.commandId,
    kind: command.kind,
    jobId: command.jobId,
    turnId: command.turnId,
    tenantId: command.tenantId,
    userId: command.userId,
    modelId: command.modelId,
    expectedRevision: command.expectedRevision,
    attemptId: command.attemptId,
    executionId: command.executionId,
    stage: command.stage,
    pipelineStep: command.pipelineStep,
    fenceToken: command.fenceToken,
    checkpoint,
    sourceDigest: command.sourceDigest ?? null,
    dependencyDigest: command.dependencyDigest ?? null,
    budget: command.budget,
    createdAt: iso(command.createdAt, 'createdAt'),
    deadlineAt: iso(command.deadlineAt, 'deadlineAt'),
    ...(command.repair ? { repair: command.repair } : {}),
  };
}

class PrototypeOutboxPublisher {
  constructor(deps) { this.deps = deps; }

  async runOnce() {
    const command = await this.deps.claimPending();
    if (!command) return false;
    try {
      await this.deps.publish(serializePrototypeOutboxCommand(command));
      await this.deps.markPublished(command.commandId);
      return true;
    } catch (error) {
      try { await this.deps.releaseClaim?.(command.commandId); } catch (releaseError) {
        this.deps.onError?.(releaseError);
      }
      throw error;
    }
  }
}

function abortableDelay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function runPrototypeOutboxLoop({ publisher, signal, idleDelayMs = 250, errorDelayMs = 1_000, onError }) {
  while (!signal.aborted) {
    try {
      const published = await publisher.runOnce();
      if (!published) await abortableDelay(idleDelayMs, signal);
    } catch (error) {
      if (!signal.aborted) onError?.(error);
      if (!signal.aborted) await abortableDelay(errorDelayMs, signal);
    }
  }
}

module.exports = {
  PrototypeOutboxPublisher,
  runPrototypeOutboxLoop,
  serializePrototypeOutboxCommand,
};
