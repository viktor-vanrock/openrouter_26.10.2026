const express = require('express');
const request = require('supertest');
const { createPrototypeAvailability } = require('./PrototypeAvailability');
const { startOptionalPrototype } = require('./PrototypeOptionalStartup');
const { createPrototypeControlPlaneRouter } = require('../../routes/internal/prototypeControlPlane');

describe('optional prototype capability', () => {
  it('requires both ready transport and a recent worker heartbeat; expires and recovers', async () => {
    let now = 0;
    let ready = true;
    const status = createPrototypeAvailability({ now: () => now, ttlMs: 15 });
    status.bindTransport(() => ready);
    expect(status.isAvailable()).toBe(false);
    await status.heartbeat();
    expect(status.isAvailable()).toBe(true);
    now = 16;
    expect(status.isAvailable()).toBe(false);
    await status.heartbeat();
    expect(status.isAvailable()).toBe(true);
    ready = false;
    expect(status.isAvailable()).toBe(false);
    status.unbindTransport();
    ready = true;
    expect(status.isAvailable()).toBe(false);
  });

  it('does not let an unauthenticated caller advertise an available worker', async () => {
    const heartbeat = jest.fn();
    const app = express();
    app.use(express.json());
    app.use(createPrototypeControlPlaneRouter({
      authenticateService: async (req) => req.get('X-Worker') === 'trusted',
      registerLease: jest.fn(), heartbeat,
    }));
    await request(app).post('/heartbeat').send({ ready: true }).expect(401);
    expect(heartbeat).not.toHaveBeenCalled();
    await request(app).post('/heartbeat').set('X-Worker', 'trusted').send({ ready: true }).expect(200);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it('does not wait for or reject ordinary startup when optional startup fails or hangs', async () => {
    const logger = { warn: jest.fn() };
    const stop = startOptionalPrototype({ start: async () => { throw new Error('prototype down'); }, logger });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    stop();
    const stopHung = startOptionalPrototype({ start: () => new Promise(() => {}), logger });
    expect(typeof stopHung).toBe('function');
    stopHung();
  });
});

it('propagates a worker lease between API replicas without remote reads on the config path', async () => {
  let doc;
  const collection = {
    updateOne: jest.fn(async (_filter, update) => { doc = { expiresAt: update.$set.expiresAt }; }),
    findOne: jest.fn(async () => doc),
  };
  const first = createPrototypeAvailability();
  const second = createPrototypeAvailability();
  first.bindTransport(() => true);
  second.bindTransport(() => true);
  const stopFirst = first.monitor(collection, 5);
  await first.heartbeat();
  const stopSecond = second.monitor(collection, 5);
  await new Promise((resolve) => setImmediate(resolve));
  expect(second.isAvailable()).toBe(true);
  const reads = collection.findOne.mock.calls.length;
  second.isAvailable(); second.isAvailable();
  expect(collection.findOne).toHaveBeenCalledTimes(reads);
  stopFirst(); stopSecond();
});
