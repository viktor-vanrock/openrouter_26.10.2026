const crypto = require('node:crypto');
const { FileSources } = require('librechat-data-provider');
const { PrototypeServiceError } = require('./errors');
const { evaluateModel } = require('./PrototypeModelPolicy');
const { requirePrototypeEnabled } = require('./PrototypeAdmission');
const { isTextFlagged } = require('../TextModeration');

async function moderateRequirements(text) {
  let flagged;
  try {
    flagged = await isTextFlagged(text);
  } catch {
    throw new PrototypeServiceError(
      'PROTOTYPE_MODERATION_UNAVAILABLE',
      'Content safety check is unavailable',
    );
  }
  if (flagged)
    throw new PrototypeServiceError('PROTOTYPE_CONTENT_BLOCKED', 'Request violates content policy');
}

function identityFrom(req, { requireConversation = true } = {}) {
  const userId = req?.user?.id ?? req?.user?._id;
  const tenantId = req?.user?.tenantId ?? req?.user?.orgId ?? '__default__';
  const conversationId = req?.body?.conversationId;
  if (!userId || !tenantId || (requireConversation && !conversationId)) {
    throw new PrototypeServiceError(
      'PROTOTYPE_INVALID_REQUEST',
      'Prototype request context is incomplete',
    );
  }
  return { userId, tenantId, conversationId };
}

function actionsFor(job) {
  const active = !['completed', 'failed', 'canceled'].includes(job.status);
  return {
    approve: job.status === 'waiting_for_input' && job.waitingReason === 'plan_approval',
    cancel: active,
    retry:
      job.status === 'failed' ||
      job.status === 'waiting_for_credentials' ||
      job.status === 'waiting_for_funds',
    finalize: job.status === 'review' && job.selectedVariant != null &&
      job.versions?.at(-1)?.selectedVariant === job.selectedVariant,
    reply:
      job.status === 'review' ||
      (job.status === 'waiting_for_input' && ['clarification', 'plan_approval'].includes(job.waitingReason)),
  };
}

function cardFor(job, { cursor = job.eventSequence ?? 0 } = {}) {
  const actions = actionsFor(job);
  return {
    type: 'prototype',
    jobId: job.jobId,
    conversationId: job.conversationId,
    turnId: job.activeTurnId ?? null,
    revision: job.revision,
    cursor,
    status: job.status,
    phase: job.phase ?? null,
    waitingReason: job.waitingReason ?? null,
    promptMessageId: job.latestPromptMessageId ?? null,
    modelId: job.modelId,
    selectedVariant: job.selectedVariant ?? null,
    modelWarning:
      job.modelRecommendation === 'not_recommended'
        ? 'The selected model is not recommended for prototype generation.'
        : null,
    prototypeName: null,
    previewAvailable: job.previewArtifactId != null,
    sourcesAvailable: job.sourcesArtifactId != null,
    failure: job.failure ?? null,
    activity: job.activity ?? [],
    versions: job.versions ?? [],
    actions,
    canCancel: actions.cancel,
    canReply: actions.reply,
    estimatedCost: job.estimatedCost ?? null,
    actualCostUsd: job.actualCostUsd ?? 0,
  };
}

function fileIdsFrom(message) {
  const ids = [];
  const files = message?.files ?? [];
  const attachments = message?.attachments ?? [];
  if (!Array.isArray(files) || !Array.isArray(attachments)) {
    throw new PrototypeServiceError('PROTOTYPE_ATTACHMENT_INVALID', 'Invalid document references');
  }
  for (const entry of [...files, ...attachments]) {
    const id = typeof entry === 'string' ? entry : (entry?.file_id ?? entry?.fileId);
    if (typeof id !== 'string' || !id.trim()) {
      throw new PrototypeServiceError('PROTOTYPE_ATTACHMENT_INVALID', 'Invalid document reference');
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function executionBudget(estimate) {
  const configured = Number(process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD ?? 10);
  const ceiling = Number.isFinite(configured) && configured > 0 && configured <= 1000 ? configured : 10;
  return {
    currency: 'USD',
    maxCostUsd: ceiling,
    maxRequests: 30,
    maxInputTokens: 200000,
    maxOutputTokens: 50000,
  };
}

function deadlineAt(now = Date.now()) {
  return new Date(now + 15 * 60 * 1000);
}

function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PrototypeServiceError('PROTOTYPE_INVALID_REQUEST', 'Idempotency key is required');
  }
  return value.trim();
}

function stableId(kind, key) {
  const digest = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
  return `${kind}_${digest}`;
}

function jobScopedId(kind, jobId, key) {
  return stableId(kind, `${jobId}:${key}`);
}

function sameId(left, right) {
  return String(left) === String(right);
}

function isSameOrigin(job, identity, messageId, modelId) {
  return (
    sameId(job.userId, identity.userId) &&
    job.tenantId === identity.tenantId &&
    job.conversationId === identity.conversationId &&
    job.originMessageId === messageId &&
    job.modelId === modelId
  );
}

function ownedFileFilter(identity, messageId) {
  return {
    user: identity.userId,
    tenantId: identity.tenantId,
    conversationId: identity.conversationId,
    messageId,
  };
}

class PrototypeService {
  constructor(deps) {
    this.deps = deps;
  }

  async requirementsFromFiles({ identity, text, fileIds = [] }) {
    if (
      !Array.isArray(fileIds) ||
      fileIds.length > 10 ||
      fileIds.some(
        (id) => typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 128,
      )
    ) {
      throw new PrototypeServiceError(
        'PROTOTYPE_ATTACHMENT_INVALID',
        'Invalid document references',
      );
    }
    let requirements = text;
    const files = [];
    for (const fileId of new Set(fileIds)) {
      // Uploads in a new chat have no conversation/message binding yet. Owner and
      // tenant are always required; an existing conversation binding is enforced.
      const file = await this.deps.findFileById(fileId, {
        user: String(identity.userId),
        ...(identity.tenantId === '__default__'
          ? {
              $or: [
                { tenantId: '__default__' },
                { tenantId: null },
                { tenantId: { $exists: false } },
              ],
            }
          : { tenantId: identity.tenantId }),
      });
      const now = Date.now();
      if (
        !file ||
        !sameId(file.user, identity.userId) ||
        (file.tenantId ?? '__default__') !== identity.tenantId ||
        (file.conversationId && file.conversationId !== identity.conversationId) ||
        file.source !== FileSources.text ||
        typeof file.text !== 'string' ||
        !file.text.trim() ||
        ['pending', 'failed'].includes(file.status) ||
        (file.expiredAt && new Date(file.expiredAt).getTime() <= now) ||
        (file.expiresAt && new Date(file.expiresAt).getTime() + 3600000 <= now)
      ) {
        throw new PrototypeServiceError(
          'PROTOTYPE_ATTACHMENT_INVALID',
          'Document text is unavailable',
        );
      }
      const filename = String(file.filename ?? 'Document')
        .replace(/[\r\n]/g, ' ')
        .slice(0, 255);
      const heading = `\n\nПриложенный документ: ${filename}\n`;
      if (requirements.length + heading.length + file.text.length > 50000) {
        throw new PrototypeServiceError(
          'PROTOTYPE_REQUIREMENTS_TOO_LARGE',
          'Document requirements exceed the limit',
        );
      }
      requirements += heading + file.text;
      // Chat metadata is derived from the authorized record, never from the client.
      files.push({
        file_id: file.file_id,
        filename,
        type: file.type?.startsWith('image/') ? 'text/plain' : file.type,
        source: file.source,
        bytes: file.bytes,
      });
    }
    await moderateRequirements(requirements);
    return { text: requirements, files };
  }

  async submitTurn({
    req,
    conversationId,
    messageId,
    parentMessageId,
    text,
    fileIds,
    modelId,
    endpoint,
    title,
    revision,
    idempotencyKey,
  }) {
    requirePrototypeEnabled(req, this.deps.isAvailable);
    const key = requireIdempotencyKey(idempotencyKey);
    const identity = { ...identityFrom(req, { requireConversation: false }), conversationId };
    const trimmedText = typeof text === 'string' ? text.trim() : '';
    if (!trimmedText || trimmedText.length > 50000 || !messageId || !parentMessageId || !modelId) {
      throw new PrototypeServiceError('PROTOTYPE_INVALID_REQUEST', 'Prototype request is invalid');
    }
    const policy = req?.config?.prototypeAgent?.modelPolicy;
    if (!policy?.version) {
      throw new PrototypeServiceError(
        'PROTOTYPE_SERVICE_UNAVAILABLE',
        'Prototype model policy is unavailable',
      );
    }
    const modelEvaluation = evaluateModel({
      modelId,
      providerCapabilities: req?.prototypeProviderCapabilities ?? { toolCalling: true },
      policy,
    });
    if (!modelEvaluation.allowed) {
      throw new PrototypeServiceError(
        modelEvaluation.code,
        modelEvaluation.code === 'PROTOTYPE_MODEL_BLOCKED'
          ? 'The selected model is blocked for prototypes'
          : 'The selected model does not support prototype tools',
      );
    }

    const session = await this.deps.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        let conversation = await this.deps.getConversation(
          String(identity.userId),
          conversationId,
          identity.tenantId,
          session,
        );
        if (!conversation) {
          conversation = await this.deps.createPrototypeConversation(
            {
              conversationId,
              user: String(identity.userId),
              tenantId: identity.tenantId,
              title: title ?? trimmedText.slice(0, 80),
              model: modelId,
              ...(endpoint ? { endpoint } : {}),
            },
            session,
          );
        }
        const existingJob = await this.deps.findOwnedPrototypeJobByConversation(
          {
            conversationId,
            userId: identity.userId,
            tenantId: identity.tenantId,
          },
          session,
        );
        if (existingJob?.accessRevokedAt != null) {
          throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
        }
        const jobId = existingJob?.jobId ?? this.deps.createId('job');
        const commandId = jobScopedId('submit', jobId, key);
        const duplicate = await this.deps.findPrototypeOutbox(commandId, session);
        if (duplicate) {
          const duplicateJob = existingJob ?? (await this.deps.getOwnedPrototypeJob({
            jobId: duplicate.jobId,
            userId: identity.userId,
            tenantId: identity.tenantId,
          }));
          result = duplicateJob;
          return;
        }
        if (existingJob && existingJob.revision !== revision) {
          throw new PrototypeServiceError(
            'PROTOTYPE_STALE_REVISION',
            'Prototype job revision no longer matches',
          );
        }
        const requirements = await this.requirementsFromFiles({
          identity,
          text: trimmedText,
          fileIds,
        });
        await this.deps.createPrototypeUserMessage(
          {
            messageId,
            conversationId,
            parentMessageId,
            user: String(identity.userId),
            tenantId: identity.tenantId,
            sender: 'User',
            text: trimmedText,
            ...(requirements.files.length ? { files: requirements.files } : {}),
            isCreatedByUser: true,
            metadata: {
              prototypeAgent: true,
              prototypeReplyToMessageId: null,
              idempotencyKey: key,
            },
          },
          session,
        );

        const turnId = jobScopedId('turn', jobId, key);
        const attemptId = jobScopedId('attempt', jobId, key);
        const executionId = jobScopedId('execution', jobId, key);
        const turn = {
          turnId,
          jobId,
          ordinal: existingJob ? existingJob.revision + 1 : 0,
          kind: existingJob ? 'user_reply' : 'initial',
          sourceMessageId: messageId,
          replyToPrototypeMessageId: null,
          text: requirements.text,
          modelId,
          attachmentManifest: [],
          commandId,
          executionAttempts: 0,
          status: 'pending',
          costUsd: 0,
        };

        if (!existingJob) {
          const created = await this.deps.createPrototypeJob(
            {
              jobId,
              ...identity,
              originMessageId: messageId,
              originToolCallId: `chat:${key}`,
              status: 'queued',
              waitingReason: null,
              phase: null,
              modelId,
              modelPolicyVersion: modelEvaluation.policyVersion,
              modelRecommendation: modelEvaluation.recommendation,
              revision: 0,
              eventSequence: 0,
              fenceToken: 1,
              activeCommandId: commandId,
              activeTurnId: turnId,
              activeAttemptId: attemptId,
              activeExecutionId: executionId,
              activeLeaseId: null,
              activeStage: 'generation',
              pipelineStep: 0,
              checkpointRevision: null,
              checkpointDigest: null,
              latestPromptMessageId: null,
              previewArtifactId: null,
              previewDigest: null,
              sourcesArtifactId: null,
              sourcesDigest: null,
              qaArtifactId: null,
              templateDigest: null,
              toolchainDigest: null,
              estimatedCost: null,
              actualCostUsd: 0,
              failure: null,
              activity: [],
              versions: [],
              accessRevokedAt: null,
              cleanupStatus: 'none',
              cleanupAttempts: 0,
              cleanupNextAttemptAt: null,
              completedAt: null,
            },
            session,
          );
          result = created.job;
          await this.deps.createPrototypeTurn(turn, session);
        } else if (existingJob.status === 'completed') {
          // Older UI selected and completed a design in one explicit generated reply.
          // Recover that accepted choice once, without rewriting historical artifacts.
          let historicalVariant;
          const acceptedVersion = existingJob.versions?.at(-1);
          if (!existingJob.selectedVariant && acceptedVersion && this.deps.findPrototypeAcceptedTurn) {
            const acceptedTurn = await this.deps.findPrototypeAcceptedTurn({
              jobId, turnId: acceptedVersion.turnId,
            }, session);
            historicalVariant = /^Выбираю вариант ([AB])\. Финализируй прототип\.$/.exec(
              acceptedTurn?.text?.trim() ?? '',
            )?.[1];
          }
          result = (
            await this.deps.claimPrototypeTurn(
              {
                jobId,
                expectedRevision: existingJob.revision,
                turn,
                executionId,
                currentExecutionId: existingJob.activeExecutionId,
                attemptId,
                modelId,
                ...(historicalVariant ? { selectedVariant: historicalVariant } : {}),
              },
              session,
            )
          ).job;
        } else {
          throw new PrototypeServiceError(
            'PROTOTYPE_INVALID_STATE',
            `Prototype job cannot start a new turn while ${existingJob.status}`,
          );
        }

        if (typeof this.deps.allocatePrototypeEventSequence === 'function') {
          result = await this.deps.allocatePrototypeEventSequence(jobId, session);
        }
        const cursor = result.eventSequence ?? result.revision + 1;
        await this.deps.appendPrototypeEvent(
          {
            jobId,
            eventId: cursor,
            sourceEventId: `transition:${commandId}`,
            revision: result.revision,
            type: 'job_state',
            publicPayload: cardFor(result, { cursor }),
          },
          session,
        );
        await this.deps.enqueuePrototypeOutbox(
          {
            schemaVersion: 2,
            commandId,
            kind: 'execute_stage',
            jobId,
            turnId,
            tenantId: identity.tenantId,
            userId: String(identity.userId),
            modelId,
            expectedRevision: result.revision,
            executionId,
            attemptId,
            stage: 'generation',
            pipelineStep: 0,
            fenceToken: result.fenceToken,
            checkpointRevision: existingJob?.checkpointRevision ?? null,
            checkpointDigest: existingJob?.checkpointDigest ?? null,
            sourceDigest: existingJob?.sourcesDigest ?? null,
            budget: executionBudget(existingJob?.estimatedCost),
            deadlineAt: deadlineAt(),
            attachmentManifest: [],
            status: 'pending',
            publishAttempts: 0,
            publishedAt: null,
            lastAttemptAt: null,
          },
          session,
        );
      });
    } catch (error) {
      const conversationCollision =
        error?.code === 11000 &&
        error?.keyPattern?.tenantId === 1 &&
        error?.keyPattern?.conversationId === 1;
      if (!conversationCollision) throw error;
      const winner = await this.deps.findOwnedPrototypeJobByConversation({
        conversationId,
        userId: identity.userId,
        tenantId: identity.tenantId,
      });
      if (winner?.originToolCallId !== `chat:${key}` || winner.accessRevokedAt != null) {
        throw new PrototypeServiceError(
          'PROTOTYPE_ACTIVE_JOB_EXISTS',
          'A prototype job already exists for this conversation',
        );
      }
      result = winner;
    } finally {
      await session.endSession();
    }
    return cardFor(result, { cursor: result.eventSequence ?? result.revision + 1 });
  }

  async acceptToolCall({ req, spec, toolCallId, messageId, modelId }) {
    requirePrototypeEnabled(req, this.deps.isAvailable);
    const trimmedSpec = typeof spec === 'string' ? spec.trim() : '';
    if (!trimmedSpec || trimmedSpec.length > 50000) {
      throw new PrototypeServiceError(
        'PROTOTYPE_INVALID_REQUEST',
        'Prototype specification must contain between 1 and 50000 characters',
      );
    }

    if (!toolCallId || !messageId || !modelId) {
      throw new PrototypeServiceError(
        'PROTOTYPE_INVALID_REQUEST',
        'Prototype request identifiers are missing',
      );
    }
    const identity = identityFrom(req);
    const policy = req?.config?.prototypeAgent?.modelPolicy;
    if (!policy?.version) {
      throw new PrototypeServiceError(
        'PROTOTYPE_SERVICE_UNAVAILABLE',
        'Prototype model policy is unavailable',
      );
    }
    const modelEvaluation = evaluateModel({
      modelId,
      providerCapabilities: req?.prototypeProviderCapabilities ?? { toolCalling: true },
      policy,
    });
    if (!modelEvaluation.allowed) {
      throw new PrototypeServiceError(
        modelEvaluation.code,
        modelEvaluation.code === 'PROTOTYPE_MODEL_BLOCKED'
          ? 'The selected model is blocked for prototypes'
          : 'The selected model does not support prototype tools',
      );
    }

    const session = await this.deps.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const jobId = this.deps.createId('job');
        const turnId = this.deps.createId('turn');
        const commandId = this.deps.createId('command');
        const attemptId = this.deps.createId('attempt');
        const executionId = this.deps.createId('execution');
        const message = await this.deps.getMessage(
          { user: String(identity.userId), messageId },
          session,
        );
        if (
          !message ||
          message.conversationId !== identity.conversationId ||
          message.tenantId !== identity.tenantId
        ) {
          throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
        }
        const manifest = [];
        const moderationText = [message.text ?? '', trimmedSpec];
        for (const fileId of fileIdsFrom(message)) {
          const file = await this.deps.findFileById(fileId, ownedFileFilter(identity, messageId));
          if (!file) {
            throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
          }
          if (file.source === FileSources.text && typeof file.text === 'string') {
            moderationText.push(file.text);
          }
          manifest.push({
            fileId: file.file_id,
            filename: file.filename,
            mimeType: file.type,
            size: file.bytes,
          });
        }
        await moderateRequirements(moderationText.join('\n\n'));
        let estimate = null;
        try {
          estimate = await this.deps.estimateCost({
            modelId,
            spec: trimmedSpec,
            attachmentCount: manifest.length,
            req,
          });
        } catch {
          // Balance and history are advisory. Durable job creation must not depend on either lookup.
        }
        const created = await this.deps.createPrototypeJob(
          {
            jobId,
            ...identity,
            originMessageId: messageId,
            originToolCallId: toolCallId,
            status: 'queued',
            waitingReason: null,
            phase: null,
            modelId,
            modelPolicyVersion: modelEvaluation.policyVersion,
            modelRecommendation: modelEvaluation.recommendation,
            revision: 0,
            eventSequence: 0,
            fenceToken: 1,
            activeCommandId: commandId,
            activeTurnId: turnId,
            activeAttemptId: attemptId,
            activeExecutionId: executionId,
            activeLeaseId: null,
            activeStage: 'generation',
            pipelineStep: 0,
            checkpointRevision: null,
            checkpointDigest: null,
            latestPromptMessageId: null,
            previewArtifactId: null,
            previewDigest: null,
            sourcesArtifactId: null,
            sourcesDigest: null,
            qaArtifactId: null,
            templateDigest: null,
            toolchainDigest: null,
            estimatedCost: estimate,
            actualCostUsd: 0,
            failure: null,
            activity: [],
            versions: [],
            accessRevokedAt: null,
            cleanupStatus: 'none',
            cleanupAttempts: 0,
            cleanupNextAttemptAt: null,
            completedAt: null,
          },
          session,
        );
        if (!created.created) {
          if (!isSameOrigin(created.job, identity, messageId, modelId)) {
            throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
          }
          result = created.job;
          return;
        }
        await this.deps.createPrototypeTurn(
          {
            turnId,
            jobId,
            ordinal: 0,
            kind: 'initial',
            sourceMessageId: messageId,
            replyToPrototypeMessageId: null,
            text: trimmedSpec,
            modelId,
            attachmentManifest: manifest,
            commandId,
            executionAttempts: 0,
            status: 'pending',
            costUsd: 0,
          },
          session,
        );
        const job = created.job;
        await this.deps.appendPrototypeEvent(
          {
            jobId,
            eventId: 0,
            sourceEventId: `transition:${commandId}`,
            revision: 0,
            type: 'job_state',
            publicPayload: cardFor(job, { cursor: 0 }),
          },
          session,
        );
        await this.deps.enqueuePrototypeOutbox(
          {
            schemaVersion: 2,
            commandId,
            kind: 'execute_stage',
            jobId,
            turnId,
            tenantId: identity.tenantId,
            userId: String(identity.userId),
            modelId,
            expectedRevision: 0,
            executionId,
            attemptId,
            stage: 'generation',
            pipelineStep: 0,
            fenceToken: 1,
            checkpointRevision: null,
            checkpointDigest: null,
            sourceDigest: null,
            budget: executionBudget(estimate),
            deadlineAt: deadlineAt(),
            attachmentManifest: manifest,
            status: 'pending',
            publishAttempts: 0,
            publishedAt: null,
            lastAttemptAt: null,
          },
          session,
        );
        result = job;
      });
    } catch (error) {
      const activeJobCollision =
        error?.code === 11000 &&
        error?.keyPattern?.tenantId === 1 &&
        error?.keyPattern?.conversationId === 1 &&
        Object.keys(error.keyPattern).length === 2;
      if (activeJobCollision) {
        throw new PrototypeServiceError(
          'PROTOTYPE_ACTIVE_JOB_EXISTS',
          'A prototype job already exists for this conversation; start a new chat for an independent prototype',
        );
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return { jobId: result.jobId, status: result.status, modelId: result.modelId };
  }

  async ownedJob(req, jobId, conversationId) {
    const identity = identityFrom(req, { requireConversation: false });
    const boundConversationId = conversationId ?? identity.conversationId;
    const job = await this.deps.getOwnedPrototypeJob({
      jobId,
      userId: identity.userId,
      tenantId: identity.tenantId,
    });
    if (
      !job ||
      job.accessRevokedAt != null ||
      !boundConversationId ||
      job.conversationId !== boundConversationId
    ) {
      throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
    }
    return { identity, job };
  }

  async getJob({ req, jobId, conversationId }) {
    const { job } = await this.ownedJob(req, jobId, conversationId);
    return cardFor(job);
  }

  async getConversationJob({ req, conversationId }) {
    const identity = identityFrom(req, { requireConversation: false });
    const job = await this.deps.findOwnedPrototypeJobByConversation({
      conversationId,
      userId: identity.userId,
      tenantId: identity.tenantId,
    });
    if (!job || job.accessRevokedAt != null) {
      throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
    }
    return cardFor(job);
  }

  async getConversationEvents({ req, conversationId, after = 0, limit = 100 }) {
    const identity = identityFrom(req, { requireConversation: false });
    const job = await this.deps.findOwnedPrototypeJobByConversation({
      conversationId,
      userId: identity.userId,
      tenantId: identity.tenantId,
    });
    if (!job || job.accessRevokedAt != null) {
      throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
    }
    const events = await this.deps.listPrototypeEvents(job.jobId, after, limit);
    return {
      events: events.map((event) => ({
        id: event.eventId,
        revision: event.revision,
        type: event.type,
        data: event.publicPayload,
      })),
      cursor: events.at(-1)?.eventId ?? after,
      snapshotCursor: job.eventSequence ?? 0,
    };
  }

  async requireArtifact({ req, jobId, conversationId, kind, version }) {
    const { job } = await this.ownedJob(req, jobId, conversationId);
    const html = kind === 'html' || kind === 'html-download';
    const selectedVersion = version == null
      ? null
      : (job.versions ?? []).find((entry) => entry.revision === version);
    const artifactId = selectedVersion ? null : (html ? job.previewArtifactId : job.sourcesArtifactId);
    const digest = selectedVersion
      ? (html ? selectedVersion.htmlDigest : selectedVersion.sourcesDigest)
      : (html ? job.previewDigest : job.sourcesDigest);
    if ((!artifactId && !selectedVersion) || !digest) {
      throw new PrototypeServiceError(
        'PROTOTYPE_ARTIFACT_NOT_READY',
        'Prototype artifact is not ready',
      );
    }
    try {
      return await this.deps.readPrototypeArtifact({
        req,
        job,
        artifactId,
        digest,
        kind: html ? 'html' : 'sources_zip',
      });
    } catch (error) {
      if (error instanceof PrototypeServiceError) throw error;
      throw new PrototypeServiceError(
        'PROTOTYPE_STORAGE_UNAVAILABLE',
        'Prototype storage is temporarily unavailable',
      );
    }
  }

  async acceptReply({
    req,
    jobId,
    conversationId,
    messageId,
    prototypeReplyToMessageId,
    selectedVariant,
    idempotencyKey,
    expectedRevision,
  }) {
    requirePrototypeEnabled(req, this.deps.isAvailable);
    const key = requireIdempotencyKey(idempotencyKey);
    if (!messageId || !prototypeReplyToMessageId) {
      throw new PrototypeServiceError(
        'PROTOTYPE_INVALID_REPLY',
        'An explicit prototype reply target is required',
      );
    }
    const session = await this.deps.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const { identity, job } = await this.ownedJob(req, jobId, conversationId);
        const commandId = jobScopedId('reply', jobId, key);
        const existingCommand = await this.deps.findPrototypeOutbox(commandId, session);
        if (existingCommand?.jobId === jobId) {
          result = job;
          return;
        }
        if (job.revision !== expectedRevision) {
          throw new PrototypeServiceError(
            'PROTOTYPE_STALE_REVISION',
            'Prototype job revision no longer matches',
          );
        }
        if (selectedVariant !== undefined &&
            (!['A', 'B'].includes(selectedVariant) || job.selectedVariant != null ||
              job.status !== 'review' || !job.previewArtifactId)) {
          throw new PrototypeServiceError('PROTOTYPE_INVALID_STATE', 'Design can be selected once during review');
        }
        const message = await this.deps.getMessage(
          {
            user: String(identity.userId),
            tenantId: identity.tenantId,
            conversationId: job.conversationId,
            messageId,
          },
          session,
        );
        if (
          !message ||
          message.conversationId !== job.conversationId ||
          message.tenantId !== identity.tenantId
        ) {
          throw new PrototypeServiceError('PROTOTYPE_JOB_NOT_FOUND', 'Prototype job not found');
        }
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        // New UI replies persist the currently selected model in the owner-bound message.
        // Historical messages without a model retain the existing job pin.
        const modelId = message.model ?? job.modelId;
        if (modelId !== job.modelId) {
          const policy = req?.config?.prototypeAgent?.modelPolicy;
          if (!policy?.version) throw new PrototypeServiceError('PROTOTYPE_SERVICE_UNAVAILABLE', 'Prototype model policy is unavailable');
          const evaluation = evaluateModel({ modelId, policy,
            providerCapabilities: req?.prototypeProviderCapabilities ?? { toolCalling: true } });
          if (!evaluation.allowed) throw new PrototypeServiceError(evaluation.code, 'The selected model is unavailable for prototypes');
        }
        if (!text || text.length > 50000) {
          throw new PrototypeServiceError('PROTOTYPE_INVALID_REPLY', 'Prototype reply is invalid');
        }
        const requirements = await this.requirementsFromFiles({
          identity,
          text,
          fileIds: fileIdsFrom(message),
        });
        // v2 remains text-only: the accepted turn contains the full document snapshot.
        const manifest = [];
        const turnId = jobScopedId('turn', jobId, key);
        const attemptId = jobScopedId('attempt', jobId, key);
        const executionId = jobScopedId('execution', jobId, key);
        const claimed = await this.deps.claimPrototypeReply(
          {
            jobId,
            expectedRevision: job.revision,
            replyToPrototypeMessageId: prototypeReplyToMessageId,
            ...(selectedVariant ? { selectedVariant } : {}),
            turn: {
              turnId,
              jobId,
              ordinal: job.revision,
              kind: 'user_reply',
              sourceMessageId: messageId,
              replyToPrototypeMessageId: prototypeReplyToMessageId,
              text: requirements.text,
              modelId,
              attachmentManifest: manifest,
              commandId,
              executionAttempts: 0,
              status: 'pending',
              costUsd: 0,
            },
            executionId,
            currentExecutionId: job.activeExecutionId,
            attemptId,
          },
          session,
        );
        result = claimed.job;
        if (typeof this.deps.allocatePrototypeEventSequence === 'function') {
          result = await this.deps.allocatePrototypeEventSequence(jobId, session);
        }
        await this.deps.appendPrototypeEvent(
          {
            jobId,
            eventId: result.eventSequence ?? result.revision + 1,
            sourceEventId: `transition:${commandId}`,
            revision: result.revision,
            type: 'job_state',
            publicPayload: cardFor(result, {
              cursor: result.eventSequence ?? result.revision + 1,
            }),
          },
          session,
        );
        await this.deps.enqueuePrototypeOutbox(
          {
            schemaVersion: 2,
            commandId,
            kind: 'execute_stage',
            jobId,
            turnId,
            tenantId: identity.tenantId,
            userId: String(identity.userId),
            modelId,
            expectedRevision: result.revision,
            executionId,
            attemptId,
            stage: 'generation',
            pipelineStep: 0,
            fenceToken: result.fenceToken,
            checkpointRevision: job.checkpointRevision ?? null,
            checkpointDigest: job.checkpointDigest ?? null,
            sourceDigest: job.sourcesDigest ?? null,
            budget: executionBudget(job.estimatedCost),
            deadlineAt: deadlineAt(),
            attachmentManifest: manifest,
            status: 'pending',
            publishAttempts: 0,
            publishedAt: null,
            lastAttemptAt: null,
          },
          session,
        );
      });
    } catch (error) {
      if (
        [
          'PROTOTYPE_STALE_REVISION',
          'PROTOTYPE_INVALID_STATE',
          'PROTOTYPE_ATTACHMENT_INVALID',
          'PROTOTYPE_REQUIREMENTS_TOO_LARGE',
          'PROTOTYPE_CONTENT_BLOCKED',
          'PROTOTYPE_MODERATION_UNAVAILABLE',
        ].includes(error?.code) &&
        typeof this.deps.discardPrototypeReplyMessage === 'function'
      ) {
        const identity = identityFrom(req, { requireConversation: false });
        try {
          await this.deps.discardPrototypeReplyMessage({
            jobId,
            user: String(identity.userId),
            tenantId: identity.tenantId,
            conversationId: conversationId ?? identity.conversationId,
            messageId,
            prototypeReplyToMessageId,
          });
        } catch {
          // Preserve the original CAS error. The accepted transition remains authoritative.
        }
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return cardFor(result, { cursor: result.eventSequence ?? result.revision + 1 });
  }

  async cancel({ req, jobId, conversationId, idempotencyKey, expectedRevision }) {
    return this.changeState({ req, jobId, conversationId, idempotencyKey, expectedRevision, action: 'cancel' });
  }

  async approve({ req, jobId, conversationId, idempotencyKey, expectedRevision }) {
    return this.changeState({ req, jobId, conversationId, idempotencyKey, expectedRevision, action: 'approve' });
  }

  async retry({ req, jobId, conversationId, idempotencyKey, expectedRevision }) {
    return this.changeState({ req, jobId, conversationId, idempotencyKey, expectedRevision, action: 'retry' });
  }

  async finalize({ req, jobId, conversationId, idempotencyKey, expectedRevision }) {
    return this.changeState({ req, jobId, conversationId, idempotencyKey, expectedRevision, action: 'finalize' });
  }

  async resume({ req, jobId, conversationId, idempotencyKey, expectedRevision }) {
    return this.changeState({ req, jobId, conversationId, idempotencyKey, expectedRevision, action: 'resume' });
  }

  async changeState({ req, jobId, conversationId, idempotencyKey, expectedRevision, action }) {
    if (action !== 'cancel') requirePrototypeEnabled(req, this.deps.isAvailable);
    const key = requireIdempotencyKey(idempotencyKey);
    const session = await this.deps.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const { identity, job } = await this.ownedJob(req, jobId, conversationId);
        const commandId = jobScopedId(action, jobId, key);
        const existingCommand = await this.deps.findPrototypeOutbox(commandId, session);
        if (existingCommand?.jobId === jobId || job.activeCommandId === commandId) {
          result = job;
          return;
        }
        if (job.revision !== expectedRevision) {
          throw new PrototypeServiceError(
            'PROTOTYPE_STALE_REVISION',
            'Prototype job revision no longer matches',
          );
        }
        const terminal = ['completed', 'failed', 'canceled'];
        const resumable = ['waiting_for_credentials', 'waiting_for_funds'];
        const retryable = ['failed', ...resumable];
        if (
          (action === 'cancel' && terminal.includes(job.status)) ||
          (action === 'resume' && !resumable.includes(job.status)) ||
          (action === 'retry' && !retryable.includes(job.status)) ||
          (action === 'approve' &&
            !(job.status === 'waiting_for_input' && job.waitingReason === 'plan_approval')) ||
          (action === 'finalize' && !actionsFor(job).finalize)
        ) {
          throw new PrototypeServiceError(
            'PROTOTYPE_INVALID_STATE',
            `Prototype job cannot ${action} while ${job.status}`,
          );
        }
        if (action === 'finalize') {
          const updated = await this.deps.transitionPrototypeJob({
            jobId,
            expectedRevision: job.revision,
            from: job.status,
            to: 'completed',
            patch: {
              waitingReason: null,
              phase: 'completed',
              activeCommandId: commandId,
              activeAttemptId: null,
              activeExecutionId: null,
              activeLeaseId: null,
              activeStage: null,
              completedAt: new Date(),
              fenceToken: (job.fenceToken ?? 0) + 1,
            },
            ...(job.activeExecutionId ? { executionId: job.activeExecutionId } : {}),
            session,
          });
          result = updated;
          if (typeof this.deps.allocatePrototypeEventSequence === 'function') {
            result = await this.deps.allocatePrototypeEventSequence(jobId, session);
          }
          await this.deps.appendPrototypeEvent(
            {
              jobId,
              eventId: result.eventSequence ?? updated.revision + 1,
              sourceEventId: `transition:${commandId}`,
              revision: updated.revision,
              type: 'job_state',
              publicPayload: cardFor(result, {
                cursor: result.eventSequence ?? updated.revision + 1,
              }),
            },
            session,
          );
          await this.deps.createPrototypeUserMessage({
            messageId: commandId,
            conversationId: job.conversationId,
            parentMessageId: job.latestPromptMessageId ?? job.originMessageId,
            user: String(identity.userId),
            tenantId: identity.tenantId,
            sender: 'Prototype',
            text: 'Работа над прототипом завершена.',
            model: job.modelId,
            isCreatedByUser: false,
            metadata: { prototypeAgent: cardFor(result), sourceEventId: commandId },
          }, session);
          return;
        }
        const latestTurn = await this.deps.findLatestPrototypeTurn(jobId, session);
        if (!latestTurn) {
          throw new PrototypeServiceError(
            'PROTOTYPE_INVALID_STATE',
            'Prototype job has no turn to continue',
          );
        }
        const executionId = jobScopedId('execution', jobId, key);
        const attemptId = jobScopedId('attempt', jobId, key);
        const updated =
          action === 'retry' && job.status === 'failed'
            ? await this.deps.retryFailedPrototypeJob(
                {
                  jobId,
                  expectedRevision: job.revision,
                  commandId,
                  attemptId,
                  executionId,
                },
                session,
              )
            : await this.deps.transitionPrototypeJob({
                jobId,
                expectedRevision: job.revision,
                from: job.status,
                to: action === 'cancel' ? 'canceled' : 'queued',
                patch: {
                  waitingReason: null,
                  activeCommandId: commandId,
                  activeAttemptId: action === 'cancel' ? null : attemptId,
                  activeExecutionId: action === 'cancel' ? null : executionId,
                  activeLeaseId: null,
                  activeStage: action === 'cancel' ? null : 'generation',
                  pipelineStep: action === 'cancel' ? (job.pipelineStep ?? 0) : 0,
                  fenceToken: (job.fenceToken ?? 0) + 1,
                },
                ...(job.activeExecutionId ? { executionId: job.activeExecutionId } : {}),
                session,
              });
        result = updated;
        if (typeof this.deps.allocatePrototypeEventSequence === 'function') {
          result = await this.deps.allocatePrototypeEventSequence(jobId, session);
        }
        await this.deps.appendPrototypeEvent(
          {
            jobId,
            eventId: result.eventSequence ?? updated.revision + 1,
            sourceEventId: `transition:${commandId}`,
            revision: updated.revision,
            type: 'job_state',
            publicPayload: cardFor(result, {
              cursor: result.eventSequence ?? updated.revision + 1,
            }),
          },
          session,
        );
        await this.deps.enqueuePrototypeOutbox(
          {
            schemaVersion: 2,
            commandId,
            kind: action === 'cancel' ? 'cancel_execution' : 'execute_stage',
            jobId,
            turnId: latestTurn.turnId,
            tenantId: identity.tenantId,
            userId: String(identity.userId),
            modelId: job.modelId,
            expectedRevision: action === 'cancel' ? job.revision : updated.revision,
            executionId: action === 'cancel' ? (job.activeExecutionId ?? executionId) : executionId,
            attemptId: action === 'cancel' ? (job.activeAttemptId ?? attemptId) : attemptId,
            stage: action === 'cancel' ? (job.activeStage ?? 'generation') : 'generation',
            pipelineStep: action === 'cancel' ? (job.pipelineStep ?? 0) : 0,
            fenceToken: action === 'cancel' ? job.fenceToken : updated.fenceToken,
            checkpointRevision: job.checkpointRevision ?? null,
            checkpointDigest: job.checkpointDigest ?? null,
            sourceDigest: job.sourcesDigest ?? null,
            budget: executionBudget(job.estimatedCost),
            deadlineAt: deadlineAt(),
            attachmentManifest: latestTurn.attachmentManifest ?? [],
            status: 'pending',
            publishAttempts: 0,
            publishedAt: null,
            lastAttemptAt: null,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return cardFor(result, { cursor: result.eventSequence ?? result.revision + 1 });
  }
}

module.exports = { PrototypeService, cardFor };
