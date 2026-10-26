const {
  PrototypeOutboxPublisher,
  runPrototypeOutboxLoop,
  serializePrototypeOutboxCommand,
} = require('./PrototypeOutboxPublisher');

const command = {
  schemaVersion: 1,
  commandId: 'command_1',
  kind: 'start_turn',
  jobId: 'job_1',
  turnId: 'turn_1',
  tenantId: 'tenant_1',
  modelId: 'fake/model',
  expectedRevision: 1,
  executionId: 'execution_1',
  checkpointRevision: null,
  attachmentManifest: [],
  createdAt: new Date('2026-09-24T10:00:00.000Z'),
};

describe('PrototypeOutboxPublisher', () => {
  it('marks a durable command delivered only after Redis publish succeeds', async () => {
    const order = [];
    const publisher = new PrototypeOutboxPublisher({
      claimPending: jest.fn(async () => command),
      publish: jest.fn(async () => order.push('publish')),
      markPublished: jest.fn(async () => order.push('mark')),
    });
    await publisher.runOnce();
    expect(order).toEqual(['publish', 'mark']);
  });

  it('leaves the outbox pending when publish crashes', async () => {
    const deps = {
      claimPending: jest.fn(async () => command),
      publish: jest.fn(async () => { throw new Error('redis unavailable'); }),
      markPublished: jest.fn(),
      releaseClaim: jest.fn(),
    };
    await expect(new PrototypeOutboxPublisher(deps).runOnce()).rejects.toThrow('redis unavailable');
    expect(deps.markPublished).not.toHaveBeenCalled();
    expect(deps.releaseClaim).toHaveBeenCalledWith(command.commandId);
  });

  it('runs continuously and stops through an abort signal', async () => {
    const controller = new AbortController();
    const publisher = {
      runOnce: jest.fn()
        .mockResolvedValueOnce(true)
        .mockImplementationOnce(async () => { controller.abort(); return false; }),
    };
    await runPrototypeOutboxLoop({ publisher, signal: controller.signal, idleDelayMs: 1 });
    expect(publisher.runOnce).toHaveBeenCalledTimes(2);
  });

  it('does not report a connection-close error caused by shutdown', async () => {
    const controller = new AbortController();
    const onError = jest.fn();
    const publisher = {
      runOnce: jest.fn(async () => {
        controller.abort();
        throw new Error('Connection is closed.');
      }),
    };
    await runPrototypeOutboxLoop({ publisher, signal: controller.signal, onError });
    expect(onError).not.toHaveBeenCalled();
  });

  it('serializes a strict v2 transport envelope without persistence metadata', () => {
    const envelope = serializePrototypeOutboxCommand({
      ...command,
      schemaVersion: 2,
      kind: 'execute_stage',
      userId: 'user_1',
      attemptId: 'attempt_1',
      stage: 'generation',
      fenceToken: 2,
      checkpointRevision: 1,
      checkpointDigest: `sha256:${'a'.repeat(64)}`,
      sourceDigest: null,
      budget: {
        currency: 'USD', maxCostUsd: 1, maxRequests: 2,
        maxInputTokens: 100, maxOutputTokens: 50,
      },
      deadlineAt: new Date('2026-09-24T10:10:00.000Z'),
      status: 'pending',
      publishAttempts: 0,
    });
    expect(envelope).toEqual({
      schemaVersion: 2,
      commandId: 'command_1',
      kind: 'execute_stage',
      jobId: 'job_1',
      turnId: 'turn_1',
      tenantId: 'tenant_1',
      userId: 'user_1',
      modelId: 'fake/model',
      expectedRevision: 1,
      attemptId: 'attempt_1',
      executionId: 'execution_1',
      stage: 'generation',
      fenceToken: 2,
      checkpoint: { revision: 1, digest: `sha256:${'a'.repeat(64)}` },
      sourceDigest: null,
      dependencyDigest: null,
      budget: {
        currency: 'USD', maxCostUsd: 1, maxRequests: 2,
        maxInputTokens: 100, maxOutputTokens: 50,
      },
      createdAt: '2026-09-24T10:00:00.000Z',
      deadlineAt: '2026-09-24T10:10:00.000Z',
    });
    expect(envelope).not.toHaveProperty('status');
    expect(envelope).not.toHaveProperty('publishAttempts');
  });

  it('refuses to publish a v2 command without a user quota scope', () => {
    expect(() => serializePrototypeOutboxCommand({
      ...command, schemaVersion: 2, kind: 'execute_stage', attemptId: 'attempt_1',
      stage: 'generation', fenceToken: 1, budget: {
        currency: 'USD', maxCostUsd: 1, maxRequests: 2,
        maxInputTokens: null, maxOutputTokens: null,
      }, deadlineAt: new Date('2026-09-24T10:10:00.000Z'),
    })).toThrow('user scope');
  });

  it('serializes bounded repair diagnostics without persistence metadata', () => {
    const repair = { ordinal: 2, diagnostics: ['src/app.tsx: type mismatch'] };
    const envelope = serializePrototypeOutboxCommand({
      ...command, schemaVersion: 2, kind: 'execute_stage', userId: 'user_1',
      attemptId: 'attempt_2', stage: 'generation', pipelineStep: 0, fenceToken: 3,
      checkpointRevision: 2, checkpointDigest: `sha256:${'a'.repeat(64)}`,
      sourceDigest: `sha256:${'a'.repeat(64)}`, repair,
      budget: { currency: 'USD', maxCostUsd: 1, maxRequests: 2, maxInputTokens: null, maxOutputTokens: null },
      deadlineAt: new Date('2026-09-24T10:10:00.000Z'),
    });
    expect(envelope).toMatchObject({ repair });
  });
});
