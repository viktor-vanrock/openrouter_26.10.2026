const crypto = require('crypto');

function eventDigest(event) {
  const { createdAt: _createdAt, ...effect } = event;
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(effect)).digest('hex')}`;
}

class PrototypeEventConsumer {
  constructor({ startSession, claimEvent, loadJob, applyEvent, pauseJob, projectEvent }) {
    this.startSession = startSession;
    this.claimEvent = claimEvent;
    this.loadJob = loadJob;
    this.applyEvent = applyEvent;
    this.pauseJob = pauseJob;
    this.projectEvent = projectEvent;
  }

  async consume(_streamId, event) {
    const session = await this.startSession();
    let outcome;
    try {
      await session.withTransaction(async () => {
        const claim = await this.claimEvent({
          eventId: event.eventId,
          jobId: event.jobId,
          commandId: event.commandId,
          payloadType: event.payload.type,
          payloadDigest: eventDigest(event),
        }, session);
        if (!claim.created) {
          outcome = { applied: false, duplicate: true };
          return;
        }
        const job = await this.loadJob(event, session);
        const current =
          job &&
          job.revision === event.expectedRevision &&
          job.activeTurnId === event.turnId &&
          job.activeCommandId === event.commandId &&
          job.activeAttemptId === event.attemptId &&
          job.activeExecutionId === event.executionId &&
          job.activeStage === event.stage &&
          (event.pipelineStep === undefined || (job.pipelineStep ?? 0) === event.pipelineStep) &&
          job.fenceToken === event.fenceToken &&
          job.activeLeaseId === event.leaseId;
        if (!current) {
          outcome = { applied: false, duplicate: false, stale: true };
          return;
        }
        const pauseStatus = {
          credentials_required: 'waiting_for_credentials',
          funds_required: 'waiting_for_funds',
        }[event.payload.type];
        let effect;
        if (pauseStatus) {
          const checkpointRevision = event.payload.checkpoint?.revision;
          const result = await this.pauseJob({
            job,
            event,
            status: pauseStatus,
            ...(Number.isSafeInteger(checkpointRevision) && checkpointRevision >= 0
              ? { checkpointRevision }
              : {}),
          }, session);
          if (result === false) {
            outcome = { applied: false, duplicate: false, stale: true };
            return;
          }
          effect = result;
        } else {
          effect = await this.applyEvent(event, session);
        }
        await this.projectEvent?.({ event, effect }, session);
        outcome = { applied: true, duplicate: false };
      });
      return outcome;
    } finally {
      await session.endSession();
    }
  }
}

module.exports = { PrototypeEventConsumer, eventDigest };
