const { Types, model } = require('mongoose');
const { prototypeEventSchema } = require('@librechat/data-schemas');
const PrototypeEvent = model('PrototypeServiceEventValidationTest', prototypeEventSchema);
const { PrototypeService } = require('./PrototypeService');
const axios = require('axios');
jest.mock('axios');

jest.setTimeout(120000);

const userId = new Types.ObjectId().toString();

function reqFor(id = userId, tenantId = 'tenant-1') {
  return {
    user: { id, tenantId },
    body: { conversationId: 'conversation-1', model: 'client/untrusted-model' },
    config: {
      prototypeAgent: {
        enabled: true,
        modelPolicy: {
          version: 'policy-v1',
          recommendedPatterns: ['trusted/*'],
          blockedPatterns: ['blocked/*'],
          requireToolCalling: true,
          unknownModelPolicy: 'warn',
        },
      },
    },
  };
}

function harness(overrides = {}) {
  const session = {
    inTransaction: jest.fn(() => true),
    withTransaction: jest.fn(async (work) => work()),
    endSession: jest.fn(),
  };
  const deps = {
    startSession: jest.fn().mockResolvedValue(session),
    createPrototypeJob: jest.fn(),
    getOwnedPrototypeJob: jest.fn(),
    findOwnedPrototypeJobByConversation: jest.fn(),
    getConversation: jest.fn().mockResolvedValue({ conversationId: 'conversation-1' }),
    createPrototypeConversation: jest.fn(),
    createPrototypeUserMessage: jest.fn(),
    claimPrototypeTurn: jest.fn(),
    retryFailedPrototypeJob: jest.fn(),
    listPrototypeEvents: jest.fn().mockResolvedValue([]),
    transitionPrototypeJob: jest.fn(),
    appendPrototypeEvent: jest.fn(),
    claimPrototypeReply: jest.fn(),
    enqueuePrototypeOutbox: jest.fn(),
    createPrototypeTurn: jest.fn(),
    findPrototypeOutbox: jest.fn(),
    findLatestPrototypeTurn: jest.fn(),
    getMessage: jest.fn().mockResolvedValue({
      messageId: 'message-1',
      conversationId: 'conversation-1',
      user: userId,
      tenantId: 'tenant-1',
      attachments: [],
    }),
    discardPrototypeReplyMessage: jest.fn(),
    findFileById: jest.fn(),
    readPrototypeArtifact: jest.fn(),
    estimateCost: jest.fn().mockResolvedValue(null),
    createId: jest.fn((kind) => `${kind}-1`),
    ...overrides,
  };
  return { service: new PrototypeService(deps), deps, session };
}

describe('Prototype content moderation', () => {
  let previous;
  beforeEach(() => {
    previous = process.env.OPENAI_MODERATION;
    process.env.OPENAI_MODERATION = 'true';
    axios.post.mockReset().mockResolvedValue({ data: { results: [{ flagged: true }] } });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.OPENAI_MODERATION;
    else process.env.OPENAI_MODERATION = previous;
  });
  const submit = (service, extra = {}) =>
    service.submitTurn({
      req: reqFor(),
      conversationId: 'conversation-1',
      messageId: 'message-content',
      parentMessageId: 'parent-content',
      text: 'Create the requested prototype',
      modelId: 'trusted/model',
      idempotencyKey: 'content-test',
      ...extra,
    });
  function unchanged(deps) {
    for (const method of [
      'createPrototypeJob',
      'createPrototypeUserMessage',
      'createPrototypeTurn',
      'claimPrototypeTurn',
      'claimPrototypeReply',
      'appendPrototypeEvent',
      'enqueuePrototypeOutbox',
    ]) {
      expect(deps[method]).not.toHaveBeenCalled();
    }
  }
  it('rejects a direct submit using the same moderation provider as ordinary chat', async () => {
    const { service, deps } = harness();
    await expect(submit(service)).rejects.toMatchObject({ code: 'PROTOTYPE_CONTENT_BLOCKED' });
    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      { input: 'Create the requested prototype' },
      expect.objectContaining({ timeout: 10000 }),
    );
    unchanged(deps);
  });
  it('checks the complete authorized file text rather than only the neutral message', async () => {
    const { service, deps } = harness({
      findFileById: jest.fn().mockResolvedValue({
        file_id: 'file-content',
        user: userId,
        tenantId: 'tenant-1',
        source: 'text',
        filename: 'requirements.txt',
        text: 'prohibited document fixture',
      }),
    });
    await expect(submit(service, { fileIds: ['file-content'] })).rejects.toMatchObject({
      code: 'PROTOTYPE_CONTENT_BLOCKED',
    });
    expect(axios.post.mock.calls[0][1].input).toContain('prohibited document fixture');
    unchanged(deps);
  });
  it.each(['review', 'waiting_for_input'])(
    'rejects owner-bound %s replies before claiming a turn and removes the rejected saved reply',
    async (status) => {
      const job = {
        jobId: 'job-content',
        conversationId: 'conversation-1',
        status,
        modelId: 'trusted/model',
        revision: 3,
        latestPromptMessageId: 'prompt-content',
      };
      const { service, deps } = harness({
        getOwnedPrototypeJob: jest.fn().mockResolvedValue(job),
        getMessage: jest
          .fn()
          .mockResolvedValue({
            messageId: 'reply-content',
            conversationId: 'conversation-1',
            user: userId,
            tenantId: 'tenant-1',
            text: 'Change according to the document',
            files: ['file-content'],
          }),
        findFileById: jest
          .fn()
          .mockResolvedValue({
            file_id: 'file-content',
            user: userId,
            tenantId: 'tenant-1',
            source: 'text',
            text: 'blocked reply document fixture',
          }),
      });
      await expect(
        service.acceptReply({
          req: reqFor(),
          jobId: job.jobId,
          conversationId: job.conversationId,
          messageId: 'reply-content',
          prototypeReplyToMessageId: job.latestPromptMessageId,
          expectedRevision: 3,
          idempotencyKey: 'reply-content',
        }),
      ).rejects.toMatchObject({ code: 'PROTOTYPE_CONTENT_BLOCKED' });
      expect(axios.post.mock.calls[0][1].input).toContain('blocked reply document fixture');
      unchanged(deps);
      expect(deps.discardPrototypeReplyMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'reply-content' }),
      );
    },
  );
  it('rejects a model-created spec, including the original saved user message', async () => {
    const { service, deps } = harness({
      getMessage: jest.fn().mockResolvedValue({
        messageId: 'message-1',
        conversationId: 'conversation-1',
        user: userId,
        tenantId: 'tenant-1',
        text: 'original prohibited request',
      }),
    });
    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'neutral rephrased specification',
        toolCallId: 'tool-content',
        messageId: 'message-1',
        modelId: 'trusted/model',
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_CONTENT_BLOCKED' });
    expect(axios.post.mock.calls[0][1].input).toContain('original prohibited request');
    unchanged(deps);
  });
  it.each([null, { results: [] }, { results: [{ flagged: 'false' }] }])(
    'does not admit content when the moderation response is invalid: %j',
    async (data) => {
      axios.post.mockResolvedValue({ data });
      const { service, deps } = harness();
      await expect(submit(service)).rejects.toMatchObject({
        code: 'PROTOTYPE_MODERATION_UNAVAILABLE',
      });
      unchanged(deps);
    },
  );
  it('fails closed on provider timeout without exposing provider details', async () => {
    axios.post.mockRejectedValue(
      Object.assign(new Error('private provider detail'), { code: 'ECONNABORTED' }),
    );
    const { service, deps } = harness();
    await expect(submit(service)).rejects.toMatchObject({
      code: 'PROTOTYPE_MODERATION_UNAVAILABLE',
    });
    unchanged(deps);
  });
  it('allows an unflagged request without changing the saved text or execution contract', async () => {
    axios.post.mockResolvedValue({ data: { results: [{ flagged: false }] } });
    const job = {
      jobId: 'job-content',
      conversationId: 'conversation-1',
      revision: 0,
      status: 'queued',
      modelId: 'trusted/model',
    };
    const { service, deps } = harness({
      createPrototypeJob: jest.fn().mockResolvedValue({ created: true, job }),
    });
    await expect(submit(service)).resolves.toMatchObject({ jobId: job.jobId });
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledTimes(1);
    expect(deps.createPrototypeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Create the requested prototype' }),
      expect.anything(),
    );
  });
  it('returns a committed idempotent submit without rechecking or enqueueing', async () => {
    const job = {
      jobId: 'job-content',
      conversationId: 'conversation-1',
      revision: 1,
      status: 'review',
      modelId: 'trusted/model',
    };
    const { service, deps } = harness({
      findOwnedPrototypeJobByConversation: jest.fn().mockResolvedValue(job),
      findPrototypeOutbox: jest.fn().mockResolvedValue({ jobId: job.jobId }),
    });
    await expect(submit(service)).resolves.toMatchObject({ jobId: job.jobId });
    expect(axios.post).not.toHaveBeenCalled();
    unchanged(deps);
  });
});

describe('PrototypeService', () => {
  it.each([false, undefined, null, 'true', 1])(
    'rejects direct submit and model tool execution when enabled is %s',
    async (enabled) => {
      const { service, deps } = harness();
      const req = reqFor();
      req.config.prototypeAgent.enabled = enabled;
      await expect(
        service.submitTurn({
          req,
          conversationId: 'conversation-1',
          messageId: 'message-1',
          parentMessageId: 'parent-1',
          text: 'Build a task manager',
          modelId: 'trusted/model',
          idempotencyKey: 'disabled-submit',
        }),
      ).rejects.toMatchObject({ code: 'PROTOTYPE_SERVICE_UNAVAILABLE' });
      await expect(
        service.acceptToolCall({
          req,
          spec: 'Build a task manager',
          toolCallId: 'tool-1',
          messageId: 'message-1',
          modelId: 'trusted/model',
        }),
      ).rejects.toMatchObject({ code: 'PROTOTYPE_SERVICE_UNAVAILABLE' });
      expect(deps.startSession).not.toHaveBeenCalled();
    },
  );
  it('rejects the model tool when the worker loses availability before invocation', async () => {
    const { service, deps } = harness({ isAvailable: () => false });
    await expect(service.acceptToolCall({ req: reqFor(), spec: 'Build a task manager',
      toolCallId: 'tool-1', messageId: 'message-1', modelId: 'trusted/model' }))
      .rejects.toMatchObject({ code: 'PROTOTYPE_SERVICE_UNAVAILABLE' });
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  const previousTurnLimit = process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD;
  beforeAll(() => { process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD = '1'; });
  afterAll(() => {
    if (previousTurnLimit === undefined) delete process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD;
    else process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD = previousTurnLimit;
  });

  it('uses the current model saved in an owner-bound review reply, rather than the initial job model', async () => {
    const job = { jobId: 'job-model', userId, tenantId: 'tenant-1', conversationId: 'conversation-1',
      status: 'review', modelId: 'trusted/initial', revision: 3, fenceToken: 4,
      latestPromptMessageId: 'prompt-model', activity: [], versions: [] };
    const message = { messageId: 'reply-model', user: userId, tenantId: 'tenant-1',
      conversationId: 'conversation-1', text: 'Change the layout', model: 'trusted/current', attachments: [] };
    const { service, deps } = harness({ getOwnedPrototypeJob: jest.fn().mockResolvedValue(job),
      getMessage: jest.fn().mockResolvedValue(message), claimPrototypeReply: jest.fn().mockResolvedValue({
        job: { ...job, status: 'queued', revision: 4, modelId: message.model }, turn: {} }) });
    await expect(service.acceptReply({ req: reqFor(), jobId: job.jobId, conversationId: job.conversationId,
      messageId: message.messageId, prototypeReplyToMessageId: job.latestPromptMessageId,
      idempotencyKey: 'model-selection', expectedRevision: 3 })).resolves.toMatchObject({ modelId: 'trusted/current' });
    expect(deps.claimPrototypeReply).toHaveBeenCalledWith(expect.objectContaining({
      turn: expect.objectContaining({ modelId: message.model }) }), expect.anything());
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledWith(expect.objectContaining({ modelId: message.model }), expect.anything());
  });

  it('rejects a blocked model selected for a review reply before claiming a turn', async () => {
    const { service, deps } = harness({ getOwnedPrototypeJob: jest.fn().mockResolvedValue({ jobId: 'job-model',
      userId, tenantId: 'tenant-1', conversationId: 'conversation-1', status: 'review', modelId: 'trusted/initial',
      revision: 3, fenceToken: 4, latestPromptMessageId: 'prompt-model' }),
      getMessage: jest.fn().mockResolvedValue({ messageId: 'reply-model', user: userId,
        tenantId: 'tenant-1', conversationId: 'conversation-1', text: 'Change', model: 'blocked/current' }) });
    await expect(service.acceptReply({ req: reqFor(), jobId: 'job-model', conversationId: 'conversation-1',
      messageId: 'reply-model', prototypeReplyToMessageId: 'prompt-model', idempotencyKey: 'blocked',
      expectedRevision: 3 })).rejects.toMatchObject({ code: 'PROTOTYPE_MODEL_BLOCKED' });
    expect(deps.claimPrototypeReply).not.toHaveBeenCalled();
    expect(deps.enqueuePrototypeOutbox).not.toHaveBeenCalled();
  });
  it.each(['user@example.org', 'user@sberdevices.ru', undefined])(
    'atomically persists an ordinary-chat Prototype submit for authenticated email %s', async (email) => {
    const createdJob = {
      jobId: 'job-1', userId, tenantId: 'tenant-1', conversationId: 'conversation-1',
      status: 'queued', revision: 0, eventSequence: 0, fenceToken: 1,
      activeTurnId: 'turn_created', modelId: 'trusted/model',
      modelRecommendation: 'recommended', activity: [], versions: [],
    };
    const { service, deps, session } = harness({
      createId: jest.fn(() => 'job-1'),
      findOwnedPrototypeJobByConversation: jest.fn().mockResolvedValue(null),
      createPrototypeJob: jest.fn().mockResolvedValue({ created: true, job: createdJob }),
      appendPrototypeEvent: jest.fn(async (input) => {
        const event = new PrototypeEvent(input);
        await event.validate();
        return event.toObject();
      }),
    });
    const defaultTenantRequest = reqFor();
    defaultTenantRequest.user = { id: userId, email };
    defaultTenantRequest.body = {};

    await expect(service.submitTurn({
      req: defaultTenantRequest, conversationId: 'conversation-1', messageId: 'message-chat-1',
      parentMessageId: '00000000-0000-0000-0000-000000000000', text: 'Build a dashboard',
      modelId: 'trusted/model', idempotencyKey: 'submit-key',
    })).resolves.toMatchObject({ jobId: 'job-1', modelId: 'trusted/model' });

    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(deps.createPrototypeUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-chat-1', conversationId: 'conversation-1',
        metadata: expect.objectContaining({ prototypeAgent: true, idempotencyKey: 'submit-key' }),
      }),
      session,
    );
    expect(deps.createPrototypeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'trusted/model', attachmentManifest: [] }),
      session,
    );
    expect(deps.createPrototypeJob).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: '__default__' }),
      session,
    );
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledTimes(1);
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ budget: expect.objectContaining({ maxCostUsd: 1, maxRequests: 30 }) }),
      session,
    );
  });

  it('starts a new model-fixed turn in the same completed conversation job', async () => {
    const completed = {
      jobId: 'job-existing', userId, tenantId: 'tenant-1', conversationId: 'conversation-1',
      status: 'completed', revision: 4, eventSequence: 7, fenceToken: 5,
      activeTurnId: 'turn-old', modelId: 'trusted/old', modelRecommendation: 'recommended',
      checkpointRevision: 4, checkpointDigest: null, sourcesDigest: null,
      activity: [], versions: [],
    };
    const restarted = {
      ...completed, status: 'queued', revision: 5, fenceToken: 6,
      activeTurnId: 'turn_restarted', modelId: 'trusted/model',
    };
    const { service, deps } = harness({
      findOwnedPrototypeJobByConversation: jest.fn().mockResolvedValue(completed),
      claimPrototypeTurn: jest.fn().mockResolvedValue({ job: restarted, turn: {} }),
    });

    await expect(service.submitTurn({
      req: reqFor(), conversationId: 'conversation-1', messageId: 'message-chat-2',
      parentMessageId: 'message-old', text: 'Add a reports tab', modelId: 'trusted/model',
      idempotencyKey: 'new-turn-key', revision: 4,
    })).resolves.toMatchObject({ jobId: 'job-existing', turnId: 'turn_restarted' });

    expect(deps.createPrototypeJob).not.toHaveBeenCalled();
    expect(deps.claimPrototypeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-existing', expectedRevision: 4, modelId: 'trusted/model',
        turn: expect.objectContaining({ modelId: 'trusted/model' }),
      }),
      expect.anything(),
    );
  });

  it('returns the original result for a repeated ordinary-chat idempotency key', async () => {
    const existing = {
      jobId: 'job-existing', userId, tenantId: 'tenant-1', conversationId: 'conversation-1',
      status: 'queued', revision: 2, eventSequence: 3, fenceToken: 2,
      activeTurnId: 'turn-existing', modelId: 'trusted/model',
      modelRecommendation: 'recommended', activity: [], versions: [],
    };
    const { service, deps } = harness({
      findOwnedPrototypeJobByConversation: jest.fn().mockResolvedValue(existing),
      findPrototypeOutbox: jest.fn().mockResolvedValue({ jobId: 'job-existing' }),
    });

    await expect(service.submitTurn({
      req: reqFor(), conversationId: 'conversation-1', messageId: 'message-chat-1',
      parentMessageId: 'message-parent', text: 'Build a dashboard',
      modelId: 'trusted/model', idempotencyKey: 'same-key',
    })).resolves.toMatchObject({ jobId: 'job-existing', revision: 2, cursor: 3 });
    expect(deps.createPrototypeUserMessage).not.toHaveBeenCalled();
    expect(deps.enqueuePrototypeOutbox).not.toHaveBeenCalled();
  });

  it('requires waiting-state replies to use the message-identity reply boundary', async () => {
    const waiting = {
      jobId: 'job-existing', userId, tenantId: 'tenant-1', conversationId: 'conversation-1',
      status: 'waiting_for_input', waitingReason: 'clarification', revision: 2,
      latestPromptMessageId: 'prototype-prompt-1', modelId: 'trusted/model',
    };
    const { service, deps } = harness({
      findOwnedPrototypeJobByConversation: jest.fn().mockResolvedValue(waiting),
    });

    await expect(service.submitTurn({
      req: reqFor(), conversationId: 'conversation-1', messageId: 'message-chat-2',
      parentMessageId: 'prototype-prompt-1', text: 'Make it blue', modelId: 'trusted/model',
      idempotencyKey: 'reply-via-submit', revision: 2,
      promptMessageId: 'prototype-prompt-1',
    })).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_STATE' });

    expect(deps.claimPrototypeReply).not.toHaveBeenCalled();
    expect(deps.enqueuePrototypeOutbox).not.toHaveBeenCalled();
  });
  it('creates and enqueues a job when advisory cost lookup fails', async () => {
    const createdJob = {
      jobId: 'job-1',
      userId,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      originMessageId: 'message-1',
      originToolCallId: 'tool-1',
      status: 'queued',
      modelId: 'trusted/model',
      modelPolicyVersion: 'policy-v1',
      modelRecommendation: 'recommended',
      revision: 0,
      estimatedCost: null,
      actualCostUsd: 0,
    };
    const { service, deps } = harness({
      estimateCost: jest.fn().mockRejectedValue(new Error('balance timeout')),
      createPrototypeJob: jest.fn().mockResolvedValue({ created: true, job: createdJob }),
    });

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'Build a dashboard',
        toolCallId: 'tool-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
      }),
    ).resolves.toEqual({ jobId: 'job-1', status: 'queued', modelId: 'trusted/model' });

    expect(deps.createPrototypeJob).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedCost: null }),
      expect.anything(),
    );
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledTimes(1);
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ budget: expect.objectContaining({ maxCostUsd: 1, maxRequests: 30 }) }),
      expect.anything(),
    );
  });

  it('persists the advisory estimate even when the balance is likely insufficient', async () => {
    const estimate = {
      currency: 'USD',
      low: 0.1,
      likely: 1,
      high: 2.4,
      recoveryBufferPercent: 20,
      method: 'admin_default',
      sampleSize: 0,
      modelId: 'trusted/model',
      calculatedAt: new Date('2033-05-18T03:33:20.000Z'),
      balanceRemaining: 0.01,
    };
    const createdJob = {
      jobId: 'job-1',
      userId,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      originMessageId: 'message-1',
      originToolCallId: 'tool-1',
      status: 'queued',
      modelId: 'trusted/model',
      modelPolicyVersion: 'policy-v1',
      modelRecommendation: 'recommended',
      revision: 0,
      estimatedCost: estimate,
      actualCostUsd: 0,
    };
    const { service, deps } = harness({
      estimateCost: jest.fn().mockResolvedValue(estimate),
      createPrototypeJob: jest.fn().mockResolvedValue({ created: true, job: createdJob }),
    });

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'Build a dashboard',
        toolCallId: 'tool-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
      }),
    ).resolves.toMatchObject({ status: 'queued' });
    expect(deps.createPrototypeJob).toHaveBeenCalledWith(
      expect.objectContaining({ estimatedCost: estimate, status: 'queued' }),
      expect.anything(),
    );
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledTimes(1);
  });

  it('returns only an owned job for BFF reads and hides missing jobs', async () => {
    const owned = {
      jobId: 'job-1',
      conversationId: 'conversation-1',
      status: 'queued',
      modelId: 'trusted/model',
    };
    const { service, deps } = harness({ getOwnedPrototypeJob: jest.fn().mockResolvedValue(owned) });

    await expect(service.getJob({ req: reqFor(), jobId: 'job-1' })).resolves.toMatchObject({
      jobId: 'job-1',
      status: 'queued',
    });
    expect(deps.getOwnedPrototypeJob).toHaveBeenCalledWith({
      jobId: 'job-1',
      userId,
      tenantId: 'tenant-1',
    });

    deps.getOwnedPrototypeJob.mockResolvedValueOnce(null);
    await expect(service.getJob({ req: reqFor(), jobId: 'missing' })).rejects.toMatchObject({
      code: 'PROTOTYPE_JOB_NOT_FOUND',
    });

    await expect(service.getJob({
      req: reqFor(), jobId: 'job-1', conversationId: 'copied-conversation',
    })).rejects.toMatchObject({ code: 'PROTOTYPE_JOB_NOT_FOUND' });
  });

  it('scopes conversation state reads and authorizes before artifact readiness', async () => {
    const owned = {
      jobId: 'job-1',
      conversationId: 'conversation-1',
      status: 'queued',
      modelId: 'trusted/model',
    };
    const { service, deps } = harness({
      findOwnedPrototypeJobByConversation: jest.fn().mockResolvedValue(owned),
      getOwnedPrototypeJob: jest.fn().mockResolvedValue(owned),
    });

    await expect(
      service.getConversationJob({ req: reqFor(), conversationId: 'conversation-1' }),
    ).resolves.toMatchObject({ jobId: 'job-1' });
    expect(deps.findOwnedPrototypeJobByConversation).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      userId,
      tenantId: 'tenant-1',
    });
    await expect(service.requireArtifact({ req: reqFor(), jobId: 'job-1' })).rejects.toMatchObject({
      code: 'PROTOTYPE_ARTIFACT_NOT_READY',
    });
  });

  it('reads a historical accepted artifact by its public revision and digest', async () => {
    const version = {
      revision: 7,
      turnId: 'turn-previous',
      htmlDigest: `sha256:${'a'.repeat(64)}`,
      sourcesDigest: `sha256:${'b'.repeat(64)}`,
      acceptedAt: '2026-09-28T00:00:00.000Z',
    };
    const owned = {
      jobId: 'job-1',
      conversationId: 'conversation-1',
      status: 'running',
      modelId: 'trusted/model',
      versions: [version],
    };
    const artifact = {
      bytes: Buffer.from('<!doctype html>'),
      contentType: 'text/html; charset=utf-8',
      filename: 'prototype-job-1.html',
      digest: version.htmlDigest,
    };
    const { service, deps } = harness({
      getOwnedPrototypeJob: jest.fn().mockResolvedValue(owned),
      readPrototypeArtifact: jest.fn().mockResolvedValue(artifact),
    });

    await expect(service.requireArtifact({
      req: reqFor(), jobId: 'job-1', kind: 'html', version: 7,
    })).resolves.toEqual(artifact);
    expect(deps.readPrototypeArtifact).toHaveBeenCalledWith(expect.objectContaining({
      job: owned,
      artifactId: null,
      digest: version.htmlDigest,
      kind: 'html',
    }));
  });
  it.each(['   ', 'x'.repeat(50001)])('rejects an invalid trimmed spec', async (spec) => {
    const { service, deps } = harness();

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec,
        toolCallId: 'tool-call-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
        attachments: [{ file_id: 'untrusted-tool-argument' }],
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_REQUEST' });

    expect(deps.startSession).not.toHaveBeenCalled();
  });

  it('rejects a model whose trusted provider capability lacks tool calling', async () => {
    const req = reqFor();
    req.prototypeProviderCapabilities = { toolCalling: false };
    const { service, deps } = harness();

    await expect(service.acceptToolCall({
      req,
      spec: 'Build a CRM',
      toolCallId: 'tool-call-1',
      messageId: 'message-1',
      modelId: 'trusted/model',
    })).rejects.toMatchObject({ code: 'PROTOTYPE_MODEL_UNSUPPORTED' });
    expect(deps.startSession).not.toHaveBeenCalled();
  });

  it.each(['user@example.org', 'user@sberdevices.ru', undefined])(
    'accepts an atomic model tool call for authenticated email %s', async (email) => {
    const { service, deps, session } = harness({
      getMessage: jest.fn().mockResolvedValue({
        messageId: 'message-1',
        conversationId: 'conversation-1',
        user: userId,
        tenantId: 'tenant-1',
        attachments: [],
      }),
      createPrototypeJob: jest.fn().mockResolvedValue({
        created: true,
        job: { jobId: 'job-1', status: 'queued', revision: 0, modelId: 'trusted/model' },
      }),
    });

    const req = reqFor();
    req.user.email = email;
    await expect(
      service.acceptToolCall({
        req,
        spec: '  Build a CRM  ',
        toolCallId: 'tool-call-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
        attachments: [{ file_id: 'untrusted-tool-argument' }],
      }),
    ).resolves.toEqual({ jobId: 'job-1', status: 'queued', modelId: 'trusted/model' });

    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(deps.createPrototypeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        originToolCallId: 'tool-call-1',
        originMessageId: 'message-1',
        modelId: 'trusted/model',
        modelPolicyVersion: 'policy-v1',
      }),
      session,
    );
    expect(deps.createPrototypeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'initial',
        text: 'Build a CRM',
        sourceMessageId: 'message-1',
        attachmentManifest: [],
      }),
      session,
    );
    expect(deps.appendPrototypeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 0,
        revision: 0,
        type: 'job_state',
        publicPayload: expect.objectContaining({
          type: 'prototype',
          jobId: 'job-1',
          status: 'queued',
          modelId: 'trusted/model',
        }),
      }),
      session,
    );
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 2,
        kind: 'execute_stage',
        jobId: 'job-1',
        modelId: 'trusted/model',
        expectedRevision: 0,
        attachmentManifest: [],
      }),
      session,
    );
  });

  it('returns the existing job for a duplicate origin without writing siblings', async () => {
    const existing = {
      jobId: 'job-existing',
      userId,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      originMessageId: 'message-1',
      status: 'running',
      revision: 4,
      modelId: 'trusted/model',
    };
    const { service, deps } = harness({
      createPrototypeJob: jest.fn().mockResolvedValue({ created: false, job: existing }),
    });

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'Build a CRM',
        toolCallId: 'tool-call-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
      }),
    ).resolves.toEqual({ jobId: 'job-existing', status: 'running', modelId: 'trusted/model' });

    expect(deps.createPrototypeTurn).not.toHaveBeenCalled();
    expect(deps.appendPrototypeEvent).not.toHaveBeenCalled();
    expect(deps.enqueuePrototypeOutbox).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'user', patch: { userId: new Types.ObjectId().toString() } },
    { name: 'tenant', patch: { tenantId: 'tenant-foreign' } },
    { name: 'conversation', patch: { conversationId: 'conversation-foreign' } },
    { name: 'origin message', patch: { originMessageId: 'message-foreign' } },
    { name: 'model', patch: { modelId: 'trusted/other-model' } },
  ])('does not disclose a duplicate origin collision with another $name', async ({ patch }) => {
    const foreign = {
      jobId: 'job-foreign',
      userId,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      originMessageId: 'message-1',
      originToolCallId: 'tool-call-1',
      status: 'running',
      revision: 4,
      modelId: 'trusted/model',
      ...patch,
    };
    const { service } = harness({
      createPrototypeJob: jest.fn().mockResolvedValue({ created: false, job: foreign }),
    });

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'Build a CRM',
        toolCallId: 'tool-call-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
      }),
    ).rejects.toMatchObject({
      code: 'PROTOTYPE_JOB_NOT_FOUND',
      message: 'Prototype job not found',
    });
  });

  it('maps the active-job unique constraint to a stable conflict', async () => {
    const duplicate = Object.assign(new Error('duplicate key'), {
      code: 11000,
      keyPattern: { tenantId: 1, conversationId: 1 },
    });
    const { service } = harness({ createPrototypeJob: jest.fn().mockRejectedValue(duplicate) });

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'Build another CRM',
        toolCallId: 'tool-call-2',
        messageId: 'message-2',
        modelId: 'trusted/model',
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_ACTIVE_JOB_EXISTS' });
  });

  it('rejects a blocked model selected by the trusted server context', async () => {
    const { service, deps } = harness();

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'Build a CRM',
        toolCallId: 'tool-call-1',
        messageId: 'message-1',
        modelId: 'blocked/model',
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_MODEL_BLOCKED' });

    expect(deps.createPrototypeJob).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'PPT',
      file: {
        file_id: 'file-ppt',
        filename: 'deck.ppt',
        type: 'application/vnd.ms-powerpoint',
        bytes: 12,
      },
    },
    {
      name: 'PPTX',
      file: {
        file_id: 'file-pptx',
        filename: 'deck.pptx',
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        bytes: 34,
      },
    },
    {
      name: 'ODP',
      file: {
        file_id: 'file-odp',
        filename: 'deck.odp',
        type: 'application/vnd.oasis.opendocument.presentation',
        bytes: 56,
      },
    },
  ])(
    'derives an untrusted $name attachment manifest from owned message/file records',
    async ({ file }) => {
      const { service, deps } = harness({
        getMessage: jest.fn().mockResolvedValue({
          messageId: 'message-1',
          conversationId: 'conversation-1',
          user: userId,
          tenantId: 'tenant-1',
          files: [file.file_id],
          attachments: [{ file_id: file.file_id }],
        }),
        findFileById: jest.fn().mockResolvedValue({
          ...file,
          user: userId,
          tenantId: 'tenant-1',
          conversationId: 'conversation-1',
          messageId: 'message-1',
        }),
        createPrototypeJob: jest.fn().mockResolvedValue({
          created: true,
          job: { jobId: 'job-1', status: 'queued', revision: 0, modelId: 'trusted/model' },
        }),
      });

      await service.acceptToolCall({
        req: reqFor(),
        spec: 'Build slides',
        toolCallId: 'tool-call-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
        attachments: [{ file_id: 'forged-file' }],
      });

      const manifest = [
        { fileId: file.file_id, filename: file.filename, mimeType: file.type, size: file.bytes },
      ];
      expect(deps.findFileById).toHaveBeenCalledWith(file.file_id, {
        user: userId,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      });
      expect(deps.createPrototypeTurn).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentManifest: manifest }),
        expect.anything(),
      );
      expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledWith(
        expect.objectContaining({ attachmentManifest: manifest }),
        expect.anything(),
      );
    },
  );

  it('rejects a message or attachment that is not owned without revealing which lookup failed', async () => {
    const { service } = harness({
      getMessage: jest.fn().mockResolvedValue({
        messageId: 'message-1',
        conversationId: 'conversation-1',
        user: userId,
        tenantId: 'tenant-1',
        files: ['foreign-file'],
      }),
      findFileById: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'Build a CRM',
        toolCallId: 'tool-call-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
      }),
    ).rejects.toMatchObject({
      code: 'PROTOTYPE_JOB_NOT_FOUND',
      message: 'Prototype job not found',
    });
  });

  it('rejects a legacy null-tenant message instead of bypassing tenant isolation', async () => {
    const file = {
      file_id: 'legacy-file',
      filename: 'legacy.ppt',
      type: 'application/vnd.ms-powerpoint',
      bytes: 12,
      user: userId,
      tenantId: null,
      conversationId: 'conversation-1',
      messageId: 'message-1',
    };
    const { service, deps } = harness({
      getMessage: jest.fn().mockResolvedValue({
        messageId: 'message-1',
        conversationId: 'conversation-1',
        user: userId,
        tenantId: null,
        files: ['legacy-file'],
      }),
      findFileById: jest.fn().mockResolvedValue(file),
      createPrototypeJob: jest.fn().mockResolvedValue({
        created: true,
        job: { jobId: 'job-1', status: 'queued', revision: 0, modelId: 'trusted/model' },
      }),
    });

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'Build from legacy slides',
        toolCallId: 'tool-call-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_JOB_NOT_FOUND' });

    expect(deps.findFileById).not.toHaveBeenCalled();
  });

  it('denies a legacy null-tenant file when exact user/message bindings do not match', async () => {
    const { service } = harness({
      getMessage: jest.fn().mockResolvedValue({
        messageId: 'message-1',
        conversationId: 'conversation-1',
        user: userId,
        tenantId: null,
        files: ['legacy-foreign-file'],
      }),
      findFileById: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.acceptToolCall({
        req: reqFor(),
        spec: 'Build from legacy slides',
        toolCallId: 'tool-call-1',
        messageId: 'message-1',
        modelId: 'trusted/model',
      }),
    ).rejects.toMatchObject({
      code: 'PROTOTYPE_JOB_NOT_FOUND',
      message: 'Prototype job not found',
    });
  });

  it.each(['clarification', 'plan_approval'])('accepts an explicit %s reply target and derives text in the transaction', async (waitingReason) => {
    const waitingJob = {
      jobId: 'job-1',
      userId,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      status: 'waiting_for_input',
      waitingReason,
      revision: 3,
      modelId: 'trusted/model',
      latestPromptMessageId: 'prototype-prompt-1',
      checkpointRevision: 2,
      actualCostUsd: 0,
    };
    const queuedJob = {
      ...waitingJob,
      status: 'queued',
      revision: 4,
      latestPromptMessageId: 'prototype-prompt-1',
    };
    const { service, deps, session } = harness({
      getOwnedPrototypeJob: jest.fn().mockResolvedValue(waitingJob),
      getMessage: jest.fn(async ({ messageId }) =>
        messageId === 'reply-1'
          ? {
              messageId,
              conversationId: 'conversation-1',
              user: userId,
              tenantId: 'tenant-1',
              text: '  Make it blue  ',
              attachments: [],
            }
          : {
              messageId,
              conversationId: 'conversation-1',
              user: userId,
              tenantId: 'tenant-1',
            },
      ),
      claimPrototypeReply: jest
        .fn()
        .mockResolvedValue({ job: queuedJob, turn: { turnId: 'turn-1' } }),
    });

    await expect(
      service.acceptReply({
        req: reqFor(),
        jobId: 'job-1',
        messageId: 'reply-1',
        prototypeReplyToMessageId: 'prototype-prompt-1',
        idempotencyKey: 'reply-key',
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({ jobId: 'job-1', status: 'queued', modelId: 'trusted/model' });

    expect(deps.claimPrototypeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        expectedRevision: 3,
        replyToPrototypeMessageId: 'prototype-prompt-1',
        turn: expect.objectContaining({
          kind: 'user_reply',
          sourceMessageId: 'reply-1',
          replyToPrototypeMessageId: 'prototype-prompt-1',
          text: 'Make it blue',
        }),
      }),
      session,
    );
    expect(deps.getMessage).toHaveBeenCalledWith(
      {
        user: userId,
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        messageId: 'reply-1',
      },
      session,
    );
    expect(deps.appendPrototypeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4, type: 'job_state' }),
      session,
    );
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'execute_stage', expectedRevision: 4 }),
      session,
    );
  });

  it('returns the committed job when the same reply idempotency key is retried', async () => {
    const waitingJob = {
      jobId: 'job-1',
      userId,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      status: 'waiting_for_input',
      revision: 3,
      modelId: 'trusted/model',
      latestPromptMessageId: 'prototype-prompt-1',
      checkpointRevision: 2,
      actualCostUsd: 0,
    };
    const queuedJob = { ...waitingJob, status: 'queued', revision: 4 };
    let currentJob = waitingJob;
    let committedCommand;
    const { service, deps } = harness({
      getOwnedPrototypeJob: jest.fn(async () => currentJob),
      getMessage: jest.fn().mockResolvedValue({
        messageId: 'reply-1',
        conversationId: 'conversation-1',
        user: userId,
        tenantId: 'tenant-1',
        text: 'Make it blue',
        attachments: [],
      }),
      findPrototypeOutbox: jest.fn(async (commandId) =>
        committedCommand?.commandId === commandId ? committedCommand : null,
      ),
      claimPrototypeReply: jest.fn(async () => {
        currentJob = queuedJob;
        return { job: queuedJob, turn: { turnId: 'turn-1' } };
      }),
      enqueuePrototypeOutbox: jest.fn(async (command) => {
        committedCommand = command;
        return command;
      }),
    });
    const request = {
      req: reqFor(),
      jobId: 'job-1',
      messageId: 'reply-1',
      prototypeReplyToMessageId: 'prototype-prompt-1',
      idempotencyKey: 'reply-key',
      expectedRevision: 3,
    };

    await expect(service.acceptReply(request)).resolves.toMatchObject({
      jobId: 'job-1',
      status: 'queued',
    });
    await expect(service.acceptReply(request)).resolves.toMatchObject({
      jobId: 'job-1',
      status: 'queued',
    });

    expect(deps.claimPrototypeReply).toHaveBeenCalledTimes(1);
    expect(deps.appendPrototypeEvent).toHaveBeenCalledTimes(1);
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledTimes(1);
  });

  it('rejects a reply with a stale revision before reading the chat message', async () => {
    const { service, deps } = harness({
      getOwnedPrototypeJob: jest.fn().mockResolvedValue({
        jobId: 'job-1',
        conversationId: 'conversation-1',
        status: 'waiting_for_input',
        revision: 4,
        modelId: 'trusted/model',
      }),
    });

    await expect(
      service.acceptReply({
        req: reqFor(),
        jobId: 'job-1',
        messageId: 'reply-1',
        prototypeReplyToMessageId: 'prototype-prompt-1',
        idempotencyKey: 'stale-reply',
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_STALE_REVISION' });

    expect(deps.getMessage).not.toHaveBeenCalled();
    expect(deps.claimPrototypeReply).not.toHaveBeenCalled();
    expect(deps.discardPrototypeReplyMessage).toHaveBeenCalledWith({
      jobId: 'job-1',
      user: userId,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      messageId: 'reply-1',
      prototypeReplyToMessageId: 'prototype-prompt-1',
    });
  });

  it('discards the losing persisted reply when the CAS claim is stale', async () => {
    const waitingJob = {
      jobId: 'job-1',
      userId,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      status: 'waiting_for_input',
      waitingReason: 'clarification',
      revision: 3,
      modelId: 'trusted/model',
      latestPromptMessageId: 'prototype-prompt-1',
    };
    const stale = Object.assign(new Error('stale reply'), { code: 'PROTOTYPE_STALE_REVISION' });
    const { service, deps } = harness({
      getOwnedPrototypeJob: jest.fn().mockResolvedValue(waitingJob),
      getMessage: jest.fn().mockResolvedValue({
        messageId: 'reply-loser',
        conversationId: 'conversation-1',
        user: userId,
        tenantId: 'tenant-1',
        text: 'Green',
      }),
      claimPrototypeReply: jest.fn().mockRejectedValue(stale),
    });

    await expect(
      service.acceptReply({
        req: reqFor(),
        jobId: 'job-1',
        conversationId: 'conversation-1',
        messageId: 'reply-loser',
        prototypeReplyToMessageId: 'prototype-prompt-1',
        idempotencyKey: 'reply-loser-key',
        expectedRevision: 3,
      }),
    ).rejects.toBe(stale);

    expect(deps.discardPrototypeReplyMessage).toHaveBeenCalledWith({
      jobId: 'job-1',
      user: userId,
      tenantId: 'tenant-1',
      conversationId: 'conversation-1',
      messageId: 'reply-loser',
      prototypeReplyToMessageId: 'prototype-prompt-1',
    });
    expect(deps.enqueuePrototypeOutbox).not.toHaveBeenCalled();
  });

  it('rejects an action with a stale revision before applying a transition', async () => {
    const { service, deps } = harness({
      getOwnedPrototypeJob: jest.fn().mockResolvedValue({
        jobId: 'job-1',
        conversationId: 'conversation-1',
        status: 'running',
        revision: 4,
        modelId: 'trusted/model',
      }),
    });

    await expect(
      service.cancel({
        req: reqFor(),
        jobId: 'job-1',
        idempotencyKey: 'stale-cancel',
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_STALE_REVISION' });

    expect(deps.transitionPrototypeJob).not.toHaveBeenCalled();
    expect(deps.enqueuePrototypeOutbox).not.toHaveBeenCalled();
  });

  it('hides foreign reply jobs behind the same not-found error', async () => {
    const { service, deps } = harness({ getOwnedPrototypeJob: jest.fn().mockResolvedValue(null) });

    await expect(
      service.acceptReply({
        req: reqFor(new Types.ObjectId().toString()),
        jobId: 'job-1',
        messageId: 'reply-1',
        prototypeReplyToMessageId: 'prototype-prompt-1',
        idempotencyKey: 'reply-key',
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      code: 'PROTOTYPE_JOB_NOT_FOUND',
      message: 'Prototype job not found',
    });

    expect(deps.claimPrototypeReply).not.toHaveBeenCalled();
  });

  it('rejects an absent explicit prototype reply target', async () => {
    const { service } = harness();

    await expect(
      service.acceptReply({
        req: reqFor(),
        jobId: 'job-1',
        messageId: 'reply-1',
        prototypeReplyToMessageId: '',
        idempotencyKey: 'reply-key',
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_REPLY' });
  });

  it.each(['completed', 'failed', 'canceled'])(
    'does not cancel terminal job state %s',
    async (status) => {
      const job = {
        jobId: 'job-1',
        conversationId: 'conversation-1',
        status,
        revision: 3,
        modelId: 'trusted/model',
      };
      const { service, deps } = harness({ getOwnedPrototypeJob: jest.fn().mockResolvedValue(job) });

      await expect(
        service.cancel({
          req: reqFor(), jobId: 'job-1', idempotencyKey: 'cancel-key', expectedRevision: 3,
        }),
      ).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_STATE' });

      expect(deps.transitionPrototypeJob).not.toHaveBeenCalled();
    },
  );

  it('cancels an active job and enqueues the abort atomically', async () => {
    const active = {
      jobId: 'job-1',
      conversationId: 'conversation-1',
      status: 'running',
      revision: 3,
      modelId: 'trusted/model',
      fenceToken: 3,
      activeAttemptId: 'attempt-old',
      activeExecutionId: 'execution-old',
      activeStage: 'generation',
      actualCostUsd: 1,
    };
    const canceled = { ...active, status: 'canceled', revision: 4, activeExecutionId: null };
    const { service, deps, session } = harness({
      getOwnedPrototypeJob: jest.fn().mockResolvedValue(active),
      findLatestPrototypeTurn: jest
        .fn()
        .mockResolvedValue({ turnId: 'turn-current', attachmentManifest: [] }),
      transitionPrototypeJob: jest.fn().mockResolvedValue(canceled),
    });

    await service.cancel({
      req: reqFor(), jobId: 'job-1', idempotencyKey: 'cancel-key', expectedRevision: 3,
    });

    expect(deps.transitionPrototypeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        expectedRevision: 3,
        from: 'running',
        to: 'canceled',
        executionId: 'execution-old',
      }),
    );
    expect(deps.appendPrototypeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4, type: 'job_state' }),
      session,
    );
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'cancel_execution',
        turnId: 'turn-current',
        expectedRevision: 3,
        fenceToken: 3,
        attemptId: 'attempt-old',
      }),
      session,
    );
  });

  it.each(['waiting_for_credentials', 'waiting_for_funds'])(
    'resumes %s with the same logical turn',
    async (status) => {
      const paused = {
        jobId: 'job-1',
        conversationId: 'conversation-1',
        status,
        revision: 3,
        modelId: 'trusted/model',
        checkpointRevision: 2,
        actualCostUsd: 1,
      };
      const queued = { ...paused, status: 'queued', revision: 4 };
      const { service, deps, session } = harness({
        getOwnedPrototypeJob: jest.fn().mockResolvedValue(paused),
        findLatestPrototypeTurn: jest.fn().mockResolvedValue({
          turnId: 'turn-current',
          attachmentManifest: [
            { fileId: 'f1', filename: 'a.txt', mimeType: 'text/plain', size: 1 },
          ],
        }),
        transitionPrototypeJob: jest.fn().mockResolvedValue(queued),
      });

      await service.resume({
        req: reqFor(), jobId: 'job-1', idempotencyKey: 'resume-key', expectedRevision: 3,
      });

      expect(deps.transitionPrototypeJob).toHaveBeenCalledWith(
        expect.objectContaining({ from: status, to: 'queued', expectedRevision: 3 }),
      );
      expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'execute_stage',
          turnId: 'turn-current',
          expectedRevision: 4,
          checkpointRevision: 2,
        }),
        session,
      );
    },
  );

  it('finalizes an accepted review version without scheduling another generation', async () => {
    const review = {
      selectedVariant: 'B',
      jobId: 'job-1',
      conversationId: 'conversation-1',
      status: 'review',
      revision: 3,
      eventSequence: 6,
      modelId: 'trusted/model',
      fenceToken: 3,
      activeExecutionId: 'execution-review',
      previewArtifactId: 'artifact-html',
      previewDigest: `sha256:${'a'.repeat(64)}`,
      sourcesArtifactId: 'artifact-sources',
      sourcesDigest: `sha256:${'b'.repeat(64)}`,
      activity: [],
      versions: [{ selectedVariant: 'B' }],
      actualCostUsd: 1,
    };
    const completed = {
      ...review,
      status: 'completed',
      revision: 4,
      eventSequence: 7,
      phase: 'completed',
      activeExecutionId: null,
    };
    const { service, deps, session } = harness({
      getOwnedPrototypeJob: jest.fn().mockResolvedValue(review),
      transitionPrototypeJob: jest.fn().mockResolvedValue(completed),
      allocatePrototypeEventSequence: jest.fn().mockResolvedValue(completed),
    });

    await expect(service.finalize({
      req: reqFor(), jobId: 'job-1', idempotencyKey: 'finalize-key', expectedRevision: 3,
    })).resolves.toMatchObject({ status: 'completed', revision: 4, cursor: 7 });

    expect(deps.transitionPrototypeJob).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'review', to: 'completed', expectedRevision: 3 }),
    );
    expect(deps.appendPrototypeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4, type: 'job_state' }),
      session,
    );
    expect(deps.findLatestPrototypeTurn).not.toHaveBeenCalled();
    expect(deps.enqueuePrototypeOutbox).not.toHaveBeenCalled();
  });

  it('returns the committed finalize result when the same key is retried', async () => {
    let current = {
      selectedVariant: 'B',
      jobId: 'job-1', conversationId: 'conversation-1', status: 'review', revision: 3,
      eventSequence: 6, modelId: 'trusted/model', fenceToken: 3,
      activeExecutionId: 'execution-review', activity: [], versions: [{ selectedVariant: 'B' }], actualCostUsd: 1,
    };
    const { service, deps } = harness({
      getOwnedPrototypeJob: jest.fn(async () => current),
      transitionPrototypeJob: jest.fn(async ({ patch }) => {
        current = {
          ...current, ...patch, status: 'completed', revision: 4, eventSequence: 7,
        };
        return current;
      }),
      allocatePrototypeEventSequence: jest.fn(async () => current),
    });
    const request = {
      req: reqFor(), jobId: 'job-1', idempotencyKey: 'finalize-key', expectedRevision: 3,
    };

    await expect(service.finalize(request)).resolves.toMatchObject({ status: 'completed' });
    await expect(service.finalize(request)).resolves.toMatchObject({ status: 'completed' });

    expect(deps.transitionPrototypeJob).toHaveBeenCalledTimes(1);
    expect(deps.appendPrototypeEvent).toHaveBeenCalledTimes(1);
    expect(deps.enqueuePrototypeOutbox).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running', 'waiting_for_input', 'review', 'completed', 'failed', 'canceled'])(
    'rejects resume while %s',
    async (status) => {
      const { service } = harness({
        getOwnedPrototypeJob: jest.fn().mockResolvedValue({
          jobId: 'job-1',
          conversationId: 'conversation-1',
          status,
          revision: 1,
          modelId: 'trusted/model',
        }),
      });

      await expect(
        service.resume({
          req: reqFor(), jobId: 'job-1', idempotencyKey: 'resume-key', expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_STATE' });
    },
  );

  it('returns the committed idempotent cancel result without applying a second transition', async () => {
    const canceled = {
      jobId: 'job-1',
      conversationId: 'conversation-1',
      status: 'canceled',
      revision: 4,
      modelId: 'trusted/model',
      actualCostUsd: 1,
    };
    const { service, deps } = harness({
      getOwnedPrototypeJob: jest.fn().mockResolvedValue(canceled),
      findPrototypeOutbox: jest
        .fn()
        .mockResolvedValue({ commandId: 'cancel:job-1:cancel-key', jobId: 'job-1' }),
    });

    await expect(
      service.cancel({
        req: reqFor(), jobId: 'job-1', idempotencyKey: 'cancel-key', expectedRevision: 4,
      }),
    ).resolves.toMatchObject({ jobId: 'job-1', status: 'canceled' });

    expect(deps.transitionPrototypeJob).not.toHaveBeenCalled();
  });

  it('scopes the same action idempotency key independently to each job', async () => {
    const jobs = {
      'job-1': {
        jobId: 'job-1',
        conversationId: 'conversation-1',
        status: 'running',
        revision: 3,
        modelId: 'trusted/model',
        activeExecutionId: 'execution-old-1',
      },
      'job-2': {
        jobId: 'job-2',
        conversationId: 'conversation-1',
        status: 'running',
        revision: 7,
        modelId: 'trusted/model',
        activeExecutionId: 'execution-old-2',
      },
    };
    const commands = [];
    const { service, deps } = harness({
      getOwnedPrototypeJob: jest.fn(async ({ jobId }) => jobs[jobId]),
      findPrototypeOutbox: jest.fn(async (commandId) =>
        commands.find((command) => command.commandId === commandId),
      ),
      findLatestPrototypeTurn: jest.fn(async (jobId) => ({
        turnId: `turn-${jobId}`,
        attachmentManifest: [],
      })),
      transitionPrototypeJob: jest.fn(async ({ jobId }) => {
        jobs[jobId] = { ...jobs[jobId], status: 'canceled', revision: jobs[jobId].revision + 1 };
        return jobs[jobId];
      }),
      enqueuePrototypeOutbox: jest.fn(async (command) => {
        commands.push(command);
        return command;
      }),
    });

    await service.cancel({
      req: reqFor(), jobId: 'job-1', idempotencyKey: 'shared-key', expectedRevision: 3,
    });
    await service.cancel({
      req: reqFor(), jobId: 'job-2', idempotencyKey: 'shared-key', expectedRevision: 7,
    });

    expect(deps.transitionPrototypeJob).toHaveBeenCalledTimes(2);
    expect(commands.map(({ commandId, jobId }) => ({ commandId, jobId }))).toEqual([
      { commandId: expect.stringMatching(/^cancel_[a-f0-9]{24}$/), jobId: 'job-1' },
      { commandId: expect.stringMatching(/^cancel_[a-f0-9]{24}$/), jobId: 'job-2' },
    ]);
    expect(commands[0].commandId).not.toBe(commands[1].commandId);
  });
});

const transactionDescribe =
  process.env.PROTOTYPE_MONGO_TRANSACTION_TEST === '1' ? describe : describe.skip;

transactionDescribe('PrototypeService real MongoDB transaction', () => {
  const { execFileSync } = require('child_process');
  const mongoose = require('mongoose');
  const { MongoClient } = require('mongodb');
  const { createModels } = require('../../../../packages/data-schemas/dist/models/index.cjs');
  const {
    createPrototypeMethods,
  } = require('../../../../packages/data-schemas/dist/methods/prototype.cjs');
  const containerName = `prototype-transaction-${process.pid}`;
  let connection;
  let models;
  let baseDeps;

  beforeAll(async () => {
    execFileSync('docker', ['image', 'inspect', 'mongo:6'], { stdio: 'ignore' });
    execFileSync(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--pull=never',
        '--name',
        containerName,
        '--hostname',
        containerName,
        '--publish',
        '127.0.0.1::27017',
        'mongo:6',
        'mongod',
        '--replSet',
        'rs0',
        '--port',
        '27017',
        '--bind_ip_all',
      ],
      { stdio: 'ignore' },
    );
    const port = execFileSync('docker', ['port', containerName, '27017/tcp'], { encoding: 'utf8' })
      .trim()
      .split(':')
      .pop();
    const directUri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
    let client;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        client = new MongoClient(directUri, { serverSelectionTimeoutMS: 1000 });
        await client.connect();
        break;
      } catch (error) {
        await client?.close().catch(() => undefined);
        if (attempt === 59) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await client.db('admin').command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: `${containerName}:27017` }],
      },
    });
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const hello = await client.db('admin').command({ hello: 1 });
      if (hello.isWritablePrimary) break;
      if (attempt === 59) throw new Error('MongoDB replica set did not elect a primary');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await client.close();
    const uri = `mongodb://127.0.0.1:${port}/prototype_service_${process.pid}?directConnection=true`;
    connection = new mongoose.Mongoose();
    await connection.connect(uri, { serverSelectionTimeoutMS: 15000 });
    models = createModels(connection);
    await Promise.all([
      models.PrototypeJob.syncIndexes(),
      models.PrototypeTurn.syncIndexes(),
      models.PrototypeEvent.syncIndexes(),
      models.PrototypeOutbox.syncIndexes(),
    ]);
    const methods = createPrototypeMethods(connection);
    baseDeps = {
      startSession: () => connection.startSession(),
      ...methods,
      createPrototypeTurn: (input, session) =>
        models.PrototypeTurn.create([input], { session }).then(([turn]) => turn.toObject()),
      findPrototypeOutbox: (commandId, session) =>
        models.PrototypeOutbox.findOne({ commandId }, null, { session }).lean(),
      findLatestPrototypeTurn: (jobId, session) =>
        models.PrototypeTurn.findOne({ jobId }, null, { session }).sort({ ordinal: -1 }).lean(),
      getMessage: jest.fn().mockResolvedValue({
        messageId: 'message-1',
        conversationId: 'conversation-1',
        user: userId,
        tenantId: 'tenant-1',
        attachments: [],
      }),
      findFileById: jest.fn(),
      estimateCost: jest.fn().mockResolvedValue(null),
      createId: (kind) => `${kind}-${new Types.ObjectId()}`,
    };
  });

  afterAll(async () => {
    await connection?.disconnect();
    try {
      execFileSync('docker', ['stop', containerName], { stdio: 'ignore' });
    } catch (_error) {
      // Container may already be gone; it is --rm and uniquely named.
    }
  });

  beforeEach(async () => {
    if (!models) return;
    await Promise.all([
      models.PrototypeJob.deleteMany({}),
      models.PrototypeTurn.deleteMany({}),
      models.PrototypeEvent.deleteMany({}),
      models.PrototypeOutbox.deleteMany({}),
    ]);
  });

  const input = () => ({
    req: reqFor(),
    spec: 'Build a CRM',
    toolCallId: `tool-${new Types.ObjectId()}`,
    messageId: 'message-1',
    modelId: 'trusted/model',
  });

  it('commits job, turn, event, and outbox together on a real replica set', async () => {
    await new PrototypeService(baseDeps).acceptToolCall(input());

    const counts = await Promise.all([
      models.PrototypeJob.countDocuments(),
      models.PrototypeTurn.countDocuments(),
      models.PrototypeEvent.countDocuments(),
      models.PrototypeOutbox.countDocuments(),
    ]);
    if (process.env.PROTOTYPE_MONGO_TRANSACTION_TEST === '1') {
      console.info(
        `[PrototypeTransaction] commit counts [job,turn,event,outbox]=${counts.join(',')}`,
      );
    }
    expect(counts).toEqual([1, 1, 1, 1]);
  });

  it('rolls job, turn, event, and outbox back together on a real replica set', async () => {
    const service = new PrototypeService({
      ...baseDeps,
      enqueuePrototypeOutbox: async () => {
        throw new Error('injected outbox failure after job, turn, and event');
      },
    });

    await expect(service.acceptToolCall(input())).rejects.toThrow('injected outbox failure');
    const counts = await Promise.all([
      models.PrototypeJob.countDocuments(),
      models.PrototypeTurn.countDocuments(),
      models.PrototypeEvent.countDocuments(),
      models.PrototypeOutbox.countDocuments(),
    ]);
    if (process.env.PROTOTYPE_MONGO_TRANSACTION_TEST === '1') {
      console.info(
        `[PrototypeTransaction] rollback counts [job,turn,event,outbox]=${counts.join(',')}`,
      );
    }
    expect(counts).toEqual([0, 0, 0, 0]);
  });
});

describe('Prototype retry stage identity', () => {
  it('queues generation step zero after a failure at the build stage', async () => {
    const failed = { jobId: 'job-1', userId, tenantId: 'tenant-1', conversationId: 'conversation-1',
      status: 'failed', revision: 5, fenceToken: 1, activeStage: null, pipelineStep: 4,
      activeTurnId: 'turn-1', modelId: 'trusted/model', activity: [], versions: [] };
    const queued = { ...failed, status: 'queued', revision: 6, fenceToken: 2,
      activeStage: 'generation', pipelineStep: 0 };
    const { service, deps } = harness({ getOwnedPrototypeJob: jest.fn().mockResolvedValue(failed),
      findLatestPrototypeTurn: jest.fn().mockResolvedValue({ turnId: 'turn-1', attachmentManifest: [] }),
      retryFailedPrototypeJob: jest.fn().mockResolvedValue(queued) });
    await service.retry({ req: reqFor(), jobId: 'job-1', conversationId: 'conversation-1',
      idempotencyKey: 'retry-build', expectedRevision: 5 });
    expect(deps.enqueuePrototypeOutbox).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'execute_stage', stage: 'generation', pipelineStep: 0, expectedRevision: 6,
    }), expect.anything());
  });
});
