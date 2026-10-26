import { PrototypeWorker } from './worker';

const command = {
  schemaVersion: 1 as const, commandId: 'command_1', kind: 'start_turn' as const,
  jobId: 'job_1', turnId: 'turn_1', tenantId: 'tenant_1', modelId: 'model_1',
  expectedRevision: 1, executionId: 'execution_1', checkpointRevision: null,
  attachmentManifest: [], createdAt: '2026-09-10T12:00:00.000Z',
};

describe('PrototypeWorker', () => {
  it('publishes a leased result before acknowledging a command', async () => {
    const order: string[] = [];
    const worker = new PrototypeWorker({
      workerId: 'worker_1',
      queue: { publishEvent: jest.fn(async () => { order.push('event'); }), acknowledge: jest.fn(async () => { order.push('ack'); }) },
      leases: { acquire: jest.fn(async () => ({ leaseId: 'lease_1' })), release: jest.fn(), isCurrent: jest.fn(async () => true) },
      execute: jest.fn(async () => ({ type: 'review_ready', payload: { prototypeSlug: 'crm' } })),
    });
    await worker.handleCommand('stream_1', command);
    expect(order).toEqual(['event', 'ack']);
    expect(worker.deps.queue.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ leaseId: 'lease_1', executionId: 'execution_1' }));
  });

  it('does not publish or acknowledge a late result after lease loss', async () => {
    const worker = new PrototypeWorker({
      workerId: 'worker_1',
      queue: { publishEvent: jest.fn(), acknowledge: jest.fn() },
      leases: { acquire: jest.fn(async () => ({ leaseId: 'lease_1' })), release: jest.fn(), isCurrent: jest.fn(async () => false) },
      execute: jest.fn(async () => ({ type: 'completed', payload: { prototypeSlug: 'crm' } })),
    });
    await expect(worker.handleCommand('stream_1', command)).rejects.toThrow('lease');
    expect(worker.deps.queue.publishEvent).not.toHaveBeenCalled();
    expect(worker.deps.queue.acknowledge).not.toHaveBeenCalled();
  });

  it('acknowledges a duplicate command without executing it twice', async () => {
    const deps = {
      workerId: 'worker_1', queue: { publishEvent: jest.fn(), acknowledge: jest.fn() },
      leases: { acquire: jest.fn(async () => ({ leaseId: 'lease_1' })), release: jest.fn(), isCurrent: jest.fn(async () => true) },
      execute: jest.fn(async () => ({ type: 'completed', payload: { prototypeSlug: 'crm' } })),
    };
    const worker = new PrototypeWorker(deps);
    await worker.handleCommand('stream_1', command);
    await worker.handleCommand('stream_2', command);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.queue.acknowledge).toHaveBeenCalledTimes(2);
  });

  it('aborts local work and withholds the ACK when heartbeat loses the lease', async () => {
    jest.useFakeTimers();
    const abort = jest.fn();
    const deps = {
      workerId: 'worker_1',
      heartbeatIntervalMs: 100,
      queue: { publishEvent: jest.fn(), acknowledge: jest.fn() },
      leases: {
        acquire: jest.fn(async () => ({ leaseId: 'lease_1' })),
        heartbeat: jest.fn(async () => false),
        release: jest.fn(),
        isCurrent: jest.fn(async () => true),
      },
      execute: jest.fn(
        async (_command: typeof command, signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              abort();
              reject(new Error('execution aborted'));
            });
          }),
      ),
    };
    const worker = new PrototypeWorker(deps);
    const handling = worker.handleCommand('stream_1', command);
    const assertion = expect(handling).rejects.toThrow('lease');
    await jest.advanceTimersByTimeAsync(100);
    await assertion;

    expect(abort).toHaveBeenCalledTimes(1);
    expect(deps.queue.publishEvent).not.toHaveBeenCalled();
    expect(deps.queue.acknowledge).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('handles cancel commands through the local abort seam without starting a turn', async () => {
    const cancel = { ...command, commandId: 'cancel_1', kind: 'cancel_execution' as const };
    const deps = {
      workerId: 'worker_1',
      queue: { publishEvent: jest.fn(), acknowledge: jest.fn() },
      leases: { acquire: jest.fn(), release: jest.fn(), isCurrent: jest.fn() },
      execute: jest.fn(),
      abortExecution: jest.fn(async () => undefined),
    };
    const worker = new PrototypeWorker(deps);
    await worker.handleCommand('stream_cancel', cancel);
    expect(deps.abortExecution).toHaveBeenCalledWith('job_1', 'execution_1');
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.queue.acknowledge).toHaveBeenCalledWith('stream_cancel');
  });

  it('publishes a safe failure when an unrelated cancel precedes a failed turn', async () => {
    const cancel = {
      ...command,
      commandId: 'cancel_old',
      executionId: 'execution_old',
      kind: 'cancel_execution' as const,
    };
    const deps = {
      workerId: 'worker_1',
      queue: { publishEvent: jest.fn(), acknowledge: jest.fn() },
      leases: {
        acquire: jest.fn(async () => ({ leaseId: 'lease_1' })),
        release: jest.fn(),
        isCurrent: jest.fn(async () => true),
      },
      execute: jest.fn(async () => { throw new Error('turn failed'); }),
      abortExecution: jest.fn(async () => undefined),
    };
    const worker = new PrototypeWorker(deps);
    await worker.handleCommand('stream_cancel', cancel);
    await worker.processCommand('stream_start', command);

    expect(deps.queue.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'failed' }));
    expect(deps.queue.acknowledge).toHaveBeenCalledWith('stream_start');
  });

  it('rejects an unsafe event payload before publication or acknowledgment', async () => {
    const deps = {
      workerId: 'worker_1',
      queue: { publishEvent: jest.fn(), acknowledge: jest.fn() },
      leases: { acquire: jest.fn(async () => ({ leaseId: 'lease_1' })), release: jest.fn(), isCurrent: jest.fn(async () => true) },
      execute: jest.fn(async () => ({ type: 'completed' as const, payload: { jobToken: 'secret' } })),
    };
    const worker = new PrototypeWorker(deps);
    await expect(worker.handleCommand('stream_1', command)).rejects.toThrow('sensitive');
    expect(deps.queue.publishEvent).not.toHaveBeenCalled();
    expect(deps.queue.acknowledge).not.toHaveBeenCalled();
  });
});
