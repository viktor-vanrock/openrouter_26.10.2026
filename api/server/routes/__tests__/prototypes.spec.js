const http = require('node:http');
const originalKeepAlive = http.globalAgent.keepAlive;
beforeAll(() => { http.globalAgent.keepAlive = false; });
afterAll(() => { http.globalAgent.keepAlive = originalKeepAlive; });
const express = require('express');
const request = require('supertest');
const { PrototypeServiceError } = require('~/server/services/Prototypes/errors');

const OWNER = { id: 'user-owner', tenantId: 'tenant-a' };
const JOB_ID = 'job_507f1f77bcf86cd799439011';
const MISSING_JOB_ID = 'job_507f1f77bcf86cd799439012';
const CONVERSATION_ID = 'conversation-1';
const CARD = {
  type: 'prototype',
  jobId: JOB_ID,
  status: 'waiting_for_input',
  phase: 'questions',
  modelId: 'openai/gpt-5-codex',
  modelWarning: null,
  prototypeName: null,
  previewAvailable: false,
  sourcesAvailable: false,
  canCancel: true,
  canReply: true,
  estimatedCost: null,
  actualCostUsd: 0,
};
const NOT_FOUND = {
  error: { code: 'PROTOTYPE_JOB_NOT_FOUND', message: 'Prototype job not found' },
};

function auth(req, res, next) {
  const value = req.get('Authorization');
  if (!value?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const [id, tenantId, email] = value.slice('Bearer '.length).split(':');
  req.user = { id, tenantId, email };
  next();
}

function assertOwner(req, jobId = JOB_ID, conversationId = CONVERSATION_ID) {
  if (
    req.user?.id !== OWNER.id ||
    req.user?.tenantId !== OWNER.tenantId ||
    (jobId != null && jobId !== JOB_ID) ||
    (conversationId != null && conversationId !== CONVERSATION_ID)
  ) {
    throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
  }
}

function serviceDouble() {
  return {
    submitTurn: jest.fn(async ({ req, conversationId }) => {
      assertOwner(req, null, conversationId);
      if (req.config?.prototypeAgent?.modelPolicy?.version !== 'test-policy') {
        throw new Error('Prototype route did not load request configuration');
      }
      return { ...CARD, status: 'queued', canReply: false };
    }),
    getJob: jest.fn(async ({ req, jobId, conversationId }) => {
      assertOwner(req, jobId, conversationId);
      return CARD;
    }),
    acceptReply: jest.fn(async ({ req, jobId, conversationId, idempotencyKey }) => {
      assertOwner(req, jobId, conversationId);
      if (idempotencyKey === 'stale-key') {
        throw new PrototypeServiceError(
          'PROTOTYPE_STALE_REVISION',
          'Prototype job revision no longer matches',
        );
      }
      return { ...CARD, status: 'queued', canReply: false };
    }),
    cancel: jest.fn(async ({ req, jobId, conversationId }) => {
      assertOwner(req, jobId, conversationId);
      return { ...CARD, status: 'canceled', canCancel: false, canReply: false };
    }),
    resume: jest.fn(async ({ req, jobId, conversationId }) => {
      assertOwner(req, jobId, conversationId);
      throw new PrototypeServiceError(
        'PROTOTYPE_INVALID_STATE',
        'Prototype job cannot resume while waiting_for_input',
      );
    }),
    approve: jest.fn(async ({ req, jobId, conversationId }) => {
      assertOwner(req, jobId, conversationId);
      return { ...CARD, status: 'queued', canReply: false };
    }),
    retry: jest.fn(async ({ req, jobId, conversationId }) => {
      assertOwner(req, jobId, conversationId);
      return { ...CARD, status: 'queued', canReply: false };
    }),
    finalize: jest.fn(async ({ req, jobId, conversationId }) => {
      assertOwner(req, jobId, conversationId);
      return { ...CARD, status: 'completed', canCancel: false, canReply: false };
    }),
    requireArtifact: jest.fn(async ({ req, jobId, conversationId }) => {
      assertOwner(req, jobId, conversationId);
      throw new PrototypeServiceError(
        'PROTOTYPE_ARTIFACT_NOT_READY',
        'Prototype artifact is not ready',
      );
    }),
    getConversationJob: jest.fn(async ({ req, conversationId }) => {
      assertOwner(req, null, conversationId);
      return CARD;
    }),
    getConversationEvents: jest.fn(async ({ req, conversationId }) => {
      assertOwner(req, null, conversationId);
      return CARD;
    }),
  };
}

function createApp(service = serviceDouble(), available = true, feature = { enabled: true }) {
  jest.isolateModules(() => {});
  const { createPrototypeRouters } = require('../prototypes');
  const routers = createPrototypeRouters({
    prototypeService: service,
    isAvailable: () => available,
    requireAuth: auth,
    loadConfig: (req, _res, next) => {
      req.config = { prototypeAgent: { ...feature, modelPolicy: { version: 'test-policy' } } };
      next();
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/prototypes', routers.jobs);
  app.use('/api/conversations', routers.conversations);
  return { app, service };
}

function authenticated(method, path, user = OWNER) {
  return request(createApp().app)
    [method](path)
    .set('Authorization', `Bearer ${user.id}:${user.tenantId}`)
    .set('X-Prototype-Conversation-Id', CONVERSATION_ID);
}

const surfaces = [
  ['get', `/api/prototypes/${JOB_ID}?conversationId=${CONVERSATION_ID}`],
  ['post', `/api/prototypes/${JOB_ID}/replies`],
  ['post', `/api/prototypes/${JOB_ID}/cancel`],
  ['post', `/api/prototypes/${JOB_ID}/resume`],
  ['post', `/api/prototypes/${JOB_ID}/approve`],
  ['post', `/api/prototypes/${JOB_ID}/retry`],
  ['post', `/api/prototypes/${JOB_ID}/finalize`],
  ['get', `/api/prototypes/${JOB_ID}/html?conversationId=${CONVERSATION_ID}`],
  ['get', `/api/prototypes/${JOB_ID}/html-download?conversationId=${CONVERSATION_ID}`],
  ['get', `/api/prototypes/${JOB_ID}/sources?conversationId=${CONVERSATION_ID}`],
  ['get', `/api/conversations/${CONVERSATION_ID}/prototype`],
  ['get', `/api/conversations/${CONVERSATION_ID}/prototype/events`],
];

describe('Prototype BFF routes', () => {
  it.each([
    ['PROTOTYPE_CONTENT_BLOCKED', 422, 'The request violates content policy'],
    ['PROTOTYPE_MODERATION_UNAVAILABLE', 503, 'Content safety check is temporarily unavailable'],
  ])('returns the public content safety response for %s', async (code, status, message) => {
    const service = serviceDouble();
    service.submitTurn.mockRejectedValue(
      new PrototypeServiceError(code, 'private provider details'),
    );
    const { app } = createApp(service);
    const response = await request(app)
      .post(`/api/conversations/${CONVERSATION_ID}/prototype`)
      .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`)
      .set('Idempotency-Key', 'content-test')
      .send({
        messageId: 'message-content',
        parentMessageId: 'parent-content',
        text: 'Create a prototype',
        modelId: 'trusted/model',
      });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ error: { code, message } });
  });
  it('flushes every SSE frame so live card updates are not held by compression buffering', () => {
    const { writePrototypeSseFrame } = require('../prototypes');
    const res = { write: jest.fn(), flush: jest.fn() };
    writePrototypeSseFrame(res, 'event: cursor\ndata: {"cursor":1}\n\n');
    expect(res.write).toHaveBeenCalledWith('event: cursor\ndata: {"cursor":1}\n\n');
    expect(res.flush).toHaveBeenCalledTimes(1);
  });

  it('keeps SSE polling alive after the request body closes and stops on abort or response close', () => {
    const { EventEmitter } = require('events');
    const { attachPrototypeSseCleanup } = require('../prototypes');
    const req = new EventEmitter();
    const res = new EventEmitter();
    const close = jest.fn();
    attachPrototypeSseCleanup(req, res, close);
    req.emit('close');
    expect(close).not.toHaveBeenCalled();
    req.emit('aborted');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(surfaces)('requires authentication for %s %s', async (method, path) => {
    // Production break caught: mounting one of the eight BFF surfaces outside JWT auth.
    const response = await request(createApp().app)[method](path);
    expect(response.status).toBe(401);
  });

  it('returns the owned durable job and exposes no public create route', async () => {
    // Production break caught: hydration fails for the owner or browser callers can create jobs.
    const getResponse = await authenticated(
      'get',
      `/api/prototypes/${JOB_ID}?conversationId=${CONVERSATION_ID}`,
    );
    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toEqual(CARD);

    const createResponse = await authenticated('post', '/api/prototypes').send({});
    expect(createResponse.status).toBe(404);
  });

  it('loads tenant-aware config before accepting an ordinary-chat Prototype turn', async () => {
    const { app, service } = createApp();
    const unauthenticated = await request(app)
      .post(`/api/conversations/${CONVERSATION_ID}/prototype`)
      .set('Idempotency-Key', 'chat:message-1')
      .send({
        messageId: 'message-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Build a reading list',
        modelId: 'openai/gpt-5-codex',
      });
    expect(unauthenticated.status).toBe(401);

    const response = await request(app)
      .post(`/api/conversations/${CONVERSATION_ID}/prototype`)
      .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`)
      .set('Idempotency-Key', 'chat:message-1')
      .send({
        messageId: 'message-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        text: 'Build a reading list',
        modelId: 'openai/gpt-5-codex',
        endpoint: 'OpenRouter',
      });

    expect(response.status).toBe(201);
    expect(service.submitTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        messageId: 'message-1',
        modelId: 'openai/gpt-5-codex',
        idempotencyKey: 'chat:message-1',
        req: expect.objectContaining({
          config: { prototypeAgent: { enabled: true, modelPolicy: { version: 'test-policy' } } },
        }),
      }),
    );
  });

  it('validates reply and action mutations with the shared strict schemas', async () => {
    // Production break caught: untrusted or malformed browser payload reaches PrototypeService.
    const { app, service } = createApp();
    const invalidReply = await request(app)
      .post(`/api/prototypes/${JOB_ID}/replies`)
      .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`)
      .set('Idempotency-Key', 'reply-1')
      .set('X-Prototype-Conversation-Id', CONVERSATION_ID)
      .set('X-Prototype-Revision', '4')
      .send({ messageId: 'message-1', prototypeReplyToMessageId: 'prompt-1', injected: true });
    expect(invalidReply.status).toBe(422);
    expect(invalidReply.body).toEqual({
      error: { code: 'PROTOTYPE_INVALID_REQUEST', message: 'Prototype request is invalid' },
    });
    expect(service.acceptReply).not.toHaveBeenCalled();

    const invalidAction = await request(app)
      .post(`/api/prototypes/${JOB_ID}/cancel`)
      .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`)
      .set('Idempotency-Key', 'cancel-1')
      .set('X-Prototype-Conversation-Id', CONVERSATION_ID)
      .set('X-Prototype-Revision', '4')
      .send({ revision: 1 });
    expect(invalidAction.status).toBe(422);
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it.each(['replies', 'approve', 'cancel', 'retry', 'resume', 'finalize'])(
    'requires Idempotency-Key before dispatching %s',
    async (action) => {
      // Production break caught: a retried mutation can be applied twice without a stable key.
      const { app, service } = createApp();
      const response = await request(app)
        .post(`/api/prototypes/${JOB_ID}/${action}`)
        .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`)
        .set('X-Prototype-Conversation-Id', CONVERSATION_ID)
        .set('X-Prototype-Revision', '4')
        .send(
          action === 'replies'
            ? { messageId: 'message-1', prototypeReplyToMessageId: 'prompt-1' }
            : {},
        );
      expect(response.status).toBe(422);
      expect(service[action === 'replies' ? 'acceptReply' : action]).not.toHaveBeenCalled();
    },
  );

  it.each(['replies', 'approve', 'cancel', 'retry', 'resume', 'finalize'])(
    'requires X-Prototype-Revision before dispatching %s',
    async (action) => {
      const { app, service } = createApp();
      const response = await request(app)
        .post(`/api/prototypes/${JOB_ID}/${action}`)
        .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`)
        .set('Idempotency-Key', `${action}-revision`)
        .set('X-Prototype-Conversation-Id', CONVERSATION_ID)
        .send(
          action === 'replies'
            ? { messageId: 'message-1', prototypeReplyToMessageId: 'prompt-1' }
            : {},
        );
      expect(response.status).toBe(422);
      expect(service[action === 'replies' ? 'acceptReply' : action]).not.toHaveBeenCalled();
    },
  );

  it.each(['replies', 'approve', 'cancel', 'retry', 'resume', 'finalize'])(
    'requires the original conversation binding before dispatching %s',
    async (action) => {
      const { app, service } = createApp();
      const response = await request(app)
        .post(`/api/prototypes/${JOB_ID}/${action}`)
        .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`)
        .set('Idempotency-Key', `${action}-binding`)
        .set('X-Prototype-Revision', '4')
        .send(
          action === 'replies'
            ? { messageId: 'message-1', prototypeReplyToMessageId: 'prompt-1' }
            : {},
        );
      expect(response.status).toBe(422);
      expect(service[action === 'replies' ? 'acceptReply' : action]).not.toHaveBeenCalled();
    },
  );

  it('passes validated mutation inputs and the header idempotency key to the service', async () => {
    // Production break caught: routes source mutation identity or idempotency data from the body.
    const { app, service } = createApp();
    const response = await request(app)
      .post(`/api/prototypes/${JOB_ID}/replies`)
      .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`)
      .set('Idempotency-Key', 'reply-1')
      .set('X-Prototype-Conversation-Id', CONVERSATION_ID)
      .set('X-Prototype-Revision', '4')
      .send({ messageId: 'message-1', prototypeReplyToMessageId: 'prompt-1' });
    expect(response.status).toBe(200);
    expect(service.acceptReply).toHaveBeenCalledWith({
      req: expect.objectContaining({ user: OWNER }),
      jobId: JOB_ID,
      conversationId: CONVERSATION_ID,
      messageId: 'message-1',
      prototypeReplyToMessageId: 'prompt-1',
      idempotencyKey: 'reply-1',
      expectedRevision: 4,
    });
  });

  it.each(['html', 'sources'])(
    'authorizes %s before returning artifact-not-ready',
    async (kind) => {
      // Production break caught: an unavailable artifact leaks whether another user's job exists.
      const response = await authenticated(
        'get',
        `/api/prototypes/${JOB_ID}/${kind}?conversationId=${CONVERSATION_ID}`,
      );
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        error: {
          code: 'PROTOTYPE_ARTIFACT_NOT_READY',
          message: 'The prototype artifact is not ready',
        },
      });
    },
  );

  it('streams only the selected accepted HTML bytes with restrictive browser headers', async () => {
    const service = serviceDouble();
    service.requireArtifact.mockResolvedValue({
      bytes: Buffer.from('<!doctype html><title>Accepted</title>'),
      contentType: 'text/html; charset=utf-8',
      filename: 'prototype-safe.html',
      digest: `sha256:${'a'.repeat(64)}`,
    });
    const { app } = createApp(service);

    const response = await request(app)
      .get(`/api/prototypes/${JOB_ID}/html?conversationId=${CONVERSATION_ID}&version=7`)
      .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`);

    expect(response.status).toBe(200);
    expect(response.text).toContain('<title>Accepted</title>');
    expect(require('content-disposition').parse(response.headers['content-disposition'])).toMatchObject({ type: 'inline', parameters: { filename: 'prototype-safe.html' } });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-prototype-digest']).toBe(`sha256:${'a'.repeat(64)}`);
    expect(response.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(response.headers['content-security-policy']).toContain("form-action 'none'");
    expect(service.requireArtifact).toHaveBeenCalledWith(expect.objectContaining({
      jobId: JOB_ID,
      conversationId: CONVERSATION_ID,
      kind: 'html',
      version: 7,
    }));
  });

  it.each([
    `/api/conversations/${CONVERSATION_ID}/prototype`,
    `/api/conversations/${CONVERSATION_ID}/prototype/events`,
  ])('returns the current durable state for %s', async (path) => {
    // Production break caught: the pre-live-transport seam fabricates transient state.
    const response = await authenticated('get', path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(CARD);
  });

  it.each(surfaces)(
    'normalizes other-user ownership as the same 404 for %s %s',
    async (method, path) => {
      // Production break caught: a foreign user can distinguish or access an existing job.
      const response = authenticated(method, path, {
        id: 'user-other',
        tenantId: OWNER.tenantId,
      });
      if (method === 'post') {
        response.set('Idempotency-Key', 'ownership-check').set('X-Prototype-Revision', '4').send(
          path.endsWith('/replies')
          ? { messageId: 'message-1', prototypeReplyToMessageId: 'prompt-1' }
          : {},
        );
      }
      const result = await response;
      expect(result.status).toBe(404);
      expect(result.body).toEqual(NOT_FOUND);
    },
  );

  it.each(surfaces)(
    'normalizes other-tenant ownership as the same 404 for %s %s',
    async (method, path) => {
      // Production break caught: tenant boundaries disclose prototype job existence.
      const req = authenticated(method, path, { id: OWNER.id, tenantId: 'tenant-b' });
      if (method === 'post') {
        req.set('Idempotency-Key', 'ownership-check').set('X-Prototype-Revision', '4').send(
          path.endsWith('/replies')
            ? { messageId: 'message-1', prototypeReplyToMessageId: 'prompt-1' }
            : {},
        );
      }
      const response = await req;
      expect(response.status).toBe(404);
      expect(response.body).toEqual(NOT_FOUND);
    },
  );

  it('makes an absent job indistinguishable from a foreign job', async () => {
    // Production break caught: absent and foreign IDs produce distinguishable error payloads.
    const response = await authenticated(
      'get',
      `/api/prototypes/${MISSING_JOB_ID}?conversationId=${CONVERSATION_ID}`,
    );
    expect(response.status).toBe(404);
    expect(response.body).toEqual(NOT_FOUND);
  });

  it('rejects a copied jobId when the original conversation binding does not match', async () => {
    const action = await authenticated('post', `/api/prototypes/${JOB_ID}/cancel`)
      .set('X-Prototype-Conversation-Id', 'copied-conversation')
      .set('Idempotency-Key', 'copied-job')
      .set('X-Prototype-Revision', '4')
      .send({});
    expect(action.status).toBe(404);
    expect(action.body).toEqual(NOT_FOUND);

    const artifact = await authenticated(
      'get',
      `/api/prototypes/${JOB_ID}/html?conversationId=copied-conversation`,
    );
    expect(artifact.status).toBe(404);
    expect(artifact.body).toEqual(NOT_FOUND);
  });

  it.each([
    '/api/prototypes/not-a-job',
    '/api/conversations/%20/prototype',
  ])('rejects malformed route identity %s without dispatching', async (path) => {
    // Production break caught: malformed identifiers enter persistence filters.
    const { app, service } = createApp();
    const response = await request(app)
      .get(path)
      .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`);
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: { code: 'PROTOTYPE_INVALID_REQUEST', message: 'Prototype request is invalid' },
    });
    expect(service.getJob).not.toHaveBeenCalled();
    expect(service.getConversationJob).not.toHaveBeenCalled();
  });

  it('normalizes stale revision and invalid state errors without stack traces', async () => {
    // Production break caught: domain failures become 500s or expose server stack details.
    const stale = await authenticated('post', `/api/prototypes/${JOB_ID}/replies`)
      .set('Idempotency-Key', 'stale-key')
      .set('X-Prototype-Revision', '4')
      .send({ messageId: 'message-1', prototypeReplyToMessageId: 'prompt-1' });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      error: {
        code: 'PROTOTYPE_STALE_REVISION',
        message: 'Prototype job revision no longer matches',
      },
    });
    expect(JSON.stringify(stale.body)).not.toContain('stack');

    const invalidState = await authenticated('post', `/api/prototypes/${JOB_ID}/resume`)
      .set('Idempotency-Key', 'resume-1')
      .set('X-Prototype-Revision', '4')
      .send({});
    expect(invalidState.status).toBe(409);
    expect(invalidState.body.error.code).toBe('PROTOTYPE_INVALID_STATE');
  });
});


it('reports an unavailable prototype service without waiting and rejects new generation only', async () => {
  const service = serviceDouble();
  const { app } = createApp(service, false);
  const token = `Bearer ${OWNER.id}:${OWNER.tenantId}`;
  const availability = await request(app).get('/api/prototypes/availability').set('Authorization', token);
  expect(availability.status).toBe(200);
  expect(availability.body).toEqual({ available: false });
  const submitted = await request(app).post(`/api/conversations/${CONVERSATION_ID}/prototype`)
    .set('Authorization', token).send({ text: 'new prototype' });
  expect(submitted.status).toBe(503);
  expect(service.submitTurn).not.toHaveBeenCalled();
  const existing = await request(app).get(`/api/prototypes/${JOB_ID}?conversationId=${CONVERSATION_ID}`)
    .set('Authorization', token);
  expect(existing.status).toBe(200);
});


describe('prototype access for authenticated users', () => {
  const token = (email) => `Bearer ${OWNER.id}:${OWNER.tenantId}:${email}`;

  it.each(['user@sberdevices.ru', 'user@example.org', ''])(
    'reports capability and accepts generation for authenticated email %s', async (email) => {
      const { app, service } = createApp();
      const authorization = token(email);
      const availability = await request(app).get('/api/prototypes/availability')
        .set('Authorization', authorization);
      expect(availability.status).toBe(200);
      expect(availability.body).toEqual({ available: true });
      expect(availability.headers['cache-control']).toBe('no-store');

      const submitted = await request(app).post(`/api/conversations/${CONVERSATION_ID}/prototype`)
        .set('Authorization', authorization).set('Idempotency-Key', 'chat:message-email')
        .send({ messageId: 'message-email', parentMessageId: 'parent-email',
          text: 'Build a dashboard', modelId: 'trusted/model' });
      expect(submitted.status).toBe(201);
      expect(service.submitTurn).toHaveBeenCalledTimes(1);
    },
  );
});

it.each([false, undefined, null, 'true', 1])(
  'blocks every new generation mutation when enabled is %s',
  async (enabled) => {
    const { app, service } = createApp(serviceDouble(), true, { enabled });
    const authorization = `Bearer ${OWNER.id}:${OWNER.tenantId}`;
    const capability = await request(app)
      .get('/api/prototypes/availability')
      .set('Authorization', authorization);
    expect(capability.body).toEqual({ available: false });
    for (const [method, path] of surfaces.filter(
      ([method, path]) => method === 'post' && !path.endsWith('/cancel'),
    )) {
      const response = await request(app)
        [method](path)
        .set('Authorization', authorization)
        .send({});
      expect(response.status).toBe(503);
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    const read = await request(app)
      .get(`/api/prototypes/${JOB_ID}?conversationId=${CONVERSATION_ID}`)
      .set('Authorization', authorization);
    expect(read.status).toBe(200);
    const cancel = await request(app)
      .post(`/api/prototypes/${JOB_ID}/cancel`)
      .set('Authorization', authorization)
      .set('X-Prototype-Conversation-Id', CONVERSATION_ID)
      .set('Idempotency-Key', 'disabled-cancel')
      .set('X-Prototype-Revision', '4')
      .send({});
    expect(cancel.status).toBe(200);
  },
);

it.each(['html', 'html-download', 'sources'])('escapes artifact filenames for %s', async (kind) => {
  const disposition = require('content-disposition');
  const service = serviceDouble();
  const filename = 'Отчёт "A"; custom="value.html';
  service.requireArtifact.mockResolvedValue({
    bytes: Buffer.from('accepted'),
    contentType: 'text/html',
    filename,
    digest: `sha256:${'a'.repeat(64)}`,
  });
  const response = await request(createApp(service).app)
    .get(`/api/prototypes/${JOB_ID}/${kind}?conversationId=${CONVERSATION_ID}`)
    .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`);
  expect(response.status).toBe(200);
  const parsed = disposition.parse(response.headers['content-disposition']);
  expect(parsed.type).toBe(kind === 'html' ? 'inline' : 'attachment');
  expect(parsed.parameters).toEqual({ filename });
});

it.each(['bad\r\nX-Test: injected.html', 'bad\\name.html'])(
  'keeps unsafe filename bytes inside the encoded parameter: %s',
  async (filename) => {
    const service = serviceDouble();
    service.requireArtifact.mockResolvedValue({
      bytes: Buffer.from('accepted'),
      contentType: 'text/html',
      filename,
      digest: `sha256:${'a'.repeat(64)}`,
    });
    const response = await request(createApp(service).app)
      .get(`/api/prototypes/${JOB_ID}/html-download?conversationId=${CONVERSATION_ID}`)
      .set('Authorization', `Bearer ${OWNER.id}:${OWNER.tenantId}`);
    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).not.toMatch(/[\r\n]/);
    expect(
      require('content-disposition').parse(response.headers['content-disposition']).parameters,
    ).toEqual({ filename });
    expect(response.headers['x-test']).toBeUndefined();
  },
);

describe('adaptive prototype SSE polling', () => {
  const { EventEmitter } = require('events');
  let req, res, service, close;
  beforeEach(() => {
    jest.useFakeTimers();
    req = new EventEmitter();
    res = Object.assign(new EventEmitter(), { write: jest.fn(), flush: jest.fn(), end: jest.fn() });
    service = { getConversationEvents: jest.fn().mockResolvedValue({ events: [], cursor: 8 }) };
    close = require('../prototypes').startPrototypeSsePolling({
      req,
      res,
      prototypeService: service,
      conversationId: CONVERSATION_ID,
      cursor: 8,
    });
  });
  afterEach(() => {
    close();
    jest.useRealTimers();
  });

  it('backs off idle streams to five seconds and resets when an event arrives', async () => {
    await jest.advanceTimersByTimeAsync(1_000);
    expect(service.getConversationEvents).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(service.getConversationEvents).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(4_000);
    expect(service.getConversationEvents).toHaveBeenCalledTimes(3);
    service.getConversationEvents.mockResolvedValueOnce({
      events: [{ id: 9, type: 'job_state', data: CARD }],
      cursor: 9,
    });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(service.getConversationEvents).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(service.getConversationEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: 9 }),
    );
    expect(service.getConversationEvents).toHaveBeenCalledTimes(5);
  });

  it('does not overlap reads or write/schedule again after disconnect during a read', async () => {
    let resolve;
    service.getConversationEvents.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    expect(service.getConversationEvents).toHaveBeenCalledTimes(1);
    res.emit('close');
    resolve({ events: [{ id: 9, type: 'job_state', data: CARD }], cursor: 9 });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(service.getConversationEvents).toHaveBeenCalledTimes(1);
    expect(res.write).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('closes and clears timers when a read fails', async () => {
    service.getConversationEvents.mockRejectedValueOnce(new Error('unavailable'));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.write).toHaveBeenCalledWith(
      expect.stringContaining('PROTOTYPE_SERVICE_UNAVAILABLE'),
    );
    expect(jest.getTimerCount()).toBe(0);
  });
});
