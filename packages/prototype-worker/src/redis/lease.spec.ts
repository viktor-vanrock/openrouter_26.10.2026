import { RedisLeaseStore } from './lease';

describe('RedisLeaseStore', () => {
  it('stores gateway-readable metadata and fences mutation by lease id', async () => {
    let value: string | null = null;
    const redis = {
      set: jest.fn(async (_key, next, _px, _ttl, mode) => {
        if (mode === 'NX' && value != null) return null;
        value = next;
        return 'OK';
      }),
      get: jest.fn(async () => value),
      eval: jest.fn(async (script, _count, _key, leaseId, _ttl?, expiresAt?) => {
        if (value == null) return 0;
        const lease = JSON.parse(value);
        if (lease.leaseId !== leaseId) return 0;
        if (script.includes("redis.call('del'")) {
          value = null;
          return 1;
        }
        lease.leaseExpiresAt = expiresAt;
        value = JSON.stringify(lease);
        return 1;
      }),
    };
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const leases = new RedisLeaseStore(redis, 500);
    const metadata = { executionId: 'execution_1', revision: 3, turnId: 'turn_1', commandId: 'command_1' };
    const acquired = await leases.acquire('job_1', 'worker_1', metadata);
    expect(acquired).toMatchObject({ ...metadata, jobId: 'job_1', leaseId: expect.stringMatching(/^worker_1:/) });
    await expect(leases.load('job_1')).resolves.toEqual(acquired);
    await expect(leases.isCurrent('job_1', 'stale')).resolves.toBe(false);
    now.mockReturnValue(1_200);
    await expect(leases.heartbeat('job_1', acquired!.leaseId)).resolves.toBe(true);
    await leases.release('job_1', acquired!.leaseId);
    await expect(leases.load('job_1')).resolves.toBeNull();
    now.mockRestore();
  });

  it('fails closed for malformed lease values', async () => {
    const leases = new RedisLeaseStore({ get: jest.fn(async () => '{"leaseId":"lease_1"}') });
    await expect(leases.load('job_1')).resolves.toBeNull();
    await expect(leases.isCurrent('job_1', 'lease_1')).resolves.toBe(false);
  });
});
