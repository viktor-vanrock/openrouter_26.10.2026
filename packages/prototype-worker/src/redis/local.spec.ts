import { LocalPrototypeQueue, LocalLeaseStore } from './local';

describe('local queue and lease adapters', () => {
  const metadata = {
    executionId: 'execution_1', revision: 1, turnId: 'turn_1', commandId: 'command_1',
  };
  it('reclaims an unacknowledged command after a local worker closes', async () => {
    const queue = new LocalPrototypeQueue();
    queue.publishCommand({ commandId: 'command_1' } as never);
    const first = queue.source('worker_a');
    const item = await first.next();
    await first.close();
    const reclaimed = await queue.source('worker_b').next();
    expect(reclaimed).toEqual(item);
  });

  it('allows only one current lease and expires it deterministically', async () => {
    let now = 0;
    const leases = new LocalLeaseStore(100, () => now);
    const first = await leases.acquire('job_1', 'worker_a', metadata);
    expect(first).not.toBeNull();
    expect(await leases.acquire('job_1', 'worker_b', metadata)).toBeNull();
    await expect(leases.load('job_1')).resolves.toMatchObject({
      jobId: 'job_1', executionId: 'execution_1', revision: 1, leaseId: first!.leaseId,
    });
    now = 101;
    expect(await leases.acquire('job_1', 'worker_b', metadata)).not.toBeNull();
    expect(await leases.isCurrent('job_1', first!.leaseId)).toBe(false);
  });

  it('persists command deduplication in the local transport after acknowledgment', async () => {
    const queue = new LocalPrototypeQueue();
    const command = { commandId: 'command_1' } as never;
    queue.publishCommand(command);
    const source = queue.source('worker_a');
    const item = await source.next();
    await queue.acknowledge(item!.streamId);
    queue.publishCommand(command);
    expect(await queue.source('worker_b').next()).toBeNull();
  });

  it('does not enqueue the same unacknowledged command more than once', async () => {
    const queue = new LocalPrototypeQueue();
    const command = { commandId: 'command_1' } as never;
    queue.publishCommand(command);
    queue.publishCommand(command);
    expect((await queue.source('worker_a').next())?.command.commandId).toBe('command_1');
    expect(await queue.source('worker_b').next()).toBeNull();
  });
});
