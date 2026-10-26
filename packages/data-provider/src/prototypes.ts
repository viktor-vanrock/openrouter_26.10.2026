import { z } from 'zod';

export const prototypeJobStatusSchema = z.enum([
  'queued',
  'preparing',
  'running',
  'waiting_for_input',
  'review',
  'waiting_for_credentials',
  'waiting_for_funds',
  'completed',
  'failed',
  'canceled',
]);

export type PrototypeJobStatus = z.infer<typeof prototypeJobStatusSchema>;

export const prototypeWaitingReasonSchema = z.enum(['clarification', 'plan_approval']).nullable();

export type PrototypeWaitingReason = z.infer<typeof prototypeWaitingReasonSchema>;

export const costEstimateSchema = z
  .object({
    currency: z.literal('USD'),
    low: z.number().finite(),
    likely: z.number().finite(),
    high: z.number().finite(),
    recoveryBufferPercent: z.literal(20),
    method: z.enum(['admin_default', 'historical_quantiles']),
    sampleSize: z.number().int().nonnegative(),
    modelId: z.string().min(1),
    calculatedAt: z.date(),
    balanceRemaining: z.number().finite().nullable(),
  })
  .strict();

export type CostEstimate = z.infer<typeof costEstimateSchema>;

export const prototypeActivitySchema = z
  .object({
    id: z.string().min(1),
    phase: z.string().nullable(),
    message: z.string().min(1).max(2048),
    createdAt: z.string().datetime(),
  })
  .strict();

export const prototypeVersionSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    turnId: z.string().min(1),
    htmlDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourcesDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    acceptedAt: z.string().datetime(),
    selectedVariant: z.enum(['A', 'B']).nullable().optional(),
  })
  .strict();

export const prototypeActionsSchema = z
  .object({
    approve: z.boolean(),
    cancel: z.boolean(),
    retry: z.boolean(),
    finalize: z.boolean(),
    reply: z.boolean(),
  })
  .strict();

export const prototypeCardDataSchema = z
  .object({
    type: z.literal('prototype'),
    jobId: z.string().min(1),
    conversationId: z.string().min(1),
    turnId: z.string().nullable(),
    revision: z.number().int().nonnegative(),
    cursor: z.number().int().nonnegative(),
    status: prototypeJobStatusSchema,
    phase: z.string().nullable(),
    waitingReason: prototypeWaitingReasonSchema,
    promptMessageId: z.string().nullable(),
    modelId: z.string().min(1),
    selectedVariant: z.enum(['A', 'B']).nullable().optional(),
    modelWarning: z.string().nullable(),
    prototypeName: z.string().nullable(),
    previewAvailable: z.boolean(),
    sourcesAvailable: z.boolean(),
    failure: z
      .object({ code: z.string().min(1), message: z.string().min(1) })
      .strict()
      .nullable(),
    activity: z.array(prototypeActivitySchema).max(100),
    versions: z.array(prototypeVersionSchema).max(100),
    actions: prototypeActionsSchema,
    canCancel: z.boolean(),
    canReply: z.boolean(),
    estimatedCost: costEstimateSchema.nullable(),
    actualCostUsd: z.number().finite(),
  })
  .strict();

export type PrototypeCardData = z.infer<typeof prototypeCardDataSchema>;

export const prototypeSnapshotSchema = z
  .object({
    card: prototypeCardDataSchema,
    cursor: z.number().int().nonnegative(),
  })
  .strict();
export type PrototypeSnapshot = z.infer<typeof prototypeSnapshotSchema>;

export const prototypeEventSchema = z
  .object({
    id: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    type: z.literal('job_state'),
    data: prototypeCardDataSchema,
  })
  .strict();
export type PrototypeEvent = z.infer<typeof prototypeEventSchema>;

export const prototypeErrorCodeSchema = z.enum([
  'PROTOTYPE_JOB_NOT_FOUND',
  'PROTOTYPE_ACTIVE_JOB_EXISTS',
  'PROTOTYPE_INVALID_STATE',
  'PROTOTYPE_STALE_REVISION',
  'PROTOTYPE_INVALID_REPLY',
  'PROTOTYPE_INVALID_REQUEST',
  'PROTOTYPE_ATTACHMENT_INVALID',
  'PROTOTYPE_REQUIREMENTS_TOO_LARGE',
  'PROTOTYPE_CONTENT_BLOCKED',
  'PROTOTYPE_MODERATION_UNAVAILABLE',
  'PROTOTYPE_MODEL_UNSUPPORTED',
  'PROTOTYPE_MODEL_BLOCKED',
  'PROTOTYPE_ARTIFACT_NOT_READY',
  'PROTOTYPE_STORAGE_UNAVAILABLE',
  'PROTOTYPE_QUEUE_UNAVAILABLE',
  'PROTOTYPE_SERVICE_UNAVAILABLE',
  'PROTOTYPE_SERVICE_TIMEOUT',
  'PROTOTYPE_CANCELED',
  'PROTOTYPE_FAILED',
]);

export type PrototypeErrorCode = z.infer<typeof prototypeErrorCodeSchema>;

/** The BFF derives reply text and attachments from the authorized chat message. */
export const prototypeReplyRequestSchema = z
  .object({
    messageId: z.string().min(1),
    prototypeReplyToMessageId: z.string().min(1),
    selectedVariant: z.enum(['A', 'B']).optional(),
  })
  .strict();

export type PrototypeReplyRequest = z.infer<typeof prototypeReplyRequestSchema>;

export const prototypeSubmitRequestSchema = z
  .object({
    messageId: z.string().min(1),
    parentMessageId: z.string().min(1),
    text: z.string().trim().min(1).max(50000),
    fileIds: z.array(z.string().trim().min(1).max(128)).max(10).optional(),
    modelId: z.string().min(1),
    endpoint: z.string().min(1).optional(),
    title: z.string().trim().min(1).max(120).optional(),
    revision: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type PrototypeSubmitRequest = z.infer<typeof prototypeSubmitRequestSchema>;

/** Card actions use Idempotency-Key plus X-Prototype-Revision headers and have no body. */
export const prototypeActionRequestSchema = z.object({}).strict();

export type PrototypeActionRequest = z.infer<typeof prototypeActionRequestSchema>;

export const prototypeJobResponseSchema = prototypeCardDataSchema;
export type PrototypeJobResponse = z.infer<typeof prototypeJobResponseSchema>;

export const prototypeReplyResponseSchema = prototypeCardDataSchema;
export type PrototypeReplyResponse = z.infer<typeof prototypeReplyResponseSchema>;

export const prototypeActionResponseSchema = prototypeCardDataSchema;
export type PrototypeActionResponse = z.infer<typeof prototypeActionResponseSchema>;

export const prototypeErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: prototypeErrorCodeSchema,
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type PrototypeErrorResponse = z.infer<typeof prototypeErrorResponseSchema>;
