const { startPrototypeTransport } = require('./PrototypeTransportStartup');

describe('Prototype transport startup', () => {
  it('stays disabled without creating Redis state', async () => {
    const RedisCtor = jest.fn();
    await expect(startPrototypeTransport({ enabled: false, RedisCtor })).resolves.toBeNull();
    expect(RedisCtor).not.toHaveBeenCalled();
  });

  it('fails closed before startup when feature or Redis configuration is missing', async () => {
    await expect(startPrototypeTransport({
      enabled: true, appConfig: {}, env: {}, RedisCtor: jest.fn(),
    })).rejects.toThrow('prototypeAgent is disabled');
    await expect(startPrototypeTransport({
      enabled: true, appConfig: { prototypeAgent: { enabled: true } }, env: {}, RedisCtor: jest.fn(),
    })).rejects.toThrow('REDIS_URI');
  });

  it('verifies Redis, starts the runtime, and registers graceful shutdown', async () => {
    const redis = { ping: jest.fn(), disconnect: jest.fn(), on: jest.fn(), xadd: jest.fn() };
    const eventRedis = { ping: jest.fn(), disconnect: jest.fn(), on: jest.fn() };
    const runtime = { start: jest.fn(), stop: jest.fn() };
    const createRuntime = jest.fn(() => runtime);
    const registerShutdownTask = jest.fn();
    const unbindControlPlane = jest.fn();
    const bindControlPlane = jest.fn(() => unbindControlPlane);
    const parsePrototypeWorkerEventV2 = jest.fn((event) => ({ ...event, parsed: true }));
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
    await expect(startPrototypeTransport({
      enabled: true,
      appConfig: { prototypeAgent: { enabled: true } },
      env: { REDIS_URI: 'redis://prototype.test', HOSTNAME: 'api-a' },
      db: {}, mongoose: { startSession: jest.fn(), models: {} }, logger, registerShutdownTask,
      RedisCtor: jest.fn()
        .mockImplementationOnce(() => redis)
        .mockImplementationOnce(() => eventRedis),
      assertDurability: jest.fn(),
      loadContracts: async () => ({ parsePrototypeWorkerEventV2 }), createRuntime,
      bindControlPlane,
    })).resolves.toBe(runtime);
    expect(redis.ping).toHaveBeenCalledTimes(1);
    expect(eventRedis.ping).toHaveBeenCalledTimes(1);
    expect(redis.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(eventRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
    redis.on.mock.calls[0][1](new Error('redis://secret.internal:6379'));
    eventRedis.on.mock.calls[0][1](new Error('redis://secret.internal:6379'));
    expect(logger.warn).toHaveBeenCalledWith(
      '[PrototypeTransport] Redis connection interrupted; retrying.',
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ redis, eventRedis }));
    expect(runtime.start).toHaveBeenCalledTimes(1);
    const { publishControlEvent } = bindControlPlane.mock.calls[0][0];
    await publishControlEvent({ eventId: 'event_1' });
    expect(parsePrototypeWorkerEventV2).toHaveBeenCalledWith({ eventId: 'event_1' });
    expect(redis.xadd).toHaveBeenCalledWith(
      'prototype.events.v2', '*', 'event', JSON.stringify({ eventId: 'event_1', parsed: true }),
    );
    expect(registerShutdownTask).toHaveBeenCalledWith('prototype transport', expect.any(Function));
    await registerShutdownTask.mock.calls[0][1]();
    expect(unbindControlPlane).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });

  it('disconnects Redis when startup validation fails', async () => {
    const redis = { ping: jest.fn(), disconnect: jest.fn() };
    const eventRedis = { ping: jest.fn(), disconnect: jest.fn() };
    await expect(startPrototypeTransport({
      enabled: true,
      appConfig: { prototypeAgent: { enabled: true } },
      env: { REDIS_URI: 'redis://prototype.test' },
      RedisCtor: jest.fn()
        .mockImplementationOnce(() => redis)
        .mockImplementationOnce(() => eventRedis),
      assertDurability: jest.fn(async () => { throw new Error('unsafe Redis'); }),
    })).rejects.toThrow('unsafe Redis');
    expect(redis.disconnect).toHaveBeenCalledWith(false);
    expect(eventRedis.disconnect).toHaveBeenCalledWith(false);
  });

  it('does not advertise or keep the transport alive if native TLS startup fails', async () => {
    const redis = { ping: jest.fn(), disconnect: jest.fn() };
    const runtime = { start: jest.fn(), stop: jest.fn() };
    const stopPrivateListener = jest.fn(async () => {});
    await expect(startPrototypeTransport({ enabled: true, appConfig: { prototypeAgent: { enabled: true } },
      env: { REDIS_URI: 'redis://prototype.test' }, RedisCtor: jest.fn(() => redis),
      assertDurability: jest.fn(), loadContracts: async () => ({ parsePrototypeWorkerEventV2: value => value }),
      createRuntime: () => runtime, logger: { error: jest.fn() },
      startPrivateListener: async () => { throw new Error('TLS identity missing'); }, stopPrivateListener,
    })).rejects.toThrow('TLS identity missing');
    expect(stopPrivateListener).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalled();
  });
});
