const { PrototypeEventConsumer, eventDigest } = require('./PrototypeEventConsumer');

const event = {
  schemaVersion: 2, eventId: 'event_1', commandId: 'command_1', jobId: 'job_1',
  turnId: 'turn_1', expectedRevision: 1, attemptId: 'attempt_1', executionId: 'execution_1',
  stage: 'generation', fenceToken: 2, leaseId: 'lease_1',
  payload: { type: 'progress', phase: 'Planning' }, createdAt: '2026-09-24T10:00:00.000Z',
};
const job = {
  revision: 1, activeTurnId: 'turn_1', activeCommandId: 'command_1',
  activeAttemptId: 'attempt_1', activeExecutionId: 'execution_1',
  activeStage: 'generation', fenceToken: 2, activeLeaseId: 'lease_1', status: 'running',
};

function session() {
  return {
    withTransaction: jest.fn(async (callback) => callback()),
    endSession: jest.fn(),
  };
}

describe('PrototypeEventConsumer', () => {
  it('does not treat a transport retry timestamp as a different event effect', () => {
    expect(eventDigest(event)).toBe(eventDigest({ ...event, createdAt: '2030-01-01T00:00:00.000Z' }));
    expect(eventDigest(event)).not.toBe(eventDigest({
      ...event, payload: { type: 'progress', phase: 'Different' },
    }));
  });
  it('commits the receipt and event effect in one transaction', async () => {
    const activeSession = session();
    const deps = {
      startSession: jest.fn(async () => activeSession),
      claimEvent: jest.fn(async () => ({ created: true })),
      loadJob: jest.fn(async () => job),
      applyEvent: jest.fn(),
      pauseJob: jest.fn(),
      projectEvent: jest.fn(),
    };
    const consumer = new PrototypeEventConsumer(deps);
    await expect(consumer.consume('1-0', event)).resolves.toEqual({ applied: true, duplicate: false });
    expect(deps.claimEvent).toHaveBeenCalledWith({
      eventId: 'event_1', jobId: 'job_1', commandId: 'command_1', payloadType: 'progress',
      payloadDigest: eventDigest(event),
    }, activeSession);
    expect(deps.applyEvent).toHaveBeenCalledWith(event, activeSession);
    expect(deps.projectEvent).toHaveBeenCalledWith(
      { event, effect: undefined },
      activeSession,
    );
    expect(activeSession.endSession).toHaveBeenCalledTimes(1);
  });

  it('does not apply a duplicate receipt again', async () => {
    const activeSession = session();
    const applyEvent = jest.fn();
    const projectEvent = jest.fn();
    const consumer = new PrototypeEventConsumer({
      startSession: async () => activeSession,
      claimEvent: async () => ({ created: false }),
      loadJob: async () => job,
      applyEvent,
      pauseJob: jest.fn(),
      projectEvent,
    });
    await expect(consumer.consume('1-0', event)).resolves.toEqual({ applied: false, duplicate: true });
    expect(applyEvent).not.toHaveBeenCalled();
    expect(projectEvent).not.toHaveBeenCalled();
  });

  it('rolls back the receipt with the effect and always closes the session', async () => {
    const activeSession = session();
    const consumer = new PrototypeEventConsumer({
      startSession: async () => activeSession,
      claimEvent: async () => ({ created: true }),
      loadJob: async () => job,
      applyEvent: async () => { throw new Error('stale fence'); },
      pauseJob: jest.fn(),
    });
    await expect(consumer.consume('1-0', event)).rejects.toThrow('stale fence');
    expect(activeSession.endSession).toHaveBeenCalledTimes(1);
  });

  it('rolls back acceptance and receipt when durable message projection fails', async () => {
    const activeSession = session();
    const applyEvent = jest.fn(async () => ({ status: 'review' }));
    const projectEvent = jest.fn(async () => {
      throw new Error('projection failpoint');
    });
    const consumer = new PrototypeEventConsumer({
      startSession: async () => activeSession,
      claimEvent: async () => ({ created: true }),
      loadJob: async () => job,
      applyEvent,
      pauseJob: jest.fn(),
      projectEvent,
    });

    await expect(consumer.consume('1-0', event)).rejects.toThrow('projection failpoint');
    expect(applyEvent).toHaveBeenCalledWith(event, activeSession);
    expect(projectEvent).toHaveBeenCalledWith(
      { event, effect: { status: 'review' } },
      activeSession,
    );
    expect(activeSession.endSession).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['revision', { revision: 0 }],
    ['turn', { activeTurnId: 'turn_old' }],
    ['command', { activeCommandId: 'command_old' }],
    ['attempt', { activeAttemptId: 'attempt_old' }],
    ['execution', { activeExecutionId: 'execution_old' }],
    ['stage', { activeStage: 'build_qa' }],
    ['fence', { fenceToken: 1 }],
    ['lease', { activeLeaseId: 'lease_old' }],
  ])('persists but does not apply a stale %s event', async (_name, patch) => {
    const activeSession = session();
    const applyEvent = jest.fn();
    const consumer = new PrototypeEventConsumer({
      startSession: async () => activeSession,
      claimEvent: async () => ({ created: true }),
      loadJob: async () => ({ ...job, ...patch }),
      applyEvent,
      pauseJob: jest.fn(),
    });
    await expect(consumer.consume('1-0', event)).resolves.toEqual({
      applied: false, duplicate: false, stale: true,
    });
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['credentials_required', 'waiting_for_credentials'],
    ['funds_required', 'waiting_for_funds'],
  ])('applies %s through the atomic pause adapter', async (type, status) => {
    const activeSession = session();
    const pauseJob = jest.fn();
    const consumer = new PrototypeEventConsumer({
      startSession: async () => activeSession,
      claimEvent: async () => ({ created: true }),
      loadJob: async () => job,
      applyEvent: jest.fn(),
      pauseJob,
    });
    const controlEvent = {
      ...event,
      payload: {
        type,
        checkpoint: { revision: 3, digest: `sha256:${'a'.repeat(64)}` },
      },
    };
    await expect(consumer.consume('1-0', controlEvent)).resolves.toEqual({
      applied: true, duplicate: false,
    });
    expect(pauseJob).toHaveBeenCalledWith({
      job, event: controlEvent, status, checkpointRevision: 3,
    }, activeSession);
  });
});
