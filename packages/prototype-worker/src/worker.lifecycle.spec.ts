import { PrototypeWorker } from './worker';

const command = {
  schemaVersion: 1 as const,
  commandId: 'command_1',
  kind: 'start_turn' as const,
  jobId: 'job_1',
  turnId: 'turn_1',
  tenantId: 'tenant_1',
  modelId: 'model_1',
  expectedRevision: 1,
  executionId: 'execution_1',
  checkpointRevision: null,
  attachmentManifest: [],
  createdAt: '2026-09-11T09:00:00.000Z',
};

describe('PrototypeWorker local lifecycle', () => {
  it('runs the local command source until stop and acknowledges successful work', async () => {
    let resolveNext: ((value: null) => void) | undefined;
    const source = {
      next: jest
        .fn()
        .mockResolvedValueOnce({ streamId: 'stream_1', command })
        .mockImplementationOnce(() => new Promise<null>((resolve) => { resolveNext = resolve; })),
      close: jest.fn(async () => resolveNext?.(null)),
    };
    const deps = {
      workerId: 'worker_1',
      source,
      queue: {
        publishEvent: jest.fn(async () => undefined),
        acknowledge: jest.fn(async () => undefined),
      },
      leases: {
        acquire: jest.fn(async () => ({ leaseId: 'lease_1' })),
        release: jest.fn(),
        isCurrent: jest.fn(async () => true),
      },
      execute: jest.fn(async () => ({ type: 'completed' as const, payload: { prototypeSlug: 'crm' } })),
    };
    const worker = new PrototypeWorker(deps);

    const running = worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    await worker.stop();
    await running;

    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.queue.acknowledge).toHaveBeenCalledWith('stream_1');
    expect(source.close).toHaveBeenCalledTimes(1);
    expect(worker.currentState()).toBe('stopped');
  });

  it('continues with the next local command after one attempt fails', async () => {
    const second = { ...command, commandId: 'command_2', jobId: 'job_2', executionId: 'execution_2' };
    const source = {
      next: jest
        .fn()
        .mockResolvedValueOnce({ streamId: 'stream_1', command })
        .mockResolvedValueOnce({ streamId: 'stream_2', command: second })
        .mockResolvedValueOnce(null),
      close: jest.fn(),
    };
    const deps = {
      workerId: 'worker_1', source,
      queue: { publishEvent: jest.fn(), acknowledge: jest.fn() },
      leases: { acquire: jest.fn(async () => ({ leaseId: 'lease_1' })), release: jest.fn(), isCurrent: jest.fn(async () => true) },
      execute: jest
        .fn()
        .mockRejectedValueOnce(new Error('first failed'))
        .mockResolvedValueOnce({ type: 'completed' as const, payload: { prototypeSlug: 'crm' } }),
      onError: jest.fn(),
    };
    const worker = new PrototypeWorker(deps);
    await worker.start();
    expect(deps.execute).toHaveBeenCalledTimes(2);
    expect(deps.onError).toHaveBeenCalledWith(expect.any(Error), command);
    expect(deps.queue.acknowledge).toHaveBeenCalledWith('stream_2');
  });

  it('aborts an active local execution when the worker stops', async () => {
    let resolveNext: ((value: null) => void) | undefined;
    const source = {
      next: jest
        .fn()
        .mockResolvedValueOnce({ streamId: 'stream_1', command })
        .mockImplementationOnce(() => new Promise<null>((resolve) => { resolveNext = resolve; })),
      close: jest.fn(async () => resolveNext?.(null)),
    };
    const aborted = jest.fn();
    const worker = new PrototypeWorker({
      workerId: 'worker_1', source,
      queue: { publishEvent: jest.fn(), acknowledge: jest.fn() },
      leases: { acquire: jest.fn(async () => ({ leaseId: 'lease_1' })), release: jest.fn(), isCurrent: jest.fn(async () => true) },
      execute: async (_command, signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted();
          reject(new Error('stopped'));
        });
      }),
      onError: jest.fn(),
    });

    const running = worker.start();
    await new Promise((resolve) => setImmediate(resolve));
    await worker.stop();
    await running;
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(worker.currentState()).toBe('stopped');
  });

  it('rejects starting the same worker lifecycle more than once', async () => {
    const worker = new PrototypeWorker({
      workerId: 'worker_1',
      source: { next: jest.fn(async () => null), close: jest.fn() },
      queue: { publishEvent: jest.fn(), acknowledge: jest.fn() },
      leases: { acquire: jest.fn(), release: jest.fn(), isCurrent: jest.fn() },
      execute: jest.fn(),
    });
    await worker.start();
    await expect(worker.start()).rejects.toThrow('already started');
  });

  it('publishes a safe failed event for execution errors before acknowledging', async () => {
    const source = {
      next: jest.fn().mockResolvedValueOnce({ streamId: 'stream_1', command }).mockResolvedValueOnce(null),
      close: jest.fn(),
    };
    const queue = { publishEvent: jest.fn(), acknowledge: jest.fn() };
    const worker = new PrototypeWorker({
      workerId: 'worker_1', source, queue,
      leases: { acquire: jest.fn(async () => ({ leaseId: 'lease_1' })), release: jest.fn(), isCurrent: jest.fn(async () => true) },
      execute: jest.fn(async () => { throw new Error('Bearer secret-job-token at /tmp/job'); }),
      onError: jest.fn(),
    });
    await worker.start();
    expect(queue.publishEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'failed', payload: { code: 'PROTOTYPE_EXECUTION_FAILED', message: 'Prototype execution failed' },
    }));
    expect(queue.acknowledge).toHaveBeenCalledWith('stream_1');
    expect(JSON.stringify(queue.publishEvent.mock.calls)).not.toContain('secret-job-token');
  });
});
