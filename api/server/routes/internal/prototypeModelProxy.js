const express = require('express');

const STATUS = {
  PROTOTYPE_WORKER_UNAUTHORIZED: 401,
  PROTOTYPE_INVALID_REQUEST: 422,
  credentials_required: 401,
  funds_required: 402,
  PROTOTYPE_RATE_LIMITED: 429,
  PROTOTYPE_SERVICE_UNAVAILABLE: 503,
  PROTOTYPE_MODEL_MISMATCH: 422,
  PROTOTYPE_AGENT_BUDGET_UNAVAILABLE: 503,
  PROTOTYPE_AGENT_BUDGET_EXCEEDED: 429,
  PROTOTYPE_AGENT_REQUEST_REPLAY: 409,
  PROTOTYPE_AGENT_REQUEST_CONFLICT: 409,
  PROTOTYPE_AGENT_AUTHORITY_REVOKED: 401,
  PROTOTYPE_MODEL_OUTCOME_UNKNOWN: 502,
};

function bearerToken(req) {
  const authorization = req.get('Authorization');
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return token || null;
}

function createPrototypeModelProxyRouter({ proxy }) {
  const router = express.Router();
  if (typeof proxy.models === 'function') router.get('/models', async (req, res) => {
    const token = bearerToken(req);
    if (!token) return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED', retryable: false } });
    try { res.setHeader('Cache-Control', 'no-store'); return res.json(await proxy.models({ token })); }
    catch { return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED', retryable: false } }); }
  });
  router.post('/chat/completions', async (req, res) => {
    let requestBytes;
    try {
      requestBytes = Buffer.byteLength(JSON.stringify(req.body));
    } catch {
      requestBytes = Infinity;
    }
    if (requestBytes > (proxy.maxRequestBytes ?? 16 * 1024)) {
      return res.status(413).json({
        error: { code: 'PROTOTYPE_INVALID_REQUEST', retryable: false },
      });
    }
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({
        error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED', retryable: false },
      });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', () => {
      if (!res.writableFinished) abort();
    });
    try {
      const upstream = await proxy.chatCompletions({
        token,
        body: req.body,
        signal: controller.signal,
        requestId: req.get('X-Prototype-Request-Id') ?? req.get('Idempotency-Key'),
      });
      const contentType = upstream.headers?.['content-type'];
      if (contentType) res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.status(upstream.status);
      upstream.body.on('error', () => { controller.abort(); res.destroy(); });
      res.flushHeaders();
      upstream.body.pipe(res);
    } catch (error) {
      if (res.headersSent || res.destroyed) return res.destroy();
      const code = STATUS[error?.code] ? error.code : 'PROTOTYPE_SERVICE_UNAVAILABLE';
      return res.status(STATUS[code]).json({
        error: { code, retryable: error?.retryable === true },
      });
    }
  });
  return router;
}

module.exports = { createPrototypeModelProxyRouter };
