import { randomUUID } from 'node:crypto';
import {
  parsePrototypeWorkerEventV2,
  PROTOTYPE_EVENT_STREAM_V2,
} from '@librechat/prototype-worker';

export class RedisPrototypeEventPublisherV2 {
  constructor(redis, now = () => new Date()) {
    this.redis = redis;
    this.now = now;
  }

  async publishRejected(command, reason) {
    const event = parsePrototypeWorkerEventV2({
      schemaVersion: 2,
      eventId: `event_${randomUUID()}`,
      commandId: command.commandId,
      jobId: command.jobId,
      turnId: command.turnId,
      expectedRevision: command.expectedRevision,
      attemptId: command.attemptId,
      executionId: command.executionId,
      stage: command.stage,
      fenceToken: command.fenceToken,
      leaseId: 'orchestrator-rejection',
      createdAt: this.now().toISOString(),
      payload: {
        type: 'failed',
        code: 'PROTOTYPE_SERVICE_UNAVAILABLE',
        message:
          reason === 'deadline_expired'
            ? 'Prototype command deadline expired before scheduling.'
            : 'Prototype command identity conflicted with an accepted execution.',
        retryable: reason === 'deadline_expired',
      },
    });
    await this.redis.xadd(PROTOTYPE_EVENT_STREAM_V2, '*', 'event', JSON.stringify(event));
  }
}
