function identity(event, session) {
  return {
    jobId: event.jobId,
    turnId: event.turnId,
    commandId: event.commandId,
    expectedRevision: event.expectedRevision,
    attemptId: event.attemptId,
    executionId: event.executionId,
    stage: event.stage,
    fenceToken: event.fenceToken,
    leaseId: event.leaseId,
    session,
  };
}

function checkpoint(payload) {
  if (!payload?.checkpoint) return {};
  return {
    checkpointRevision: payload.checkpoint.revision,
    checkpointDigest: payload.checkpoint.digest,
  };
}

class PrototypeEventApplier {
  constructor({
    updateExecution, finishExecution, verifyPublication, acceptPublication, advanceStage, repairStage,
  }) {
    this.updateExecution = updateExecution;
    this.finishExecution = finishExecution;
    this.verifyPublication = verifyPublication;
    this.acceptPublication = acceptPublication;
    this.advanceStage = advanceStage;
    this.repairStage = repairStage;
  }

  async apply(event, session) {
    const input = identity(event, session);
    switch (event.payload.type) {
      case 'progress':
        return this.updateExecution({ ...input, phase: event.payload.phase });
      case 'stage_completed':
        if (typeof this.advanceStage !== 'function') {
          throw new Error('Prototype stage completion requires the pipeline transaction adapter');
        }
        return this.advanceStage({ event, session });
      case 'checkpoint_ready':
        return this.updateExecution({ ...input, ...checkpoint(event.payload) });
      case 'usage':
        if (event.payload.costUsd == null) {
          return this.finishExecution({ ...input, to: 'waiting_for_funds' });
        }
        return this.updateExecution({ ...input, actualCostDelta: event.payload.costUsd });
      case 'waiting':
        return this.finishExecution({
          ...input,
          to: 'waiting_for_input',
          waitingReason: event.payload.reason,
          latestPromptMessageId: event.eventId,
          ...checkpoint(event.payload),
        });
      case 'failed':
        if (event.stage === 'build_qa' && event.pipelineStep === 4 && event.payload.retryable === true &&
            ['PROTOTYPE_BUILD_FAILED', 'PROTOTYPE_QA_FAILED'].includes(event.payload.code) &&
            typeof this.repairStage === 'function') {
          const repair = await this.repairStage({ event, session });
          if (repair?.repaired) return repair;
        }
        return this.finishExecution({
          ...input,
          to: 'failed',
          failure: { code: event.payload.code, message: event.payload.message },
        });
      case 'canceled':
        return this.finishExecution({ ...input, to: 'canceled' });
      case 'review_ready':
      case 'completed':
        return this.applyPublication(event, session);
      case 'credentials_required':
      case 'funds_required':
        throw new Error('Prototype control event requires the pause adapter');
      default:
        throw new Error('Prototype worker event payload is unsupported');
    }
  }

  async applyPublication(event, session) {
    if (typeof this.verifyPublication !== 'function' || typeof this.acceptPublication !== 'function') {
      throw new Error('Prototype publication event requires the artifact transaction adapter');
    }
    const artifacts = await this.verifyPublication({ event, session });
    const byKind = new Map(artifacts.map((artifact) => [artifact.kind, artifact]));
    for (const kind of ['checkpoint', 'html', 'sources_zip', 'qa_evidence']) {
      const artifact = byKind.get(kind);
      const reference = event.payload.artifacts.find((item) => item.kind === kind);
      if (!artifact || artifact.executionId !== event.executionId || artifact.revision !== event.expectedRevision ||
          artifact.jobId !== event.jobId || artifact.digest !== reference?.digest ||
          artifact.templateDigest !== reference?.templateDigest || artifact.toolchainDigest !== reference?.toolchainDigest) {
        throw new Error('PROTOTYPE_ARTIFACT_METADATA_MISMATCH');
      }
    }
    if (byKind.get('checkpoint').digest !== event.payload.checkpoint.digest) {
      throw new Error('PROTOTYPE_ARTIFACT_METADATA_MISMATCH');
    }
    const html = byKind.get('html');
    const sources = byKind.get('sources_zip');
    return this.acceptPublication({
      ...identity(event, session), to: event.payload.type === 'completed' ? 'completed' : 'review',
      checkpointRevision: event.payload.checkpoint.revision, checkpointDigest: event.payload.checkpoint.digest,
      previewArtifactId: html.artifactId, previewDigest: html.digest,
      sourcesArtifactId: sources.artifactId, sourcesDigest: sources.digest,
      qaArtifactId: byKind.get('qa_evidence').artifactId,
      templateDigest: html.templateDigest, toolchainDigest: html.toolchainDigest,
    });
  }

  pause({ event, status, checkpointRevision }, session) {
    return this.finishExecution({
      ...identity(event, session),
      to: status,
      ...(checkpointRevision !== undefined ? { checkpointRevision } : {}),
      ...(event.payload.checkpoint?.digest
        ? { checkpointDigest: event.payload.checkpoint.digest }
        : {}),
    });
  }
}

module.exports = { PrototypeEventApplier };
