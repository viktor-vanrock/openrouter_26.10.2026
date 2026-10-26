import crypto from 'node:crypto';

export type PrototypeLeaseMetadata = {
  executionId: string;
  revision: number;
  turnId: string;
  commandId: string;
  attemptId?: string;
  stage?: string;
  fenceToken?: number;
};

export type PrototypeLeaseRecord = PrototypeLeaseMetadata & {
  jobId: string;
  workerId: string;
  leaseId: string;
  leaseExpiresAt: string;
};

export class RedisLeaseStore {
  constructor(private readonly redis: any, private readonly ttlMs = 45_000) {}

  async acquire(
    jobId: string,
    workerId: string,
    metadata: PrototypeLeaseMetadata,
  ): Promise<PrototypeLeaseRecord | null> {
    const leaseId = `${workerId}:${crypto.randomUUID()}`;
    const lease = {
      ...metadata,
      jobId,
      workerId,
      leaseId,
      leaseExpiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    };
    const result = await this.redis.set(
      `prototype:lease:${jobId}`,
      JSON.stringify(lease),
      'PX',
      this.ttlMs,
      'NX',
    );
    return result === 'OK' ? lease : null;
  }

  async heartbeat(jobId: string, leaseId: string): Promise<boolean> {
    return Number(
      await this.redis.eval(
        "local raw=redis.call('get',KEYS[1]); if not raw then return 0 end; local lease=cjson.decode(raw); if lease.leaseId~=ARGV[1] then return 0 end; lease.leaseExpiresAt=ARGV[3]; redis.call('set',KEYS[1],cjson.encode(lease),'PX',ARGV[2],'XX'); return 1",
        1,
        `prototype:lease:${jobId}`,
        leaseId,
        this.ttlMs,
        new Date(Date.now() + this.ttlMs).toISOString(),
      ),
    ) === 1;
  }

  async isCurrent(jobId: string, leaseId: string): Promise<boolean> {
    return (await this.load(jobId))?.leaseId === leaseId;
  }

  async load(jobId: string): Promise<PrototypeLeaseRecord | null> {
    const raw = await this.redis.get(`prototype:lease:${jobId}`);
    if (typeof raw !== 'string') return null;
    try {
      const lease = JSON.parse(raw) as Partial<PrototypeLeaseRecord>;
      if (
        lease.jobId !== jobId ||
        typeof lease.workerId !== 'string' ||
        typeof lease.leaseId !== 'string' ||
        typeof lease.executionId !== 'string' ||
        !Number.isInteger(lease.revision) ||
        typeof lease.turnId !== 'string' ||
        typeof lease.commandId !== 'string' ||
        !Number.isFinite(new Date(lease.leaseExpiresAt ?? '').getTime())
      ) return null;
      return lease as PrototypeLeaseRecord;
    } catch {
      return null;
    }
  }

  async release(jobId: string, leaseId: string): Promise<void> {
    await this.redis.eval(
      "local raw=redis.call('get',KEYS[1]); if not raw then return 0 end; local lease=cjson.decode(raw); if lease.leaseId==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      1,
      `prototype:lease:${jobId}`,
      leaseId,
    );
  }
}
