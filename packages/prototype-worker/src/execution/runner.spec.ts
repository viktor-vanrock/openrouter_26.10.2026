import { PrototypeExecutionRunner } from './runner';

describe('PrototypeExecutionRunner', () => {
  it('retries failed checks with bounded feedback and returns review readiness', async () => {
    const client = {
      runTurn: jest
        .fn()
        .mockResolvedValueOnce('PROTOTYPE_CODE_DONE: crm')
        .mockResolvedValueOnce('PROTOTYPE_CODE_DONE: crm')
        .mockResolvedValueOnce('Summary\nPROTOTYPE_READY: crm'),
    };
    const checks = jest
      .fn()
      .mockResolvedValueOnce({ clean: false, output: 'type error' })
      .mockResolvedValueOnce({ clean: true, output: '' });
    const runner = new PrototypeExecutionRunner({ client, checks, maxCheckRetries: 2 });

    await expect(runner.run({ workspace: '/tmp/job_1' }, 'build it', jest.fn())).resolves.toEqual({
      type: 'review_ready', payload: { prototypeSlug: 'crm', summary: 'Summary' },
    });
    expect(checks).toHaveBeenCalledTimes(2);
    expect(checks).toHaveBeenCalledWith('/tmp/job_1');
    expect(client.runTurn).toHaveBeenCalledTimes(3);
  });

  it('fails after the configured check retry limit', async () => {
    const client = { runTurn: jest.fn(async () => 'PROTOTYPE_CODE_DONE: crm') };
    const runner = new PrototypeExecutionRunner({
      client,
      checks: jest.fn(async () => ({ clean: false, output: 'still broken' })),
      maxCheckRetries: 1,
    });
    await expect(runner.run({ workspace: '/tmp/job_1' }, 'build it', jest.fn())).rejects.toThrow('after 1');
  });

  it('retries transient inactivity failures within the configured bound', async () => {
    const client = {
      runTurn: jest
        .fn()
        .mockRejectedValueOnce(new Error('OpenCode inactivity timeout after 1000ms'))
        .mockResolvedValueOnce('Summary\nPROTOTYPE_READY: crm'),
    };
    const runner = new PrototypeExecutionRunner({
      client,
      checks: jest.fn(),
      maxTurnRetries: 1,
    });
    await expect(runner.run({ workspace: '/tmp/job_1' }, 'build it', jest.fn())).resolves.toMatchObject({
      type: 'review_ready',
    });
    expect(client.runTurn).toHaveBeenNthCalledWith(
      2,
      { workspace: '/tmp/job_1' },
      expect.stringContaining('timed out'),
      expect.any(Function),
    );
  });

  it('fails when inactivity retries are exhausted', async () => {
    const runner = new PrototypeExecutionRunner({
      client: { runTurn: jest.fn(async () => { throw new Error('OpenCode inactivity timeout'); }) },
      checks: jest.fn(),
      maxTurnRetries: 1,
    });
    await expect(runner.run({ workspace: '/tmp/job_1' }, 'build it', jest.fn())).rejects.toThrow('inactivity timeout');
  });

  it('returns the explicit waiting reason without running checks', async () => {
    const checks = jest.fn();
    const runner = new PrototypeExecutionRunner({
      client: { runTurn: jest.fn(async () => 'Which audience?\nWAITING_FOR_CLARIFICATION') },
      checks,
    });
    await expect(runner.run({ workspace: '/tmp/job_1' }, 'build it', jest.fn())).resolves.toEqual({
      type: 'waiting', payload: { waitingReason: 'clarification', text: 'Which audience?' },
    });
    expect(checks).not.toHaveBeenCalled();
  });

  it('returns finalized output as a completed result', async () => {
    const runner = new PrototypeExecutionRunner({
      client: { runTurn: jest.fn(async () => 'Approved\nPROTOTYPE_FINALIZED: crm') },
      checks: jest.fn(),
    });
    await expect(runner.run({ workspace: '/tmp/job_1' }, 'approve', jest.fn())).resolves.toEqual({
      type: 'completed', payload: { prototypeSlug: 'crm', summary: 'Approved' },
    });
  });
});
