const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  prototypeActionRequestSchema,
  prototypeReplyRequestSchema,
  prototypeSubmitRequestSchema,
} = require('librechat-data-provider');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware');
const { createPrototypeService } = require('~/server/services/Prototypes');
const { prototypeModelMetrics } = require('~/server/services/Prototypes/PrototypeModelMetrics');
const { prototypeAvailability } = require('../services/Prototypes/PrototypeAvailability');
const { getContentDisposition } = require('~/server/utils/files');

function writePrototypeSseFrame(res, frame) {
  res.write(frame);
  res.flush?.();
}

function attachPrototypeSseCleanup(req, res, close) {
  req.once('aborted', close);
  res.once('close', close);
}

const ERROR_STATUS = {
  PROTOTYPE_JOB_NOT_FOUND: 404,
  PROTOTYPE_MODEL_BLOCKED: 403,
  PROTOTYPE_ACTIVE_JOB_EXISTS: 409,
  PROTOTYPE_INVALID_STATE: 409,
  PROTOTYPE_STALE_REVISION: 409,
  PROTOTYPE_ARTIFACT_NOT_READY: 409,
  PROTOTYPE_CANCELED: 409,
  PROTOTYPE_FAILED: 409,
  PROTOTYPE_INVALID_REPLY: 422,
  PROTOTYPE_INVALID_REQUEST: 422,
  PROTOTYPE_ATTACHMENT_INVALID: 422,
  PROTOTYPE_REQUIREMENTS_TOO_LARGE: 422,
  PROTOTYPE_CONTENT_BLOCKED: 422,
  PROTOTYPE_MODERATION_UNAVAILABLE: 503,
  PROTOTYPE_MODEL_UNSUPPORTED: 422,
  PROTOTYPE_STORAGE_UNAVAILABLE: 503,
  PROTOTYPE_QUEUE_UNAVAILABLE: 503,
  PROTOTYPE_SERVICE_UNAVAILABLE: 503,
  PROTOTYPE_SERVICE_TIMEOUT: 504,
};

const JOB_ID_PATTERN = /^job_[a-f\d]{24}$/i;
const PUBLIC_ERROR_MESSAGES = {
  PROTOTYPE_JOB_NOT_FOUND: 'Prototype job not found',
  PROTOTYPE_MODEL_BLOCKED: 'The selected model is unavailable for prototypes',
  PROTOTYPE_ACTIVE_JOB_EXISTS: 'A prototype job is already active for this conversation',
  PROTOTYPE_INVALID_STATE: 'This action is not available for the prototype job',
  PROTOTYPE_STALE_REVISION: 'Prototype job revision no longer matches',
  PROTOTYPE_ARTIFACT_NOT_READY: 'The prototype artifact is not ready',
  PROTOTYPE_CANCELED: 'The prototype job was canceled',
  PROTOTYPE_FAILED: 'The prototype job failed',
  PROTOTYPE_INVALID_REPLY: 'Prototype reply is invalid',
  PROTOTYPE_INVALID_REQUEST: 'Prototype request is invalid',
  PROTOTYPE_ATTACHMENT_INVALID: 'Upload an accessible, nonempty document as text',
  PROTOTYPE_REQUIREMENTS_TOO_LARGE:
    'Prototype requirements including documents exceed 50000 characters',
  PROTOTYPE_CONTENT_BLOCKED: 'The request violates content policy',
  PROTOTYPE_MODERATION_UNAVAILABLE: 'Content safety check is temporarily unavailable',
  PROTOTYPE_MODEL_UNSUPPORTED: 'The selected model is not supported for prototypes',
  PROTOTYPE_STORAGE_UNAVAILABLE: 'Prototype storage is unavailable',
  PROTOTYPE_QUEUE_UNAVAILABLE: 'Prototype queue is unavailable',
  PROTOTYPE_SERVICE_UNAVAILABLE: 'Prototype service is unavailable',
  PROTOTYPE_SERVICE_TIMEOUT: 'Prototype service timed out',
};

function invalidRequest(res) {
  return res.status(422).json({
    error: { code: 'PROTOTYPE_INVALID_REQUEST', message: 'Prototype request is invalid' },
  });
}

function validIdentifier(value, pattern) {
  return typeof value === 'string' && value.trim() === value && pattern.test(value);
}

function parseConversationBinding(req, res, source = 'header') {
  const value = source === 'query'
    ? req.query.conversationId
    : req.get('X-Prototype-Conversation-Id');
  if (!validIdentifier(value, /^\S+$/)) {
    invalidRequest(res);
    return null;
  }
  return value;
}

function sendDomainError(res, error) {
  const status = ERROR_STATUS[error?.code];
  if (status == null || status >= 500) {
    logger.warn('[Prototype] request.failed', {
      code: error?.code,
      errorClass: error?.constructor?.name,
      message: String(error?.message ?? 'unknown').slice(0, 500),
    });
  }
  if (status == null) {
    return res.status(503).json({
      error: {
        code: 'PROTOTYPE_SERVICE_UNAVAILABLE',
        message: 'Prototype service is unavailable',
      },
    });
  }
  return res.status(status).json({
    error: { code: error.code, message: PUBLIC_ERROR_MESSAGES[error.code] },
  });
}

function prototypeSseEventName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : 'message';
}

function handler(fn) {
  return async (req, res) => {
    try {
      return await fn(req, res);
    } catch (error) {
      return sendDomainError(res, error);
    }
  };
}

/** Poll active streams quickly, then back off while no committed events arrive. */
function startPrototypeSsePolling({ req, res, prototypeService, conversationId, cursor }) {
  let closed = false;
  let pollTimer;
  let delayMs = 1_000;
  const close = () => {
    closed = true;
    clearTimeout(pollTimer);
    clearInterval(keepalive);
  };
  const keepalive = setInterval(() => {
    if (!closed && !res.writableEnded && !res.destroyed) {
      writePrototypeSseFrame(res, ': keepalive\n\n');
    }
  }, 15_000);
  async function poll() {
    if (closed || res.writableEnded || res.destroyed) return close();
    try {
      const replay = await prototypeService.getConversationEvents({
        req,
        conversationId,
        after: cursor,
      });
      // A disconnect can happen while the database read is in flight.
      if (closed || res.writableEnded || res.destroyed) return close();
      for (const event of replay.events) {
        cursor = event.id;
        writePrototypeSseFrame(
          res,
          `id: ${event.id}\nevent: ${prototypeSseEventName(event.type)}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      }
      delayMs = replay.events.length ? 1_000 : Math.min(delayMs * 2, 5_000);
    } catch {
      if (!closed && !res.writableEnded && !res.destroyed) {
        writePrototypeSseFrame(
          res,
          `event: error\ndata: ${JSON.stringify({ code: 'PROTOTYPE_SERVICE_UNAVAILABLE' })}\n\n`,
        );
        res.end();
      }
      return close();
    }
    pollTimer = setTimeout(poll, delayMs);
  }
  attachPrototypeSseCleanup(req, res, close);
  if (req.aborted || res.writableEnded || res.destroyed) {
    close();
    return close;
  }
  pollTimer = setTimeout(poll, delayMs);
  return close;
}

function parseMutation(req, res, action) {
  if (!validIdentifier(req.params.jobId, JOB_ID_PATTERN)) {
    invalidRequest(res);
    return null;
  }
  const candidate = req.body ?? {};
  const allowedKeys = action === 'reply'
    ? new Set(['messageId', 'prototypeReplyToMessageId', 'selectedVariant'])
    : new Set();
  const schema = action === 'reply' ? prototypeReplyRequestSchema : prototypeActionRequestSchema;
  const parsed = schema.safeParse(candidate);
  const hasUnknownKeys = Object.keys(candidate).some((key) => !allowedKeys.has(key));
  const idempotencyKey = req.get('Idempotency-Key');
  const expectedRevision = Number.parseInt(req.get('X-Prototype-Revision') ?? '', 10);
  const conversationId = req.get('X-Prototype-Conversation-Id');
  if (
    !parsed.success ||
    hasUnknownKeys ||
    typeof idempotencyKey !== 'string' ||
    !idempotencyKey.trim() ||
    !validIdentifier(conversationId, /^\S+$/) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    invalidRequest(res);
    return null;
  }
  return {
    body: parsed.data,
    conversationId,
    idempotencyKey: idempotencyKey.trim(),
    expectedRevision,
  };
}

function createPrototypeRouters({
  prototypeService = createPrototypeService(),
  requireAuth = requireJwtAuth,
  loadConfig = configMiddleware,
  isAvailable = () => prototypeAvailability.isAvailable(),
} = {}) {
  const jobs = express.Router();
  const conversations = express.Router();

  jobs.use(requireAuth);
  conversations.use(requireAuth);
  jobs.use(loadConfig);
  conversations.use(loadConfig);
  jobs.get('/availability', (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ available: req.config?.prototypeAgent?.enabled === true && isAvailable() });
  });
  const requireAvailable = (req, res, next) => {
    // Existing results and cancellation remain reachable while generation is unavailable.
    if (req.method !== 'POST' || req.path.endsWith('/cancel')) return next();
    if (req.config?.prototypeAgent?.enabled !== true || !isAvailable()) return res.status(503).json({ error: {
      code: 'PROTOTYPE_SERVICE_UNAVAILABLE', message: 'Prototype service is unavailable',
    } });
    return next();
  };
  jobs.use(requireAvailable);
  conversations.use(requireAvailable);

  jobs.get(
    '/:jobId/metrics',
    handler(async (req, res) => {
      if (!validIdentifier(req.params.jobId, JOB_ID_PATTERN)) return invalidRequest(res);
      const conversationId = parseConversationBinding(req, res, 'query');
      if (!conversationId) return;
      const card = await prototypeService.getJob({ req, jobId: req.params.jobId, conversationId });
      res.set('Cache-Control', 'no-store');
      return res.status(200).json(await prototypeModelMetrics(card));
    }),
  );

  jobs.get(
    '/:jobId',
    handler(async (req, res) => {
      if (!validIdentifier(req.params.jobId, JOB_ID_PATTERN)) return invalidRequest(res);
      const conversationId = parseConversationBinding(req, res, 'query');
      if (!conversationId) return;
      return res.status(200).json(await prototypeService.getJob({
        req,
        jobId: req.params.jobId,
        conversationId,
      }));
    }),
  );

  jobs.post(
    '/:jobId/replies',
    handler(async (req, res) => {
      const input = parseMutation(req, res, 'reply');
      if (!input) return;
      return res.status(200).json(
        await prototypeService.acceptReply({
          req,
          jobId: req.params.jobId,
          conversationId: input.conversationId,
          messageId: input.body.messageId,
          prototypeReplyToMessageId: input.body.prototypeReplyToMessageId,
          selectedVariant: input.body.selectedVariant,
          idempotencyKey: input.idempotencyKey,
          expectedRevision: input.expectedRevision,
        }),
      );
    }),
  );

  for (const action of ['approve', 'cancel', 'retry', 'resume', 'finalize']) {
    jobs.post(
      `/:jobId/${action}`,
      handler(async (req, res) => {
        const input = parseMutation(req, res, action);
        if (!input) return;
        return res.status(200).json(
          await prototypeService[action]({
            req,
            jobId: req.params.jobId,
            conversationId: input.conversationId,
            idempotencyKey: input.idempotencyKey,
            expectedRevision: input.expectedRevision,
          }),
        );
      }),
    );
  }

  for (const kind of ['html', 'html-download', 'sources']) {
    jobs.get(
      `/:jobId/${kind}`,
      handler(async (req, res) => {
        if (!validIdentifier(req.params.jobId, JOB_ID_PATTERN)) return invalidRequest(res);
        const conversationId = parseConversationBinding(req, res, 'query');
        if (!conversationId) return;
        const version =
          req.query.version == null ? null : Number.parseInt(String(req.query.version), 10);
        if (version != null && (!Number.isSafeInteger(version) || version < 0)) {
          return invalidRequest(res);
        }
        const artifact = await prototypeService.requireArtifact({
          req,
          jobId: req.params.jobId,
          conversationId,
          kind,
          ...(version != null ? { version } : {}),
        });
        res.set({
          'Content-Type': artifact.contentType,
          'Content-Disposition': getContentDisposition(artifact.filename, kind === 'html' ? 'inline' : 'attachment'),
          'X-Content-Type-Options': 'nosniff',
          'X-Prototype-Digest': artifact.digest,
          ...(kind === 'html'
            ? {
                'Content-Security-Policy':
                  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'",
              }
            : {}),
        });
        return res.status(200).send(artifact.bytes);
      }),
    );
  }

  conversations.get(
    '/:conversationId/prototype',
    handler(async (req, res) => {
      if (!validIdentifier(req.params.conversationId, /^\S+$/)) return invalidRequest(res);
      return res.status(200).json(
        await prototypeService.getConversationJob({
          req,
          conversationId: req.params.conversationId,
        }),
      );
    }),
  );

  conversations.post(
    '/:conversationId/prototype',
    handler(async (req, res) => {
      if (!validIdentifier(req.params.conversationId, /^\S+$/)) return invalidRequest(res);
      const parsed = prototypeSubmitRequestSchema.safeParse(req.body ?? {});
      const idempotencyKey = req.get('Idempotency-Key');
      if (!parsed.success || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
        return invalidRequest(res);
      }
      return res.status(201).json(
        await prototypeService.submitTurn({
          req,
          conversationId: req.params.conversationId,
          ...parsed.data,
          idempotencyKey: idempotencyKey.trim(),
        }),
      );
    }),
  );

  conversations.get(
    '/:conversationId/prototype/events',
    handler(async (req, res) => {
      if (!validIdentifier(req.params.conversationId, /^\S+$/)) return invalidRequest(res);
      const rawCursor = req.get('Last-Event-ID') ?? req.query.cursor ?? '0';
      const after = Number.parseInt(String(rawCursor), 10);
      if (!Number.isSafeInteger(after) || after < 0) return invalidRequest(res);
      const result = await prototypeService.getConversationEvents({
        req,
        conversationId: req.params.conversationId,
        after,
      });
      if (!String(req.get('Accept') ?? '').includes('text/event-stream')) {
        return res.status(200).json(result);
      }
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      for (const event of result.events) {
        writePrototypeSseFrame(
          res,
          `id: ${event.id}\nevent: ${prototypeSseEventName(event.type)}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      }
      writePrototypeSseFrame(
        res,
        `event: cursor\ndata: ${JSON.stringify({ cursor: result.cursor })}\n\n`,
      );
      startPrototypeSsePolling({
        req, res, prototypeService, conversationId: req.params.conversationId,
        cursor: result.cursor,
      });
      return undefined;
    }),
  );

  return { jobs, conversations };
}

const prototypeRouters = createPrototypeRouters();

module.exports = {
  ...prototypeRouters,
  createPrototypeRouters,
  writePrototypeSseFrame,
  attachPrototypeSseCleanup,
  startPrototypeSsePolling,
};
