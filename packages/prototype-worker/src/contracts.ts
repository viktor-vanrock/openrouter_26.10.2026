import { z } from 'zod';

const boundedId = z.string().min(1).max(256);
const safeId = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.:-]+$/);
const isoDate = z.string().datetime({ offset: true });
const attachment = z
  .object({
    fileId: safeId,
    filename: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(256),
    size: z.number().int().nonnegative(),
  })
  .strict();

const commandSchema = z
  .object({
    schemaVersion: z.literal(1),
    commandId: safeId,
    kind: z.enum(['start_turn', 'cancel_execution']),
    jobId: safeId,
    turnId: safeId,
    tenantId: safeId,
    modelId: boundedId,
    expectedRevision: z.number().int().nonnegative(),
    executionId: safeId,
    checkpointRevision: z.number().int().nonnegative().nullable(),
    attachmentManifest: z.array(attachment).max(100),
    createdAt: isoDate,
  })
  .strict();

const eventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: safeId,
    commandId: safeId.optional(),
    jobId: safeId,
    turnId: safeId.optional(),
    executionId: safeId,
    expectedRevision: z.number().int().nonnegative(),
    leaseId: safeId,
    type: z.enum([
      'progress',
      'waiting',
      'review_ready',
      'completed',
      'usage',
      'credentials_required',
      'funds_required',
      'failed',
    ]),
    payload: z.record(z.unknown()).refine(
      (value) => {
        const forbidden = /authorization|cookie|credential|token|api[_-]?key|workspace|absolutePath/i;
        const safeTokenCount = /^(input|output|total)Tokens$/;
        const visit = (entry: unknown): boolean => {
          if (Array.isArray(entry)) return entry.every(visit);
          if (entry && typeof entry === 'object') {
            return Object.entries(entry).every(
              ([key, child]) => (!forbidden.test(key) || safeTokenCount.test(key)) && visit(child),
            );
          }
          return true;
        };
        return visit(value);
      },
      'Worker event payload contains a forbidden sensitive field',
    ),
    createdAt: isoDate,
  })
  .strict()
  .superRefine((event, context) => {
    const payload = event.payload;
    const isGatewayControlEvent =
      event.type === 'credentials_required' || event.type === 'funds_required';
    if (!isGatewayControlEvent && event.commandId == null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['commandId'], message: 'Worker event requires a command identity' });
    }
    if (!isGatewayControlEvent && event.turnId == null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['turnId'], message: 'Worker event requires a turn identity' });
    }
    if (
      event.type === 'waiting' &&
      !(payload.waitingReason === 'clarification' || payload.waitingReason === 'plan_approval')
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', 'waitingReason'], message: 'Waiting event requires a reason' });
    }
    if (event.type === 'review_ready' && typeof payload.prototypeSlug !== 'string') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', 'prototypeSlug'], message: 'Review event requires a slug' });
    }
    if (event.type === 'completed' && typeof payload.prototypeSlug !== 'string') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', 'prototypeSlug'], message: 'Completed event requires a slug' });
    }
    if (event.type === 'progress' && !(typeof payload.phase === 'string' && payload.phase.length > 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', 'phase'], message: 'Progress event requires a phase' });
    }
    if (
      event.type === 'usage' &&
      !(typeof payload.costUsd === 'number' && Number.isFinite(payload.costUsd) && payload.costUsd >= 0)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', 'costUsd'], message: 'Usage event requires a non-negative cost' });
    }
    if (event.type === 'usage') {
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
        const value = payload[key];
        if (value != null && !(typeof value === 'number' && Number.isInteger(value) && value >= 0)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', key], message: 'Usage token counts must be non-negative integers' });
        }
      }
    }
    if (event.type === 'failed' && payload.code !== 'PROTOTYPE_EXECUTION_FAILED') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['payload', 'code'], message: 'Failed event requires a safe code' });
    }
    if (
      isGatewayControlEvent &&
      payload.checkpointRevision != null &&
      !(Number.isInteger(payload.checkpointRevision) && (payload.checkpointRevision as number) >= 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['payload', 'checkpointRevision'],
        message: 'Control event checkpoint revision must be a non-negative integer',
      });
    }
  });

export type PrototypeCommand = z.infer<typeof commandSchema>;
export type PrototypeWorkerEvent = z.infer<typeof eventSchema>;

export function parsePrototypeCommand(value: unknown): PrototypeCommand {
  return commandSchema.parse(value);
}

export function parsePrototypeWorkerEvent(value: unknown): PrototypeWorkerEvent {
  return eventSchema.parse(value);
}
