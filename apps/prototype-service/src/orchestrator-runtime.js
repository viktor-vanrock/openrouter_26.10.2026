import { executionJobName } from './scheduler.js';
import { PrototypeControlPlaneError } from './control-plane-client.js';
import { commandLogContext, errorLogFields } from './service-log.js';

export class PrototypeOrchestratorRuntime {
  constructor({
    source,
    events,
    registry,
    scheduler,
    supervisor,
    quota,
    buildJobInput,
    onError,
    log = () => {},
    executionMode = 'scheduled',
  }) {
    if (
      !['scheduled', 'supervised'].includes(executionMode) ||
      (executionMode === 'supervised' && !supervisor)
    ) {
      throw new Error('Prototype execution mode is invalid');
    }
    this.executionMode = executionMode;
    this.source = source;
    this.events = events;
    this.registry = registry;
    this.scheduler = scheduler;
    this.supervisor = supervisor;
    this.quota = quota;
    this.buildJobInput = buildJobInput;
    this.onError = onError;
    this.log = log;
    this.running = false;
    this.ready = false;
  }

  async start({ signal }) {
    if (!this.ready) await this.prepare();
    this.running = true;
    while (!signal.aborted && this.running) {
      try {
        const item = await this.source.next();
        if (!item) continue;
        await this.handle(item);
      } catch (error) {
        this.onError?.(error);
        if (signal.aborted) break;
      }
    }
    this.ready = false;
  }

  async prepare() {
    await this.source.ensureGroup();
    this.ready = true;
  }

  async handle(item) {
    const context = commandLogContext(item.command);
    const started = Date.now();
    this.log('command.received', context);
    try {
      const result = await this.handleCommand(item);
      this.log(
        result.accepted === false || result.canceled === false
          ? 'command.rejected'
          : 'command.acknowledged',
        {
          ...context,
          reason: result.reason,
          duplicate: result.duplicate,
          elapsedMs: Date.now() - started,
        },
      );
      return result;
    } catch (error) {
      this.log('command.failed', {
        ...context,
        ...errorLogFields(error),
        elapsedMs: Date.now() - started,
      });
      throw error;
    }
  }

  async handleCommand({ streamId, command }) {
    if (command.kind === 'cancel_execution') {
      if (!(await this.registry.isAccepted(command))) {
        await this.events.publishRejected(command, 'stale_execution');
        await this.source.acknowledge(streamId);
        return { canceled: false, reason: 'stale_execution' };
      }
      if (this.executionMode === 'scheduled')
        await this.scheduler.cancelExecution(executionJobName(command));
      // Gateway stages observe the revoked Mongo fence; no fictitious stop attestation is emitted.
      await this.quota?.release(command);
      await this.source.acknowledge(streamId);
      return { canceled: true };
    }
    const quotaClaim = this.quota
      ? await this.quota.claim(command)
      : { accepted: true, duplicate: false };
    if (!quotaClaim.accepted) {
      await this.events.publishRejected(command, quotaClaim.reason);
      await this.source.acknowledge(streamId);
      return quotaClaim;
    }
    const claim = await this.registry.claim(command);
    if (!claim.accepted) {
      await this.quota?.release(command);
      await this.events.publishRejected(command, claim.reason);
      await this.source.acknowledge(streamId);
      return claim;
    }
    try {
      await this.supervisor?.prepare(command);
    } catch (error) {
      await this.quota?.release(command);
      if (
        error instanceof PrototypeControlPlaneError &&
        error.code === 'PROTOTYPE_STALE_REVISION' &&
        error.status === 409
      ) {
        // Mongo may already have accepted this completion before the previous
        // replica could ACK. Its fenced lease CAS also rejects canceled or
        // superseded commands; none of these deliveries should run again.
        await this.events.publishRejected(command, 'stale_execution');
        await this.source.acknowledge(streamId);
        return { accepted: false, reason: 'stale_execution' };
      }
      throw error;
    }
    if (!claim.scheduled && this.executionMode === 'scheduled') {
      await this.scheduler.createExecution(this.buildJobInput(command));
      if (!(await this.registry.markScheduled(command))) {
        throw new Error('Prototype execution registry expired before schedule confirmation');
      }
    }
    if (this.supervisor) {
      await this.supervisor.complete(command);
      await this.quota?.release(command);
    }
    await this.source.acknowledge(streamId);
    return claim;
  }

  async isReady() {
    return this.ready;
  }

  async stop() {
    this.running = false;
    this.ready = false;
    await this.source.close();
  }
}
