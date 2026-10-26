const crypto = require('crypto');

class PrototypeProxyError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!Array.isArray(body.messages) || body.messages.length > 256 || body.stream === false) return false;
  const forbidden = ['targetUrl', 'url', 'headers', 'authorization'];
  if (forbidden.some((key) => Object.hasOwn(body, key))) return false;
  const roles = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
  return body.messages.every(
    (message) =>
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      roles.has(message.role),
  );
}

function controlEvent(type, claims) {
  return {
    schemaVersion: 2,
    eventId: `event_${crypto.randomUUID()}`,
    commandId: claims.commandId,
    jobId: claims.jobId,
    turnId: claims.turnId,
    attemptId: claims.attemptId,
    executionId: claims.executionId,
    expectedRevision: claims.revision,
    stage: claims.stage,
    fenceToken: claims.fenceToken,
    leaseId: claims.leaseId,
    payload: { type, checkpoint: null },
    createdAt: new Date().toISOString(),
  };
}

class PrototypeModelProxy {
  constructor(deps) {
    this.deps = deps;
    this.maxRequestBytes = deps.maxRequestBytes ?? 16 * 1024;
  }

  async chatCompletions({ token, body, signal }) {
    let requestBytes;
    try {
      requestBytes = Buffer.byteLength(JSON.stringify(body));
    } catch {
      throw new PrototypeProxyError('PROTOTYPE_INVALID_REQUEST');
    }
    if (requestBytes > this.maxRequestBytes || !validateRequest(body)) {
      throw new PrototypeProxyError('PROTOTYPE_INVALID_REQUEST');
    }
    let claims;
    try {
      claims = await this.deps.verifyToken(token);
    } catch {
      throw new PrototypeProxyError('PROTOTYPE_WORKER_UNAUTHORIZED');
    }
    const values = await this.deps.getUserKeyValues({ userId: claims.userId, name: 'OpenRouter' });
    if (typeof values?.apiKey !== 'string' || values.apiKey.length === 0) {
      await this.deps.publishControlEvent(controlEvent('credentials_required', claims));
      throw new PrototypeProxyError('credentials_required');
    }
    let upstream;
    try {
      upstream = await this.deps.requestUpstream({
        url: `${this.deps.baseUrl.replace(/\/$/, '')}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${values.apiKey}`, 'Content-Type': 'application/json' },
        body: { ...body, model: claims.modelId },
        signal,
      });
    } catch {
      throw new PrototypeProxyError('PROTOTYPE_SERVICE_UNAVAILABLE', { retryable: true });
    }
    if (upstream.status >= 200 && upstream.status < 300) {
      if (upstream.usage && this.deps.publishUsage) {
        const { inputTokens, outputTokens, costUsd } = upstream.usage;
        if (
          Number.isInteger(inputTokens) && inputTokens >= 0 &&
          Number.isInteger(outputTokens) && outputTokens >= 0 &&
          typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0
        ) {
          await this.deps.publishUsage({
            jobId: claims.jobId,
            turnId: claims.turnId,
            commandId: claims.commandId,
            attemptId: claims.attemptId,
            executionId: claims.executionId,
            stage: claims.stage,
            fenceToken: claims.fenceToken,
            leaseId: claims.leaseId,
            expectedRevision: claims.revision,
            inputTokens,
            outputTokens,
            costUsd,
          });
        }
      }
      return upstream;
    }
    if (upstream.status === 401 || upstream.status === 402) {
      const type = upstream.status === 401 ? 'credentials_required' : 'funds_required';
      await this.deps.publishControlEvent(controlEvent(type, claims));
      throw new PrototypeProxyError(type);
    }
    if (upstream.status === 429) {
      throw new PrototypeProxyError('PROTOTYPE_RATE_LIMITED', { retryable: true });
    }
    throw new PrototypeProxyError('PROTOTYPE_SERVICE_UNAVAILABLE', {
      retryable: upstream.status >= 500,
    });
  }
}

module.exports = { PrototypeModelProxy, PrototypeProxyError };
