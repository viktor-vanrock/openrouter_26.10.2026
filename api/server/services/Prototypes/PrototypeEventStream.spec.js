const {
  PrototypeRedisEventSource,
  PrototypeRedisEventSourceV2,
  runPrototypeEventLoop,
} = require('./PrototypeEventStream');

describe('PrototypeRedisEventSource', () => {
  const event = { schemaVersion: 1, eventId: 'event_1' };

  it('reclaims pending events before reading new entries', async () => {
    const redis = {
      xgroup: jest.fn(async () => 'OK'),
      xautoclaim: jest.fn(async () => ['0-0', [['1-0', ['event', JSON.stringify(event)]]]]),
      xreadgroup: jest.fn(),
      xack: jest.fn(),
    };
    const source = new PrototypeRedisEventSource({ redis, consumer: 'api-a' });
    await source.ensureGroup();
    await expect(source.next()).resolves.toEqual({ streamId: '1-0', event });
    expect(redis.xreadgroup).not.toHaveBeenCalled();
    await source.acknowledge('1-0');
    expect(redis.xack).toHaveBeenCalledWith('prototype.events.v1', 'prototype-control-plane', '1-0');
  });

  it('feeds the durable consumer loop and exits after abort', async () => {
    const controller = new AbortController();
    const source = {
      ensureGroup: jest.fn(),
      next: jest.fn(async () => ({ streamId: '1-0', event })),
      acknowledge: jest.fn(),
    };
    const consumer = { consume: jest.fn(async () => controller.abort()) };
    await runPrototypeEventLoop({ source, consumer, signal: controller.signal });
    expect(consumer.consume).toHaveBeenCalledWith('1-0', event);
    expect(source.acknowledge).toHaveBeenCalledWith('1-0');
  });

  it('uses the isolated v2 event stream when requested', async () => {
    const redis = {
      xgroup: jest.fn(async () => 'OK'),
      xautoclaim: jest.fn(async () => ['0-0', []]),
      xreadgroup: jest.fn(async () => null),
      xack: jest.fn(async () => 1),
    };
    const source = new PrototypeRedisEventSourceV2({ redis, consumer: 'api-a' });
    await source.ensureGroup();
    await source.acknowledge('2-0');
    expect(redis.xgroup).toHaveBeenCalledWith(
      'CREATE', 'prototype.events.v2', 'prototype-control-plane', '0', 'MKSTREAM',
    );
    expect(redis.xack).toHaveBeenCalledWith('prototype.events.v2', 'prototype-control-plane', '2-0');
  });

  it('backs off after a poison event and remains abortable', async () => {
    const controller = new AbortController();
    const source = {
      ensureGroup: jest.fn(), next: jest.fn(async () => ({ streamId: '1-0', event })),
      acknowledge: jest.fn(),
    };
    const onError = jest.fn();
    const consumer = {
      consume: jest.fn(async () => {
        if (onError.mock.calls.length === 0) throw new Error('poison');
        controller.abort();
      }),
    };
    await runPrototypeEventLoop({
      source, consumer, signal: controller.signal, onError, errorDelayMs: 1,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(source.acknowledge).toHaveBeenCalledTimes(1);
  });

  it('does not report a connection-close error caused by shutdown', async () => {
    const controller = new AbortController();
    const onError = jest.fn();
    const source = {
      ensureGroup: jest.fn(),
      next: jest.fn(async () => {
        controller.abort();
        throw new Error('Connection is closed.');
      }),
    };
    await runPrototypeEventLoop({ source, consumer: {}, signal: controller.signal, onError });
    expect(onError).not.toHaveBeenCalled();
  });
});
