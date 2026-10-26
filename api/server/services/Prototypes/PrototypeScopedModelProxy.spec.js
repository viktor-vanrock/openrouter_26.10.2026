const http = require('node:http');
const { Readable } = require('node:stream');
const { PrototypeScopedModelProxy } = require('./PrototypeScopedModelProxy');
const { createPrototypeStreamingHttpAdapter } = require('./PrototypeStreamingHttpAdapter');
const { quoteAgentRequest } = require('./PrototypeModelProxyStartup');

const claims = { jobId: 'job1', turnId: 'turn1', commandId: 'cmd1', userId: 'user1', tenantId: 'tenant1',
  modelId: 'selected/model', attemptId: 'attempt1', executionId: 'exec1', fenceToken: 2,
  revision: 3, leaseId: 'lease1', stage: 'generation' };
const usage = { prompt_tokens: 20, completion_tokens: 8, cost: 0.003 };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const content = frame({ model: claims.modelId, choices: [{ delta: { tool_calls: [{ index: 0,
  id: 'call1', type: 'function', function: { name: 'read_source', arguments: '{"path":' } }] } }] }) +
  frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/app/App.tsx"}' } }] } }] }) +
  frame({ choices: [], usage }) + 'data: [DONE]\n\n';
const body = { model: claims.modelId, stream: true, messages: [{ role: 'user', content: 'Прочитай проект' }],
  tools: [{ type: 'function', function: { name: 'read_source', parameters: { type: 'object',
    properties: { path: { type: 'string' } }, required: ['path'] } } }], max_tokens: 4096 };
function harness(patch = {}) {
  const ids = new Set();
  const deps = { baseUrl: 'https://provider.example/v1', verifyToken: jest.fn(async () => claims),
    authorizeClaims: jest.fn(async () => true), getUserKeyValues: jest.fn(async () => ({ apiKey: 'private-provider-key' })),
    requestUpstream: jest.fn(async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' },
      body: Readable.from([content.slice(0, 33), content.slice(33, 51), content.slice(51)]) })),
    quoteRequest: jest.fn(async () => 0.2), budget: {
      reserve: jest.fn(async ({ requestId }) => {
        if (ids.has(requestId)) throw new Error('PROTOTYPE_AGENT_REQUEST_REPLAY'); ids.add(requestId);
      }), settle: jest.fn(async () => {}),
    }, authorityPollMs: 10, ...patch };
  return { deps, proxy: new PrototypeScopedModelProxy(deps) };
}
async function read(result) { let value = ''; for await (const chunk of result.body) value += chunk; return value; }
const invoke = (proxy, patch = {}) => proxy.chatCompletions({ token: 'scoped-token', body, requestId: 'request1', ...patch });

describe('scoped agent model adapter', () => {
  it('preserves fragmented tools/UTF8, settles stream usage and permits a subsequent tool-result request', async () => {
    const { proxy, deps } = harness();
    expect(await read(await invoke(proxy))).toBe(content);
    expect(deps.budget.settle).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'request1',
      actualCostUsd: 0.003, promptTokens: 20, completionTokens: 8 }));
    await read(await invoke(proxy, { requestId: 'request2', body: { ...body,
      messages: [...body.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call1',
        type: 'function', function: { name: 'read_source', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call1', content: 'source contents' }] } }));
    expect(deps.requestUpstream).toHaveBeenCalledTimes(2);
    await expect(invoke(proxy)).rejects.toMatchObject({ code: 'PROTOTYPE_AGENT_REQUEST_REPLAY', retryable: false });
    expect(deps.requestUpstream).toHaveBeenCalledTimes(2);
    expect(deps.requestUpstream.mock.calls[0][0].body.stream_options).toEqual({ include_usage: true });
  });
  it('returns only selected-model discovery without fetching upstream', async () => {
    const { proxy, deps } = harness();
    expect(await proxy.models({ token: 'token' })).toEqual({ object: 'list', data: [
      { id: claims.modelId, object: 'model', owned_by: 'chatrouter' }] });
    expect(deps.requestUpstream).not.toHaveBeenCalled();
  });
  it.each([{ model: 'another/model' }, { plugins: [{ id: 'web' }] }, { provider: { order: ['other'] } },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x' } }] }] },
    { max_tokens: 16385 }, { stream: false }, { reasoning: { enabled: true } }])('rejects override/media/unbounded request %j', async patch => {
    const { proxy, deps } = harness();
    await expect(invoke(proxy, { body: { ...body, ...patch } })).rejects.toBeDefined();
    expect(deps.requestUpstream).not.toHaveBeenCalled();
    expect(deps.budget.reserve).not.toHaveBeenCalled();
  });
  it('requires a stable request id; budget refusal and revoked token never reach the provider', async () => {
    const { proxy, deps } = harness();
    await expect(invoke(proxy, { requestId: undefined })).rejects.toMatchObject({ code: 'PROTOTYPE_INVALID_REQUEST' });
    deps.authorizeClaims.mockResolvedValue(false);
    await expect(invoke(proxy)).rejects.toMatchObject({ code: 'PROTOTYPE_WORKER_UNAUTHORIZED' });
    deps.authorizeClaims.mockResolvedValue(true);
    deps.budget.reserve.mockRejectedValue(new Error('PROTOTYPE_AGENT_BUDGET_EXCEEDED'));
    await expect(invoke(proxy)).rejects.toMatchObject({ code: 'PROTOTYPE_AGENT_BUDGET_EXCEEDED' });
    expect(deps.requestUpstream).not.toHaveBeenCalled();
  });
  it('retains unknown reservation after ambiguous POST and never advertises retry', async () => {
    const { proxy, deps } = harness({ requestUpstream: jest.fn(async () => { throw new Error('secret transport details'); }) });
    await expect(invoke(proxy)).rejects.toMatchObject({ code: 'PROTOTYPE_MODEL_OUTCOME_UNKNOWN', retryable: false });
    expect(deps.budget.settle).toHaveBeenCalledWith(expect.objectContaining({ actualCostUsd: null }));
    await expect(invoke(proxy)).rejects.toMatchObject({ code: 'PROTOTYPE_AGENT_REQUEST_REPLAY' });
    expect(deps.requestUpstream).toHaveBeenCalledTimes(1);
  });
  it.each([frame({ choices: [] }), frame({ choices: [], usage }), 'data: invalid-json\n\n'])('incomplete/malformed SSE keeps usage unknown', async wire => {
    const { proxy, deps } = harness({ requestUpstream: jest.fn(async () => ({ status: 200,
      headers: { 'content-type': 'text/event-stream' }, body: Readable.from([wire]) })) });
    await expect(read(await invoke(proxy))).rejects.toBeDefined();
    expect(deps.budget.settle).toHaveBeenCalledWith(expect.objectContaining({ actualCostUsd: null }));
  });
  it('complete stream without cost keeps reservation rather than inventing a zero', async () => {
    const { proxy, deps } = harness({ requestUpstream: jest.fn(async () => ({ status: 200,
      headers: { 'content-type': 'text/event-stream' }, body: Readable.from(['data: [DONE]\n\n']) })) });
    await read(await invoke(proxy));
    expect(deps.budget.settle).toHaveBeenCalledWith(expect.objectContaining({ actualCostUsd: null }));
  });
  it('revokes an active stalled stream on authority loss, then denies new requests', async () => {
    const upstream = new Readable({ read() {} });
    const { proxy, deps } = harness({ requestUpstream: jest.fn(async () => ({ status: 200,
      headers: { 'content-type': 'text/event-stream' }, body: upstream })) });
    const pending = read(await invoke(proxy));
    deps.authorizeClaims.mockResolvedValue(false);
    await expect(pending).rejects.toMatchObject({ code: 'PROTOTYPE_AGENT_AUTHORITY_REVOKED' });
    await expect(invoke(proxy, { requestId: 'next' })).rejects.toMatchObject({ code: 'PROTOTYPE_WORKER_UNAUTHORIZED' });
    expect(deps.requestUpstream).toHaveBeenCalledTimes(1);
    expect(deps.budget.settle).toHaveBeenCalledWith(expect.objectContaining({ actualCostUsd: null }));
  });
  it('actual HTTP streaming adapter sends tools and keeps secrets off downstream wire', async () => {
    let received;
    const server = http.createServer(async (req, res) => {
      let encoded = ''; for await (const chunk of req) encoded += chunk;
      received = { body: JSON.parse(encoded), authorization: req.headers.authorization, url: req.url };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const wire = Buffer.from(content.replace('call1', 'запрос1'));
      res.write(wire.subarray(0, 43)); res.write(wire.subarray(43, 46)); res.end(wire.subarray(46));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const transport = createPrototypeStreamingHttpAdapter();
      const { proxy } = harness({ requestUpstream: input => transport({ ...input,
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }) });
      const output = await read(await invoke(proxy));
      expect(output).toContain('запрос1');
      expect(output).not.toContain('private-provider-key');
      expect(received.authorization).toBe('Bearer private-provider-key');
      expect(received.body.tools).toEqual(body.tools);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  it('quotes text plus tool schemas from trusted prices; unknown bounds/prices fail closed', () => {
    const metadata = { id: body.model, context_length: 100000, top_provider: { max_completion_tokens: 16384 },
      pricing: { prompt: '0.000001', completion: '0.000002', request: '0.001' } };
    expect(quoteAgentRequest(body, metadata)).toBeGreaterThan(0.02);
    expect(() => quoteAgentRequest(body, { ...metadata, id: 'another/model' })).toThrow();
    expect(() => quoteAgentRequest(body, { ...metadata, pricing: { ...metadata.pricing, internal_reasoning: '0.1' } })).toThrow();
  });
});
