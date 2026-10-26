const { Readable } = require('stream');
const { PrototypeModelProxy } = require('./PrototypeModelProxy');

const CANARY = 'sk-canary-prototype-secret';
const claims = {
  jobId: 'job_1', userId: 'user_1', tenantId: 'tenant_1', modelId: 'fixed/model',
  turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
  executionId: 'execution_1', stage: 'generation', fenceToken: 2,
  revision: 4, leaseId: 'lease_1', scopes: ['models:invoke'],
};

function harness(overrides = {}) {
  const deps = {
    verifyToken: jest.fn(async () => claims),
    getUserKeyValues: jest.fn(async () => ({ apiKey: CANARY })),
    requestUpstream: jest.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Readable.from(['data: first\n\n', 'data: [DONE]\n\n']),
    })),
    publishControlEvent: jest.fn(),
    baseUrl: 'https://gateway.internal/v1',
    ...overrides,
  };
  return { proxy: new PrototypeModelProxy(deps), deps };
}

describe('PrototypeModelProxy', () => {
  it('forces the claimed model and constructs the only allowed upstream target', async () => {
    const { proxy, deps } = harness();
    const result = await proxy.chatCompletions({
      token: 'job-token',
      body: { model: 'caller/override', messages: [{ role: 'user', content: 'hello' }], stream: true },
      signal: new AbortController().signal,
    });

    expect(deps.getUserKeyValues).toHaveBeenCalledWith({ userId: 'user_1', name: 'OpenRouter' });
    expect(deps.requestUpstream).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://gateway.internal/v1/chat/completions',
      headers: { Authorization: `Bearer ${CANARY}`, 'Content-Type': 'application/json' },
      body: { model: 'fixed/model', messages: [{ role: 'user', content: 'hello' }], stream: true },
    }));
    const chunks = [];
    for await (const chunk of result.body) chunks.push(String(chunk));
    expect(chunks.join('')).toBe('data: first\n\ndata: [DONE]\n\n');
  });

  it.each([
    { targetUrl: 'https://attacker.invalid' },
    { headers: { Authorization: 'Bearer attacker' } },
    { messages: 'not-an-array' },
  ])('rejects an unsafe caller request shape', async (patch) => {
    const { proxy, deps } = harness();
    await expect(proxy.chatCompletions({
      token: 'job-token', body: { messages: [], ...patch }, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_REQUEST' });
    expect(deps.getUserKeyValues).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'credentials_required', false],
    [402, 'funds_required', false],
    [429, 'PROTOTYPE_RATE_LIMITED', true],
    [503, 'PROTOTYPE_SERVICE_UNAVAILABLE', true],
  ])('normalizes provider status %s without exposing its body', async (status, code, retryable) => {
    const { proxy, deps } = harness({
      requestUpstream: jest.fn(async () => ({ status, headers: {}, body: Readable.from([CANARY]) })),
    });
    await expect(proxy.chatCompletions({
      token: 'job-token', body: { messages: [] }, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code, retryable });
    if (status === 401 || status === 402) {
      expect(deps.publishControlEvent).toHaveBeenCalledWith(expect.objectContaining({
        schemaVersion: 2,
        commandId: 'command_1',
        turnId: 'turn_1',
        attemptId: 'attempt_1',
        stage: 'generation',
        fenceToken: 2,
        eventId: expect.any(String),
        leaseId: 'lease_1',
        expectedRevision: 4,
        payload: { type: code, checkpoint: null },
        createdAt: expect.any(String),
      }));
    }
    expect(JSON.stringify(deps.publishControlEvent.mock.calls)).not.toContain(CANARY);
  });

  it('emits normalized usage without response content', async () => {
    const publishUsage = jest.fn();
    const { proxy } = harness({
      publishUsage,
      requestUpstream: jest.fn(async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Readable.from(['{"choices":[{"message":{"content":"private answer"}}]}']),
        usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.03 },
      })),
    });
    await proxy.chatCompletions({
      token: 'job-token', body: { messages: [] }, signal: new AbortController().signal,
    });

    expect(publishUsage).toHaveBeenCalledWith({
      jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
      executionId: 'execution_1', stage: 'generation', fenceToken: 2,
      leaseId: 'lease_1', expectedRevision: 4,
      inputTokens: 12, outputTokens: 4, costUsd: 0.03,
    });
    expect(JSON.stringify(publishUsage.mock.calls)).not.toContain('private answer');
  });

  it('normalizes token verification and transport exceptions without exposing their details', async () => {
    const { proxy: invalidTokenProxy } = harness({
      verifyToken: jest.fn(async () => {
        throw new Error('Bearer secret at /private/path');
      }),
    });
    await expect(
      invalidTokenProxy.chatCompletions({
        token: 'job-token',
        body: { messages: [] },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_WORKER_UNAUTHORIZED', retryable: false });

    const { proxy: transportProxy } = harness({
      requestUpstream: jest.fn(async () => {
        throw new Error('connect failed at /private/path with secret');
      }),
    });
    await expect(
      transportProxy.chatCompletions({
        token: 'job-token',
        body: { messages: [] },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_SERVICE_UNAVAILABLE', retryable: true });
  });

  it('rejects requests whose serialized shape exceeds the configured limit', async () => {
    const { proxy, deps } = harness({ maxRequestBytes: 32 });

    await expect(
      proxy.chatCompletions({
        token: 'job-token',
        body: { messages: [{ role: 'user', content: 'x'.repeat(64) }] },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_REQUEST' });
    expect(deps.verifyToken).not.toHaveBeenCalled();
  });

  it('rejects explicitly non-streaming requests, unsafe message roles and oversized message arrays', async () => {
    const { proxy, deps } = harness();
    for (const body of [
      { messages: [], stream: false },
      { messages: [{ role: 'attacker', content: 'x' }], stream: true },
      { messages: Array.from({ length: 257 }, () => ({ role: 'user', content: 'x' })), stream: true },
    ]) {
      await expect(proxy.chatCompletions({
        token: 'job-token', body, signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_REQUEST' });
    }
    expect(deps.verifyToken).not.toHaveBeenCalled();
  });
});
