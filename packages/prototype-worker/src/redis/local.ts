import crypto from 'node:crypto';
import type { PrototypeCommand, PrototypeWorkerEvent } from '../contracts';
import type { PrototypeLeaseMetadata, PrototypeLeaseRecord } from './lease';

type Item = { streamId: string; command: PrototypeCommand };

export class LocalPrototypeQueue {
  private sequence = 0;
  private pending: Item[] = [];
  private claimed = new Map<string, Item>();
  private completed = new Set<string>();
  private known = new Set<string>();
  readonly events: PrototypeWorkerEvent[] = [];

  publishCommand(command: PrototypeCommand): void {
    if (this.known.has(command.commandId)) return;
    this.known.add(command.commandId);
    this.pending.push({ streamId: `local-${++this.sequence}`, command });
  }

  source(workerId: string) {
    return {
      next: async (): Promise<Item | null> => {
        let item = this.pending.shift() ?? null;
        while (item && this.completed.has(item.command.commandId)) item = this.pending.shift() ?? null;
        if (item) this.claimed.set(workerId, item);
        return item;
      },
      close: async (): Promise<void> => {
        const item = this.claimed.get(workerId);
        if (item) this.pending.unshift(item);
        this.claimed.delete(workerId);
      },
    };
  }

  async publishEvent(event: PrototypeWorkerEvent): Promise<void> {
    this.events.push(event);
  }

  async acknowledge(streamId: string): Promise<void> {
    for (const [workerId, item] of this.claimed) {
      if (item.streamId === streamId) {
        this.completed.add(item.command.commandId);
        this.claimed.delete(workerId);
      }
    }
  }
}

export class LocalLeaseStore {
  private readonly leases = new Map<string, PrototypeLeaseRecord & { expiresAt: number }>();

  constructor(private readonly ttlMs = 45_000, private readonly now = Date.now) {}

  async acquire(jobId: string, workerId: string, metadata: PrototypeLeaseMetadata) {
    const existing = this.leases.get(jobId);
    if (existing && existing.expiresAt > this.now()) return null;
    const expiresAt = this.now() + this.ttlMs;
    const lease = {
      ...metadata,
      jobId,
      workerId,
      leaseId: `${workerId}:${crypto.randomUUID()}`,
      leaseExpiresAt: new Date(expiresAt).toISOString(),
      expiresAt,
    };
    this.leases.set(jobId, lease);
    return lease;
  }

  async heartbeat(jobId: string, leaseId: string): Promise<boolean> {
    const current = this.leases.get(jobId);
    if (!current || current.leaseId !== leaseId || current.expiresAt <= this.now()) return false;
    current.expiresAt = this.now() + this.ttlMs;
    current.leaseExpiresAt = new Date(current.expiresAt).toISOString();
    return true;
  }

  async isCurrent(jobId: string, leaseId: string): Promise<boolean> {
    const current = this.leases.get(jobId);
    return current?.leaseId === leaseId && current.expiresAt > this.now();
  }

  async release(jobId: string, leaseId: string): Promise<void> {
    if ((await this.isCurrent(jobId, leaseId))) this.leases.delete(jobId);
  }

  async load(jobId: string): Promise<PrototypeLeaseRecord | null> {
    const current = this.leases.get(jobId);
    if (!current || current.expiresAt <= this.now()) return null;
    const { expiresAt: _expiresAt, ...lease } = current;
    return lease;
  }
}
