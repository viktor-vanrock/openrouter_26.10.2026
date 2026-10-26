const {
  createPrototypeControlPlaneStartup,
  createPrototypeServiceAuthenticator,
} = require('./PrototypeControlPlaneStartup');

describe('PrototypeControlPlaneStartup', () => {
  it('keeps the test header identity disabled in production', async () => {
    const authenticate = createPrototypeServiceAuthenticator({
      env: { NODE_ENV: 'production', PROTOTYPE_TEST_WORKER_IDENTITY: 'test-worker' },
    });
    await expect(authenticate({ get: () => 'test-worker' })).resolves.toBe(false);
  });

  it('requires HTTPS and the exact strong service token in production bearer mode', async () => {
    const token = 'a'.repeat(64);
    const authenticate = createPrototypeServiceAuthenticator({ env: {
      NODE_ENV: 'production', PROTOTYPE_SERVICE_AUTH_MODE: 'bearer', PROTOTYPE_SERVICE_TOKEN: token,
      PROTOTYPE_TEST_WORKER_IDENTITY: 'dev',
    } });
    const request = (value, secure = true) => ({ secure, get: name => name === 'Authorization' ? value : 'dev' });
    await expect(authenticate(request(`Bearer ${token}`))).resolves.toBe(true);
    await expect(authenticate(request(`Bearer ${token}`, false))).resolves.toBe(false);
    await expect(authenticate(request(`Bearer ${'b'.repeat(64)}`))).resolves.toBe(false);
    await expect(authenticate(request(undefined))).resolves.toBe(false);
    const malformed = createPrototypeServiceAuthenticator({ env: {
      NODE_ENV: 'production', PROTOTYPE_SERVICE_AUTH_MODE: 'bearer', PROTOTYPE_SERVICE_TOKEN: 'short',
    } });
    await expect(malformed(request('Bearer short'))).resolves.toBe(false);
  });

  it('starts bearer mode without loading a private TLS listener and rejects missing secrets', async () => {
    const make = env => createPrototypeControlPlaneStartup({ enabled: true, db: {}, mongoose: {}, env });
    await expect(make({ NODE_ENV: 'production', PROTOTYPE_SERVICE_AUTH_MODE: 'bearer',
      PROTOTYPE_SERVICE_TOKEN: 'a'.repeat(64) }).startPrivateListener()).resolves.toBeNull();
    await expect(make({ NODE_ENV: 'production', PROTOTYPE_SERVICE_AUTH_MODE: 'bearer' })
      .startPrivateListener()).rejects.toThrow('PROTOTYPE_SERVICE_AUTH_CONFIG_INVALID');
    await expect(make({ NODE_ENV: 'production', PROTOTYPE_SERVICE_AUTH_MODE: 'unknown' })
      .startPrivateListener()).rejects.toThrow('PROTOTYPE_SERVICE_AUTH_CONFIG_INVALID');
  });

  it('allows an exact explicit test identity only outside production', async () => {
    const authenticate = createPrototypeServiceAuthenticator({
      env: { NODE_ENV: 'test', PROTOTYPE_TEST_WORKER_IDENTITY: 'test-worker' },
    });
    await expect(authenticate({ get: () => 'test-worker' })).resolves.toBe(true);
    await expect(authenticate({ get: () => 'wrong-worker' })).resolves.toBe(false);
  });

  it('fails closed until transport is bound and then publishes validated stage events', async () => {
    const publishControlEvent = jest.fn(async () => undefined);
    const startup = createPrototypeControlPlaneStartup({
      enabled: true,
      db: {
        registerPrototypeLease: jest.fn(),
        registerPrototypeArtifacts: jest.fn(),
      },
      mongoose: { startSession: jest.fn() },
      authenticateService: async () => true,
    });
    const layer = startup.router.stack.find((candidate) =>
      candidate.route?.path === '/stage-completions');
    const handler = layer.route.stack.at(-1).handle;
    const req = { body: {
      jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', expectedRevision: 2,
      attemptId: 'attempt_1', executionId: 'execution_1', stage: 'generation',
      fenceToken: 3, leaseId: 'lease_1', pipelineStep: 0, outputKind: 'checkpoint',
      outputDigest: `sha256:${'a'.repeat(64)}`,
      checkpoint: { revision: 3, digest: `sha256:${'a'.repeat(64)}` },
    } };
    const unavailable = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(req, unavailable);
    expect(unavailable.status).toHaveBeenCalledWith(503);

    startup.bindTransport({ publishControlEvent });
    const accepted = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(req, accepted);
    expect(publishControlEvent).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job_1', payload: expect.objectContaining({ type: 'stage_completed' }),
    }));
    expect(accepted.status).toHaveBeenCalledWith(202);
  });

  it('does not create startup wiring while transport is disabled', () => {
    expect(createPrototypeControlPlaneStartup({ enabled: false })).toBeNull();
  });
});
