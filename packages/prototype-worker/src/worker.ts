import crypto from 'node:crypto';
import { parsePrototypeWorkerEvent, type PrototypeCommand, type PrototypeWorkerEvent } from './contracts';
import type { PrototypeLeaseMetadata } from './redis/lease';
import { safeWorkerError } from './safeErrors';

type ExecutionResult = { type: PrototypeWorkerEvent['type']; payload: Record<string, unknown> };
type WorkerDeps = {
  workerId: string;
  heartbeatIntervalMs?: number;
  abortExecution?(jobId: string, executionId: string): Promise<void>;
  onError?(error: Error, command: PrototypeCommand): void;
  source?: {
    next(): Promise<{ streamId: string; command: PrototypeCommand } | null>;
    close(): Promise<void>;
  };
  queue: { publishEvent(event: PrototypeWorkerEvent): Promise<void>; acknowledge(id: string): Promise<void> };
  leases: {
    acquire(
      jobId: string,
      workerId: string,
      metadata: PrototypeLeaseMetadata,
    ): Promise<{ leaseId: string } | null>;
    heartbeat?(jobId: string, leaseId: string): Promise<boolean>;
    isCurrent(jobId: string, leaseId: string): Promise<boolean>;
    release(jobId: string, leaseId: string): Promise<void> | void;
  };
  execute(command: PrototypeCommand, signal: AbortSignal): Promise<ExecutionResult>;
};

export class PrototypeWorker {
  public readonly deps: WorkerDeps;
  private readonly completed = new Set<string>();
  private readonly canceledExecutions = new Set<string>();
  private state: 'idle' | 'running' | 'stopping' | 'stopped' = 'idle';
  private activeController: AbortController | null = null;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
  }

  currentState() {
    return this.state;
  }

  private leaseMetadata(command: PrototypeCommand): PrototypeLeaseMetadata {
    return {
      executionId: command.executionId,
      revision: command.expectedRevision,
      turnId: command.turnId,
      commandId: command.commandId,
    };
  }

  async start(): Promise<void> {
    if (!this.deps.source) throw new Error('Prototype command source is unavailable');
    if (this.state !== 'idle') throw new Error('Prototype worker has already started');
    this.state = 'running';
    while (this.state === 'running') {
      const item = await this.deps.source.next();
      if (!item) break;
      await this.processCommand(item.streamId, item.command);
    }
    this.state = 'stopped';
  }

  async processCommand(streamId: string, command: PrototypeCommand): Promise<void> {
    try {
      await this.handleCommand(streamId, command);
    } catch (error) {
      this.deps.onError?.(error as Error, command);
      await this.publishFailure(streamId, command);
    }
  }

  private async publishFailure(streamId: string, command: PrototypeCommand): Promise<void> {
    if (this.canceledExecutions.delete(`${command.jobId}:${command.executionId}`)) {
      await this.deps.queue.acknowledge(streamId);
      return;
    }
    const lease = await this.deps.leases.acquire(
      command.jobId,
      this.deps.workerId,
      this.leaseMetadata(command),
    );
    if (!lease) return;
    try {
      if (!(await this.deps.leases.isCurrent(command.jobId, lease.leaseId))) return;
      const event = parsePrototypeWorkerEvent({
        schemaVersion: 1,
        eventId: `event_${crypto.randomUUID()}`,
        commandId: command.commandId,
        jobId: command.jobId,
        turnId: command.turnId,
        executionId: command.executionId,
        expectedRevision: command.expectedRevision,
        leaseId: lease.leaseId,
        type: 'failed',
        payload: safeWorkerError(null),
        createdAt: new Date().toISOString(),
      });
      await this.deps.queue.publishEvent(event);
      await this.deps.queue.acknowledge(streamId);
    } finally {
      await this.deps.leases.release(command.jobId, lease.leaseId);
    }
  }

  async stop(): Promise<void> {
    if (this.state !== 'running') return;
    this.state = 'stopping';
    this.activeController?.abort();
    await this.deps.source?.close();
  }

  async handleCommand(streamId: string, command: PrototypeCommand): Promise<void> {
    if (command.kind === 'cancel_execution') {
      if (this.deps.abortExecution) {
        this.canceledExecutions.add(`${command.jobId}:${command.executionId}`);
      }
      await this.deps.abortExecution?.(command.jobId, command.executionId);
      await this.deps.queue.acknowledge(streamId);
      return;
    }
    if (this.completed.has(command.commandId)) {
      await this.deps.queue.acknowledge(streamId);
      return;
    }
    const lease = await this.deps.leases.acquire(
      command.jobId,
      this.deps.workerId,
      this.leaseMetadata(command),
    );
    if (!lease) throw new Error('Prototype lease unavailable');
    const controller = new AbortController();
    this.activeController = controller;
    let leaseLost = false;
    const heartbeat = this.deps.leases.heartbeat
      ? setInterval(async () => {
          try {
            if (!(await this.deps.leases.heartbeat!(command.jobId, lease.leaseId))) {
              leaseLost = true;
              controller.abort();
            }
          } catch {
            leaseLost = true;
            controller.abort();
          }
        }, this.deps.heartbeatIntervalMs ?? 10_000)
      : undefined;
    try {
      let result: ExecutionResult;
      try {
        result = await this.deps.execute(command, controller.signal);
      } catch (error) {
        if (leaseLost) throw new Error('Prototype lease was lost during execution');
        throw error;
      }
      if (!(await this.deps.leases.isCurrent(command.jobId, lease.leaseId))) {
        throw new Error('Prototype lease was lost before result publication');
      }
      const event = parsePrototypeWorkerEvent({
        schemaVersion: 1,
        eventId: `event_${crypto.randomUUID()}`,
        commandId: command.commandId,
        jobId: command.jobId,
        turnId: command.turnId,
        executionId: command.executionId,
        expectedRevision: command.expectedRevision,
        leaseId: lease.leaseId,
        type: result.type,
        payload: result.payload,
        createdAt: new Date().toISOString(),
      });
      await this.deps.queue.publishEvent(event);
      this.completed.add(command.commandId);
      await this.deps.queue.acknowledge(streamId);
    } finally {
      if (this.activeController === controller) this.activeController = null;
      if (heartbeat) clearInterval(heartbeat);
      await this.deps.leases.release(command.jobId, lease.leaseId);
    }
  }
}
