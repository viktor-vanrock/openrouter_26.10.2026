const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
const { PrototypeProxyError } = require('./PrototypeModelProxy');

const LIMITS = Object.freeze({ maxCostUsd: 2, maxRequests: 8, activeTimeoutMs: 600_000 });
const fail = code => { throw new PrototypeProxyError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = new Set(['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream',
  'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'reasoning']);

/** Text/function-tools only. Routing, plugins, media and provider options never cross this boundary. */
function validateAgentRequest(body) {
  if (!object(body) || Object.keys(body).some(key => !fields.has(key)) || body.stream !== true ||
      typeof body.model !== 'string' || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) return false;
  if (!body.messages.every(message => object(message) &&
    Object.keys(message).every(key => ['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'reasoning_content'].includes(key)) &&
    (message.name == null || typeof message.name === 'string' && message.name.length <= 64) &&
    (message.tool_call_id == null || typeof message.tool_call_id === 'string' && message.tool_call_id.length <= 128) &&
    (message.reasoning_content == null || typeof message.reasoning_content === 'string') &&
    ['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) &&
    (message.content == null || typeof message.content === 'string' || Array.isArray(message.content) &&
      message.content.every(part => object(part) && part.type === 'text' && typeof part.text === 'string' &&
        Object.keys(part).every(key => ['type', 'text'].includes(key)))) &&
    (message.tool_calls == null || Array.isArray(message.tool_calls) && message.tool_calls.length <= 64 &&
      message.tool_calls.every(call => object(call) && call.type === 'function' && typeof call.id === 'string' &&
        call.id.length <= 128 && Object.keys(call).every(key => ['id', 'type', 'function'].includes(key)) &&
        object(call.function) && /^[a-zA-Z0-9_-]{1,64}$/.test(call.function.name) &&
        Object.keys(call.function).every(key => ['name', 'arguments'].includes(key)) && typeof call.function.arguments === 'string')))) return false;
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.length > 32 || !body.tools.every(tool =>
    object(tool) && tool.type === 'function' && Object.keys(tool).every(key => ['type', 'function'].includes(key)) &&
    object(tool.function) && /^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name) &&
    Object.keys(tool.function).every(key => ['name', 'description', 'parameters', 'strict'].includes(key)) &&
    object(tool.function.parameters)))) return false;
  if (body.tool_choice != null && !['auto', 'none', 'required'].includes(body.tool_choice) &&
      !(object(body.tool_choice) && body.tool_choice.type === 'function' &&
        body.tools?.some(tool => tool.function.name === body.tool_choice.function?.name))) return false;
  if (body.stream_options != null && (!object(body.stream_options) ||
      Object.keys(body.stream_options).some(key => key !== 'include_usage'))) return false;
  if (body.reasoning != null && (!object(body.reasoning) || body.reasoning.enabled !== false ||
      Object.keys(body.reasoning).some(key => key !== 'enabled'))) return false;
  return (body.temperature == null || Number.isFinite(body.temperature) && body.temperature >= 0 && body.temperature <= 2) &&
    (body.top_p == null || Number.isFinite(body.top_p) && body.top_p > 0 && body.top_p <= 1) &&
    (body.parallel_tool_calls == null || typeof body.parallel_tool_calls === 'boolean') &&
    (body.stop == null || typeof body.stop === 'string' && body.stop.length <= 256 ||
      Array.isArray(body.stop) && body.stop.length <= 4 && body.stop.every(s => typeof s === 'string' && s.length <= 256));
}

function normalizedUsage(usage) {
  if (!object(usage)) return null;
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens, cost: actualCostUsd } = usage;
  if (![promptTokens, completionTokens].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !Number.isFinite(actualCostUsd) || actualCostUsd < 0 || actualCostUsd > 1000) return null;
  return { promptTokens, completionTokens, actualCostUsd };
}

class PrototypeScopedModelProxy {
  constructor(deps) {
    for (const key of ['verifyToken', 'authorizeClaims', 'getUserKeyValues', 'requestUpstream', 'quoteRequest']) {
      if (typeof deps[key] !== 'function') throw new Error('PROTOTYPE_PROXY_CONFIG_INVALID');
    }
    if (!deps.budget?.reserve || !deps.budget?.settle) throw new Error('PROTOTYPE_PROXY_CONFIG_INVALID');
    const url = new URL(deps.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !['/v1', '/api/v1'].includes(url.pathname.replace(/\/$/, ''))) throw new Error('PROTOTYPE_PROXY_CONFIG_INVALID');
    this.deps = deps;
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.maxRequestBytes = 1024 * 1024;
    this.active = new Set();
  }

  async claims(token) {
    try {
      const claims = await this.deps.verifyToken(token);
      if (claims.stage !== 'generation' || !(await this.deps.authorizeClaims(claims))) throw new Error();
      return claims;
    } catch { fail('PROTOTYPE_WORKER_UNAUTHORIZED'); }
  }

  async models({ token }) {
    const claims = await this.claims(token);
    return { object: 'list', data: [{ id: claims.modelId, object: 'model', owned_by: 'chatrouter' }] };
  }

  close() { for (const controller of this.active) controller.abort(); }

  async chatCompletions({ token, body, requestId, signal }) {
    if (!validateAgentRequest(body) || Buffer.byteLength(JSON.stringify(body)) > this.maxRequestBytes ||
        !/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId ?? '')) fail('PROTOTYPE_INVALID_REQUEST');
    const claims = await this.claims(token);
    if (body.model !== claims.modelId) fail('PROTOTYPE_MODEL_MISMATCH');
    const outputTokens = body.max_tokens ?? body.max_completion_tokens ?? 8192;
    if (body.max_tokens != null && body.max_completion_tokens != null ||
        !Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > 16384) fail('PROTOTYPE_INVALID_REQUEST');
    const values = await this.deps.getUserKeyValues({ userId: claims.userId, name: 'OpenRouter' });
    if (!values?.apiKey) fail('credentials_required');
    const command = { ...claims, expectedRevision: claims.revision };
    const forwarded = { ...body, max_tokens: outputTokens, stream_options: { include_usage: true } };
    delete forwarded.max_completion_tokens;
    let upperCostUsd;
    try { upperCostUsd = await this.deps.quoteRequest({ body: forwarded, claims, apiKey: values.apiKey }); }
    catch { fail('PROTOTYPE_AGENT_BUDGET_UNAVAILABLE'); }
    try {
      await this.deps.budget.reserve({ command, requestId,
        requestDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(forwarded)).digest('hex')}`,
        upperCostUsd, limits: LIMITS });
    } catch (error) {
      fail(['PROTOTYPE_AGENT_REQUEST_REPLAY', 'PROTOTYPE_AGENT_REQUEST_CONFLICT',
        'PROTOTYPE_AGENT_AUTHORITY_REVOKED', 'PROTOTYPE_AGENT_BUDGET_EXCEEDED'].includes(error.message)
        ? error.message : 'PROTOTYPE_AGENT_BUDGET_UNAVAILABLE');
    }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.active.add(controller);
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try { if (!(await this.deps.authorizeClaims(claims))) controller.abort(); }
      catch { controller.abort(); }
      finally { checking = false; }
    }, this.deps.authorityPollMs ?? 1000);
    timer.unref();
    const deadline = setTimeout(() => controller.abort(), LIMITS.activeTimeoutMs);
    deadline.unref();
    const cleanup = () => { clearInterval(timer); clearTimeout(deadline); this.active.delete(controller); };
    const settle = usage => this.deps.budget.settle({ command, requestId,
      actualCostUsd: usage?.actualCostUsd ?? null, promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null });
    let upstream;
    try {
      if (combined.aborted || !(await this.deps.authorizeClaims(claims))) throw new Error();
      upstream = await this.deps.requestUpstream({ url: `${this.baseUrl}/chat/completions`, method: 'POST',
        headers: { Authorization: `Bearer ${values.apiKey}`, 'Content-Type': 'application/json' },
        body: forwarded, signal: combined });
      if (upstream.status !== 200 || !/^text\/event-stream\b/i.test(upstream.headers?.['content-type'] ?? '')) {
        upstream.body?.destroy();
        throw new PrototypeProxyError(upstream.status === 401 ? 'credentials_required' : upstream.status === 402
          ? 'funds_required' : upstream.status === 429 ? 'PROTOTYPE_RATE_LIMITED' : 'PROTOTYPE_SERVICE_UNAVAILABLE');
      }
    } catch (error) {
      cleanup();
      await settle(null);
      // Ambiguous POST has spent its authority. The caller must never auto-retry it.
      throw error instanceof PrototypeProxyError ? error : new PrototypeProxyError('PROTOTYPE_MODEL_OUTCOME_UNKNOWN');
    }
    const abort = () => upstream.body.destroy(new PrototypeProxyError('PROTOTYPE_AGENT_AUTHORITY_REVOKED'));
    combined.addEventListener('abort', abort, { once: true });
    if (combined.aborted) abort();
    const deps = this.deps;
    async function* stream() {
      let pending = '', bytes = 0, usage = null, done = false, complete = false;
      const decoder = new StringDecoder('utf8');
      try {
        for await (const chunk of upstream.body) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 2 * 1024 * 1024 || done) fail('PROTOTYPE_INVALID_STREAM');
          pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          let match;
          while ((match = /\r?\n\r?\n/.exec(pending))) {
            const frame = pending.slice(0, match.index);
            pending = pending.slice(match.index + match[0].length);
            if (Buffer.byteLength(frame) > 256 * 1024) fail('PROTOTYPE_INVALID_STREAM');
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (done && data) fail('PROTOTYPE_INVALID_STREAM');
            if (data === '[DONE]') done = true;
            else if (data) {
              let parsed;
              try { parsed = JSON.parse(data); } catch { fail('PROTOTYPE_INVALID_STREAM'); }
              if (!object(parsed) || parsed.error || parsed.model && parsed.model !== claims.modelId) fail('PROTOTYPE_INVALID_STREAM');
              if (parsed.usage) {
                const nextUsage = normalizedUsage(parsed.usage);
                if (usage && JSON.stringify(nextUsage) !== JSON.stringify(usage)) fail('PROTOTYPE_INVALID_STREAM');
                usage = nextUsage;
              }
            }
            // Tool call fragments and UTF-8 content retain their exact protocol representation.
            if (data && data !== '[DONE]') yield `${frame}\n\n`;
          }
          if (Buffer.byteLength(pending) > 256 * 1024) fail('PROTOTYPE_INVALID_STREAM');
        }
        if (!done || pending.trim() || decoder.end()) fail('PROTOTYPE_INVALID_STREAM');
        complete = true;
      } catch (error) {
        throw new PrototypeProxyError(error?.code === 'PROTOTYPE_AGENT_AUTHORITY_REVOKED'
          ? error.code : 'PROTOTYPE_MODEL_OUTCOME_UNKNOWN');
      } finally {
        combined.removeEventListener('abort', abort);
        controller.abort();
        cleanup();
        upstream.body.destroy();
        await settle(complete ? usage : null);
      }
      if (usage && deps.publishUsage) await deps.publishUsage({ ...command, requestId,
        inputTokens: usage.promptTokens, outputTokens: usage.completionTokens, costUsd: usage.actualCostUsd });
      yield 'data: [DONE]\n\n';
    }
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from(stream()) };
  }
}

module.exports = { PrototypeScopedModelProxy, validateAgentRequest, normalizedUsage };
