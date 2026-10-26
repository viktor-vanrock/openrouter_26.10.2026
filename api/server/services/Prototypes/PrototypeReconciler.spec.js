const { PrototypeReconciler } = require('./PrototypeReconciler');

describe('PrototypeReconciler', () => {
  it('requeues queued jobs missing a Redis command and expired running jobs', async () => {
    const deps = {
      findRecoverable: jest.fn(async () => [
        { jobId: 'job_1', status: 'queued', commandMissing: true },
        { jobId: 'job_2', status: 'running', leaseExpired: true },
      ]),
      requeue: jest.fn(),
    };
    await new PrototypeReconciler(deps).runOnce();
    expect(deps.requeue).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job_1' }));
    expect(deps.requeue).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job_2' }));
  });

  it('replays durable publication after a process restart without changing command identity', async () => {
    const job = { jobId: 'job_1', status: 'queued', commandMissing: true, activeCommandId: 'command_1' };
    const deps = { findRecoverable: jest.fn(async () => [job]), requeue: jest.fn() };
    await new PrototypeReconciler(deps).runOnce();
    await new PrototypeReconciler(deps).runOnce();
    expect(deps.requeue).toHaveBeenNthCalledWith(1, job);
    expect(deps.requeue).toHaveBeenNthCalledWith(2, job);
  });
});
