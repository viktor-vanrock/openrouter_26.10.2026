const express = require('express');
const request = require('supertest');
const { createPrototypeTokenRouter } = require('../internal/prototypeTokens');

const refreshBody = {
  jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
  executionId: 'execution_1', stage: 'generation', fenceToken: 2, leaseId: 'lease_1',
};

function createApp(overrides = {}) {
  const deps = {
    authenticateWorker: jest.fn((req) => req.get('X-Prototype-Worker') === 'trusted-worker'),
    loadExecution: jest.fn(async () => ({
      jobId: 'job_1', userId: 'user_1', tenantId: 'tenant_1', modelId: 'fixed/model',
      turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
      executionId: 'execution_1', stage: 'generation', fenceToken: 2,
      revision: 4, leaseId: 'lease_1',
      leaseExpiresAt: new Date('2033-05-18T03:33:50.000Z'),
    })),
    tokenService: { issue: jest.fn(async () => 'job-token') },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use('/internal/prototype-tokens', createPrototypeTokenRouter(deps));
  return { app, deps };
}

describe('prototype token refresh route', () => {
  it('rejects browser authorization without trusted worker identity', async () => {
    const { app, deps } = createApp();
    const response = await request(app)
      .post('/internal/prototype-tokens/refresh')
      .set('Authorization', 'Bearer browser-session-token')
      .send(refreshBody);

    expect(response.status).toBe(401);
    expect(deps.loadExecution).not.toHaveBeenCalled();
  });

  it('derives token claims from active state instead of the request body', async () => {
    const { app, deps } = createApp();
    const response = await request(app)
      .post('/internal/prototype-tokens/refresh')
      .set('X-Prototype-Worker', 'trusted-worker')
      .send(refreshBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ token: 'job-token', expiresAt: '2033-05-18T03:33:50.000Z' });
    expect(deps.loadExecution).toHaveBeenCalledWith({
      ...refreshBody,
    });
    expect(deps.tokenService.issue).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_1', tenantId: 'tenant_1', modelId: 'fixed/model', revision: 4,
    }));
  });

  it.each([
    { ...refreshBody, modelId: 'override' },
    { ...refreshBody, attemptId: undefined },
  ])('rejects an invalid refresh body', async (body) => {
    const { app, deps } = createApp();
    const response = await request(app)
      .post('/internal/prototype-tokens/refresh')
      .set('X-Prototype-Worker', 'trusted-worker')
      .send(body);

    expect(response.status).toBe(422);
    expect(deps.loadExecution).not.toHaveBeenCalled();
  });

  it('does not expose internal token-service errors or paths', async () => {
    const { app } = createApp({
      tokenService: {
        issue: jest.fn(async () => {
          throw new Error('private key failed at /private/signing/key.pem');
        }),
      },
    });
    const response = await request(app)
      .post('/internal/prototype-tokens/refresh')
      .set('X-Prototype-Worker', 'trusted-worker')
      .send(refreshBody);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: 'PROTOTYPE_STALE_REVISION' } });
    expect(JSON.stringify(response.body)).not.toContain('/private');
  });
});
