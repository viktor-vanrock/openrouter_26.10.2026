const {
  createTrustedExecutionLoader,
  createPrototypeInternalRouters,
  createDurablePauseJob,
  createDurablePublicationCompletion,
} = require('./PrototypeProductionWiring');

describe('Prototype Phase 4 production wiring', () => {
  it('derives refresh claims from the current job and lease instead of caller input', async () => {
    const loadJob = jest.fn(async () => ({
      jobId: 'job_1',
      userId: 'user_1',
      tenantId: 'tenant_1',
      modelId: 'fixed/model',
      activeTurnId: 'turn_1',
      activeCommandId: 'command_1',
      activeAttemptId: 'attempt_1',
      revision: 7,
      activeExecutionId: 'execution_1',
      activeStage: 'generation',
      fenceToken: 3,
    }));
    const loadLease = jest.fn(async () => ({
      jobId: 'job_1',
      turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
      executionId: 'execution_1',
      stage: 'generation', fenceToken: 3,
      revision: 7,
      leaseId: 'lease_1',
      leaseExpiresAt: new Date('2033-05-18T03:33:50.000Z'),
    }));
    const loadExecution = createTrustedExecutionLoader({ loadJob, loadLease });

    await expect(
      loadExecution({
        jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
        executionId: 'execution_1', stage: 'generation', fenceToken: 3, leaseId: 'lease_1',
      }),
    ).resolves.toEqual({
      jobId: 'job_1',
      userId: 'user_1',
      tenantId: 'tenant_1',
      modelId: 'fixed/model',
      turnId: 'turn_1',
      commandId: 'command_1',
      attemptId: 'attempt_1',
      executionId: 'execution_1',
      stage: 'generation',
      fenceToken: 3,
      revision: 7,
      leaseId: 'lease_1',
      leaseExpiresAt: new Date('2033-05-18T03:33:50.000Z'),
    });
    expect(loadJob).toHaveBeenCalledWith({ jobId: 'job_1' });
    expect(loadLease).toHaveBeenCalledWith({ jobId: 'job_1' });
  });

  it.each([
    ['terminal job', { status: 'canceled' }, {}],
    ['expired lease', {}, { leaseExpiresAt: new Date('2000-01-01T00:00:00.000Z') }],
  ])('refuses trusted refresh state for a %s', async (_name, jobPatch, leasePatch) => {
    const now = new Date('2033-05-18T03:33:20.000Z').getTime();
    const loadExecution = createTrustedExecutionLoader({
      now: () => now,
      loadJob: jest.fn(async () => ({
        jobId: 'job_1', userId: 'user_1', tenantId: 'tenant_1', modelId: 'fixed/model',
        status: 'running', revision: 7, activeTurnId: 'turn_1', activeCommandId: 'command_1',
        activeAttemptId: 'attempt_1', activeExecutionId: 'execution_1',
        activeStage: 'generation', fenceToken: 3, ...jobPatch,
      })),
      loadLease: jest.fn(async () => ({
        jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
        executionId: 'execution_1', stage: 'generation', fenceToken: 3,
        revision: 7, leaseId: 'lease_1',
        leaseExpiresAt: new Date('2033-05-18T03:33:50.000Z'), ...leasePatch,
      })),
    });

    await expect(
      loadExecution({
        jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
        executionId: 'execution_1', stage: 'generation', fenceToken: 3, leaseId: 'lease_1',
      }),
    ).resolves.toBeNull();
  });

  it('exposes internal routers only behind the feature gate and an explicit worker identity seam', () => {
    const dependencies = {
      authenticateWorker: jest.fn(),
      loadJob: jest.fn(),
      loadLease: jest.fn(),
      tokenService: { issue: jest.fn(), verify: jest.fn() },
      getUserKeyValues: jest.fn(),
      requestUpstream: jest.fn(),
      publishControlEvent: jest.fn(),
      baseUrl: 'https://gateway.internal/v1',
    };

    expect(createPrototypeInternalRouters({ config: { enabled: false }, ...dependencies })).toBeNull();
    expect(() =>
      createPrototypeInternalRouters({
        config: { enabled: true },
        ...dependencies,
        authenticateWorker: undefined,
      }),
    ).toThrow('worker identity');
    expect(createPrototypeInternalRouters({ config: { enabled: true }, ...dependencies })).toEqual({
      tokens: expect.any(Function),
      modelProxy: expect.any(Function),
    });
  });

  it('mounts only the two internal route prefixes when safe dependencies are assembled', () => {
    const use = jest.fn();
    const routers = {
      tokens: jest.fn(),
      modelProxy: jest.fn(),
    };
    const { mountPrototypeInternalRouters } = require('./PrototypeProductionWiring');

    expect(mountPrototypeInternalRouters({ app: { use }, routers: null })).toBe(false);
    expect(mountPrototypeInternalRouters({ app: { use }, routers })).toBe(true);
    expect(use.mock.calls).toEqual([
      ['/internal/prototype-tokens', routers.tokens],
      ['/internal/prototype-model/v1', routers.modelProxy],
    ]);
  });

  it('adds the v2 control-plane endpoint only when the lease CAS adapter is provided', () => {
    const use = jest.fn();
    const registerLease = jest.fn();
    const dependencies = {
      config: { enabled: true }, authenticateWorker: jest.fn(), loadJob: jest.fn(), loadLease: jest.fn(),
      tokenService: { issue: jest.fn(), verify: jest.fn() }, getUserKeyValues: jest.fn(),
      requestUpstream: jest.fn(), publishControlEvent: jest.fn(),
      baseUrl: 'https://gateway.internal/v1', registerLease,
    };
    const routers = createPrototypeInternalRouters(dependencies);
    const { mountPrototypeInternalRouters } = require('./PrototypeProductionWiring');
    mountPrototypeInternalRouters({ app: { use }, routers });
    expect(routers.controlPlane).toEqual(expect.any(Function));
    expect(use.mock.calls.at(-1)).toEqual(['/internal/prototype-control/v2', routers.controlPlane]);
  });

  it('publishes stage completions through the durable event stream by default', async () => {
    const publishControlEvent = jest.fn(async () => undefined);
    const dependencies = {
      config: { enabled: true }, authenticateWorker: jest.fn(async () => true),
      loadJob: jest.fn(), loadLease: jest.fn(),
      tokenService: { issue: jest.fn(), verify: jest.fn() }, getUserKeyValues: jest.fn(),
      requestUpstream: jest.fn(), publishControlEvent,
      baseUrl: 'https://gateway.internal/v1', registerLease: jest.fn(),
    };
    const routers = createPrototypeInternalRouters(dependencies);
    const layer = routers.controlPlane.stack.find((candidate) =>
      candidate.route?.path === '/stage-completions');
    const handler = layer.route.stack.at(-1).handle;
    const req = {
      body: {
        jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', expectedRevision: 2,
        attemptId: 'attempt_1', executionId: 'execution_1', stage: 'generation',
        fenceToken: 3, leaseId: 'lease_1', pipelineStep: 0, outputKind: 'checkpoint',
        outputDigest: `sha256:${'a'.repeat(64)}`,
        checkpoint: { revision: 1, digest: `sha256:${'b'.repeat(64)}` },
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);

    expect(publishControlEvent).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job_1', payload: expect.objectContaining({ type: 'stage_completed' }),
    }));
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('uses an explicit stage completion publisher when supplied', async () => {
    const publishControlEvent = jest.fn(async () => undefined);
    const completeStage = jest.fn(async () => undefined);
    const dependencies = {
      config: { enabled: true }, authenticateWorker: jest.fn(async () => true),
      loadJob: jest.fn(), loadLease: jest.fn(),
      tokenService: { issue: jest.fn(), verify: jest.fn() }, getUserKeyValues: jest.fn(),
      requestUpstream: jest.fn(), publishControlEvent,
      baseUrl: 'https://gateway.internal/v1', registerLease: jest.fn(), completeStage,
    };
    const routers = createPrototypeInternalRouters(dependencies);
    const layer = routers.controlPlane.stack.find((candidate) =>
      candidate.route?.path === '/stage-completions');
    const handler = layer.route.stack.at(-1).handle;
    const req = {
      body: {
        jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', expectedRevision: 2,
        attemptId: 'attempt_1', executionId: 'execution_1', stage: 'generation',
        fenceToken: 3, leaseId: 'lease_1', pipelineStep: 0, outputKind: 'checkpoint',
        outputDigest: `sha256:${'a'.repeat(64)}`,
        checkpoint: { revision: 1, digest: `sha256:${'b'.repeat(64)}` },
      },
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);

    expect(completeStage).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job_1' }));
    expect(publishControlEvent).not.toHaveBeenCalled();
  });

  it('assembles durable publication registration before the control-plane event', async () => {
    const published = [];
    const registerArtifacts = jest.fn(async () => ({
      artifacts: [
        ['checkpoint', 'a'], ['html', 'b'], ['sources_zip', 'c'], ['qa_evidence', 'd'],
      ].map(([kind, value], index) => ({
        artifactId: String(index + 1).padStart(24, '0'), kind, sha256: value.repeat(64),
        size: 10, contentType: 'application/octet-stream', executionId: 'execution_1',
        revision: 2, templateDigest: `sha256:${'e'.repeat(64)}`,
        toolchainDigest: `sha256:${'f'.repeat(64)}`,
      })),
      eventCreatedAt: new Date('2026-09-25T10:00:00.000Z'),
    }));
    const dependencies = {
      config: { enabled: true }, authenticateWorker: jest.fn(async () => true),
      loadJob: jest.fn(), loadLease: jest.fn(),
      tokenService: { issue: jest.fn(), verify: jest.fn() }, getUserKeyValues: jest.fn(),
      requestUpstream: jest.fn(), publishControlEvent: async (event) => published.push(event),
      baseUrl: 'https://gateway.internal/v1', registerLease: jest.fn(), registerArtifacts,
      startSession: async () => ({
        withTransaction: async (callback) => callback(), endSession: jest.fn(),
      }),
    };
    const routers = createPrototypeInternalRouters(dependencies);
    const layer = routers.controlPlane.stack.find((candidate) => candidate.route?.path === '/publications');
    const handler = layer.route.stack.at(-1).handle;
    const req = { body: {
      jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', expectedRevision: 2,
      attemptId: 'attempt_1', executionId: 'execution_1', stage: 'publish', pipelineStep: 5,
      fenceToken: 3, leaseId: 'lease_1', target: 'review_ready',
      checkpoint: { revision: 2, digest: `sha256:${'a'.repeat(64)}` },
      templateDigest: `sha256:${'e'.repeat(64)}`, toolchainDigest: `sha256:${'f'.repeat(64)}`,
      artifacts: [
        ['checkpoint', 'a'], ['html', 'b'], ['sources_zip', 'c'], ['qa_evidence', 'd'],
      ].map(([kind, value]) => ({
        kind, objectKey: `tenant/job/${kind}`, digest: `sha256:${value.repeat(64)}`,
        size: 10, contentType: 'application/octet-stream',
      })),
    } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(req, res);
    expect(registerArtifacts).toHaveBeenCalled();
    expect(published).toHaveLength(1);
    expect(JSON.stringify(published)).not.toContain('tenant/job/');
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('fails assembly when a required proxy dependency is missing', () => {
    expect(() =>
      createPrototypeInternalRouters({
        config: { enabled: true },
        authenticateWorker: jest.fn(),
        loadJob: jest.fn(),
        loadLease: jest.fn(),
        tokenService: { issue: jest.fn(), verify: jest.fn() },
        getUserKeyValues: jest.fn(),
        requestUpstream: undefined,
        publishControlEvent: jest.fn(),
        baseUrl: 'https://gateway.internal/v1',
      }),
    ).toThrow('proxy dependencies');
  });

  it('delegates a pause to one atomic revision, execution and lease guarded adapter call', async () => {
    const applyPause = jest.fn(async () => ({ status: 'waiting_for_funds', revision: 8 }));
    const pauseJob = createDurablePauseJob({ applyPause });
    const event = {
      eventId: 'event_1',
      turnId: 'turn_1',
      commandId: 'command_1',
      attemptId: 'attempt_1',
      executionId: 'execution_1',
      stage: 'generation',
      fenceToken: 3,
      leaseId: 'lease_1',
    };

    await expect(
      pauseJob({
        job: { jobId: 'job_1', revision: 7, activeExecutionId: 'execution_1' },
        event,
        status: 'waiting_for_funds',
        checkpointRevision: 6,
      }),
    ).resolves.toMatchObject({ status: 'waiting_for_funds', revision: 8 });
    expect(applyPause).toHaveBeenCalledWith({
      jobId: 'job_1',
      turnId: 'turn_1',
      commandId: 'command_1',
      expectedRevision: 7,
      attemptId: 'attempt_1',
      executionId: 'execution_1',
      stage: 'generation',
      fenceToken: 3,
      leaseId: 'lease_1',
      eventId: 'event_1',
      status: 'waiting_for_funds',
      patch: { waitingReason: null, checkpointRevision: 6 },
    });
  });

  it('registers immutable metadata before publishing a safe deterministic publication event', async () => {
    const activeSession = {
      withTransaction: jest.fn(async (callback) => callback()),
      endSession: jest.fn(),
    };
    const digest = (value) => value.repeat(64);
    const artifacts = [
      ['qa_evidence', digest('f'), 'application/json'],
      ['checkpoint', digest('a'), 'application/zstd'],
      ['sources_zip', digest('e'), 'application/zip'],
      ['html', digest('d'), 'text/html'],
    ].map(([kind, sha256, contentType], index) => ({
      artifactId: String(index + 1).padStart(24, '0'), kind, sha256, contentType,
      size: index + 10, executionId: 'execution_1', revision: 2,
      templateDigest: `sha256:${digest('b')}`, toolchainDigest: `sha256:${digest('c')}`,
      objectKey: `private/${kind}`,
    }));
    const registerArtifacts = jest.fn(async () => ({
      artifacts,
      eventCreatedAt: new Date('2026-09-25T10:00:00.000Z'),
    }));
    const publishControlEvent = jest.fn(async () => undefined);
    const complete = createDurablePublicationCompletion({
      startSession: async () => activeSession,
      registerArtifacts,
      publishControlEvent,
    });
    const input = {
      jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', expectedRevision: 2,
      attemptId: 'attempt_1', executionId: 'execution_1', stage: 'publish', pipelineStep: 5,
      fenceToken: 3, leaseId: 'lease_1', target: 'review_ready',
      checkpoint: { revision: 2, digest: `sha256:${digest('a')}` },
      templateDigest: `sha256:${digest('b')}`, toolchainDigest: `sha256:${digest('c')}`,
      artifacts: [],
    };
    const first = await complete(input);
    const second = await complete(input);
    expect(first.eventId).toBe(second.eventId);
    expect(registerArtifacts).toHaveBeenCalledWith({ ...input, session: activeSession });
    expect(publishControlEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: first.eventId,
      stage: 'publish',
      pipelineStep: 5,
      payload: expect.objectContaining({
        type: 'review_ready',
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: 'checkpoint', digest: `sha256:${digest('a')}` }),
          expect.objectContaining({ kind: 'html', digest: `sha256:${digest('d')}` }),
        ]),
      }),
      createdAt: '2026-09-25T10:00:00.000Z',
    }));
    expect(JSON.stringify(publishControlEvent.mock.calls)).not.toContain('private/');
    expect(activeSession.endSession).toHaveBeenCalledTimes(2);
  });

  it('retries the same publication event after a crash between metadata commit and event publish', async () => {
    const sessions = [];
    const digest = (value) => value.repeat(64);
    const artifacts = [
      ['checkpoint', 'a', 'application/zstd'],
      ['html', 'd', 'text/html'],
      ['sources_zip', 'e', 'application/zip'],
      ['qa_evidence', 'f', 'application/json'],
    ].map(([kind, value, contentType], index) => ({
      artifactId: String(index + 1).padStart(24, '0'), kind, sha256: digest(value),
      contentType, size: index + 10, executionId: 'execution_1', revision: 2,
      templateDigest: `sha256:${digest('b')}`, toolchainDigest: `sha256:${digest('c')}`,
      objectKey: `private/${kind}`,
    }));
    const registerArtifacts = jest.fn(async () => ({
      artifacts,
      eventCreatedAt: new Date('2026-09-25T10:00:00.000Z'),
    }));
    const attemptedEvents = [];
    const publishControlEvent = jest.fn(async (event) => {
      attemptedEvents.push(event);
      if (attemptedEvents.length === 1) throw new Error('injected crash before event publish');
    });
    const complete = createDurablePublicationCompletion({
      startSession: async () => {
        const activeSession = {
          withTransaction: jest.fn(async (callback) => callback()),
          endSession: jest.fn(),
        };
        sessions.push(activeSession);
        return activeSession;
      },
      registerArtifacts,
      publishControlEvent,
    });
    const input = {
      jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', expectedRevision: 2,
      attemptId: 'attempt_1', executionId: 'execution_1', stage: 'publish', pipelineStep: 5,
      fenceToken: 3, leaseId: 'lease_1', target: 'review_ready',
      checkpoint: { revision: 2, digest: `sha256:${digest('a')}` },
      templateDigest: `sha256:${digest('b')}`, toolchainDigest: `sha256:${digest('c')}`,
      artifacts: [],
    };

    await expect(complete(input)).rejects.toThrow('injected crash before event publish');
    await expect(complete(input)).resolves.toMatchObject({ eventId: attemptedEvents[0].eventId });

    expect(registerArtifacts).toHaveBeenCalledTimes(2);
    expect(attemptedEvents).toHaveLength(2);
    expect(attemptedEvents[1]).toEqual(attemptedEvents[0]);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.endSession.mock.calls.length === 1)).toBe(true);
    expect(JSON.stringify(attemptedEvents)).not.toContain('private/');
  });
});
