const express = require('express');
const { Readable } = require('stream');
const request = require('supertest');
const { createPrototypeModelProxyRouter } = require('../internal/prototypeModelProxy');

function createApp(overrides = {}) {
  const proxy = {
    chatCompletions: jest.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream', connection: 'keep-alive' },
      body: Readable.from(['data: first\n\n', 'data: [DONE]\n\n']),
    })),
    ...overrides,
  };
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use('/internal/prototype-model/v1', createPrototypeModelProxyRouter({ proxy }));
  return { app, proxy };
}

function createGloballyLimitedApp(overrides = {}) {
  const proxy = {
    chatCompletions: jest.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Readable.from(['data: [DONE]\n\n']),
    })),
    ...overrides,
  };
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.use('/internal/prototype-model/v1', createPrototypeModelProxyRouter({ proxy }));
  return { app, proxy };
}

describe('prototype model proxy route', () => {
  it('scoped adapter accepts multi-file contexts and limits discovery to authenticated tokens', async () => {
    const { app, proxy } = createGloballyLimitedApp({ maxRequestBytes: 1024 * 1024,
      models: jest.fn(async () => ({ object: 'list', data: [{ id: 'selected/model' }] })) });
    await request(app).get('/internal/prototype-model/v1/models').expect(401);
    const discovery = await request(app).get('/internal/prototype-model/v1/models')
      .set('Authorization', 'Bearer job-token').expect(200);
    expect(discovery.body.data).toEqual([{ id: 'selected/model' }]);
    const response = await request(app).post('/internal/prototype-model/v1/chat/completions')
      .set('Authorization', 'Bearer job-token').set('X-Prototype-Request-Id', 'stable-request')
      .send({ messages: [{ role: 'user', content: 'x'.repeat(32 * 1024) }] }).expect(200);
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(proxy.chatCompletions).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'stable-request' }));
    await request(app).post('/internal/prototype-model/v1/chat/completions')
      .set('Authorization', 'Bearer job-token').send({ messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] }).expect(413);
  });
  it('requires a Bearer job token', async () => {
    const { app, proxy } = createApp();
    const response = await request(app)
      .post('/internal/prototype-model/v1/chat/completions')
      .send({ messages: [] });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED', retryable: false },
    });
    expect(proxy.chatCompletions).not.toHaveBeenCalled();
  });

  it('streams the allowed upstream response without forwarding hop-by-hop headers', async () => {
    const { app, proxy } = createApp();
    const response = await request(app)
      .post('/internal/prototype-model/v1/chat/completions')
      .set('Authorization', 'Bearer job-token')
      .set('X-Upstream-Target', 'https://attacker.invalid')
      .send({ model: 'override/model', messages: [] });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers.connection).not.toBe('keep-alive');
    expect(response.text).toBe('data: first\n\ndata: [DONE]\n\n');
    expect(proxy.chatCompletions).toHaveBeenCalledWith(expect.objectContaining({
      token: 'job-token',
      body: { model: 'override/model', messages: [] },
      signal: expect.any(AbortSignal),
    }));
  });

  it('normalizes service errors and exposes no internal message', async () => {
    const error = Object.assign(new Error('Bearer secret at /private/path'), {
      code: 'PROTOTYPE_SERVICE_UNAVAILABLE', retryable: true,
    });
    const { app } = createApp({ chatCompletions: jest.fn(async () => { throw error; }) });
    const response = await request(app)
      .post('/internal/prototype-model/v1/chat/completions')
      .set('Authorization', 'Bearer job-token')
      .send({ messages: [] });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE', retryable: true },
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('returns a typed retryable response for provider rate limits', async () => {
    const error = Object.assign(new Error('raw upstream rate-limit body'), {
      code: 'PROTOTYPE_RATE_LIMITED', retryable: true,
    });
    const { app } = createApp({ chatCompletions: jest.fn(async () => { throw error; }) });
    const response = await request(app)
      .post('/internal/prototype-model/v1/chat/completions')
      .set('Authorization', 'Bearer job-token')
      .send({ messages: [] });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: { code: 'PROTOTYPE_RATE_LIMITED', retryable: true },
    });
  });

  it('does not expose unsupported OpenAI-compatible paths', async () => {
    const { app } = createApp();
    await request(app)
      .get('/internal/prototype-model/v1/models')
      .set('Authorization', 'Bearer job-token')
      .expect(404);
  });

  it('enforces its own 16 KiB request limit even behind a larger global parser', async () => {
    const { app, proxy } = createGloballyLimitedApp();
    const response = await request(app)
      .post('/internal/prototype-model/v1/chat/completions')
      .set('Authorization', 'Bearer job-token')
      .send({ messages: [{ role: 'user', content: 'x'.repeat(17 * 1024) }] });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: { code: 'PROTOTYPE_INVALID_REQUEST', retryable: false },
    });
    expect(proxy.chatCompletions).not.toHaveBeenCalled();
  });
});
