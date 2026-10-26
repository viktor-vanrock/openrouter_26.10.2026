import { z } from 'zod';
import type { PrototypeCommand } from './contracts';

const safeId = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.:-]+$/);
const boundedText = z.string().min(1).max(2_048);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const objectId = z.string().regex(/^[a-f0-9]{24}$/);
const isoDate = z.string().datetime({ offset: true });

/** Additive trusted runtime pins; historical commands may omit them. */
export const prototypeGenerationBindingSchema = z.object({
  schemaVersion: z.literal(1),
  engineId: z.enum(['direct-react-v1', 'opencode-fsd-v1']),
  sourceProfile: z.enum(['react-source-v1', 'react-fsd-source-v1']),
  rulesDigest: digest,
  templateDigest: digest,
  toolchainDigest: digest,
}).strict().refine(value => (value.engineId === 'direct-react-v1') === (value.sourceProfile === 'react-source-v1'),
  { message: 'Generation engine and source profile must match' });

export const prototypeStageSchema = z.enum([
  'generation',
  'transfer',
  'dependency_preparation',
  'build_qa',
  'publish',
]);

const budgetSchema = z
  .object({
    currency: z.literal('USD'),
    maxCostUsd: z.number().finite().nonnegative(),
    maxRequests: z.number().int().positive(),
    maxInputTokens: z.number().int().positive().nullable(),
    maxOutputTokens: z.number().int().positive().nullable(),
  })
  .strict();

const checkpointSchema = z
  .object({ revision: z.number().int().nonnegative(), digest })
  .strict();

const repairSchema = z.object({
  ordinal: z.number().int().min(1).max(2),
  diagnostics: z.array(boundedText).min(1).max(20),
}).strict();

const identitySchema = z
  .object({
    jobId: safeId,
    turnId: safeId,
    expectedRevision: z.number().int().nonnegative(),
    attemptId: safeId,
    executionId: safeId,
    stage: prototypeStageSchema,
    fenceToken: z.number().int().positive(),
    pipelineStep: z.number().int().min(0).max(5).optional(),
  })
  .strict();

const commandSchemaV2 = z
  .object({
    schemaVersion: z.literal(2),
    commandId: safeId,
    kind: z.enum(['execute_stage', 'cancel_execution']),
    tenantId: safeId,
    userId: safeId,
    modelId: z.string().min(1).max(256),
    generation: prototypeGenerationBindingSchema.optional(),
    checkpoint: checkpointSchema.nullable(),
    sourceDigest: digest.nullable(),
    dependencyDigest: digest.nullable().optional(),
    budget: budgetSchema,
    createdAt: isoDate,
    deadlineAt: isoDate,
    repair: repairSchema.optional(),
  })
  .merge(identitySchema)
  .superRefine((command, context) => {
    if (new Date(command.deadlineAt).getTime() <= new Date(command.createdAt).getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deadlineAt'],
        message: 'Command deadline must be after creation',
      });
    }
    if (command.kind === 'execute_stage' && command.stage !== 'generation' && !command.sourceDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceDigest'],
        message: 'Non-generation stages require an immutable source digest',
      });
    }
    if (command.kind === 'execute_stage' && command.stage === 'build_qa' && !command.dependencyDigest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dependencyDigest'],
        message: 'Build/QA requires a verified dependency digest',
      });
    }
    if (command.repair && (command.kind !== 'execute_stage' || !command.checkpoint)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repair'],
        message: 'Repair metadata requires a checkpoint-backed execution command',
      });
    }
  });

const artifactSchema = z
  .object({
    artifactId: objectId,
    kind: z.enum(['checkpoint', 'html', 'sources_zip', 'qa_evidence']),
    digest,
    size: z.number().int().nonnegative(),
    contentType: z.string().min(1).max(256),
    executionId: safeId.optional(),
    revision: z.number().int().nonnegative().optional(),
    templateDigest: digest.optional(),
    toolchainDigest: digest.optional(),
  })
  .strict();

const safeFailureCodeSchema = z.enum([
  'PROTOTYPE_EXECUTION_FAILED',
  'PROTOTYPE_DEADLINE_EXCEEDED',
  'PROTOTYPE_BUDGET_EXCEEDED',
  'PROTOTYPE_DEPENDENCY_REJECTED',
  'PROTOTYPE_BUILD_FAILED',
  'PROTOTYPE_QA_FAILED',
  'PROTOTYPE_QA_INFRASTRUCTURE_FAILED',
  'PROTOTYPE_ARTIFACT_REJECTED',
  'PROTOTYPE_LEASE_LOST',
  'PROTOTYPE_SERVICE_UNAVAILABLE',
]);

const payloadSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('progress'), phase: boundedText }).strict(),
    z.object({
      type: z.literal('stage_completed'),
      outputKind: z.enum(['checkpoint', 'checkpoint_restored', 'dependency_bundle', 'dependencies_restored', 'verified_snapshot']),
      outputDigest: digest,
      checkpoint: checkpointSchema.optional(),
      artifacts: z.array(z.object({
        kind: z.enum(['checkpoint', 'dependency_bundle', 'html', 'sources_zip', 'qa_evidence']),
        digest, size: z.number().int().nonnegative(), contentType: z.string().min(1).max(256),
      }).strict()).max(8).default([]),
    }).strict(),
    z
      .object({ type: z.literal('checkpoint_ready'), checkpoint: checkpointSchema, artifact: artifactSchema })
      .strict(),
    z
      .object({
        type: z.literal('waiting'),
        reason: z.enum(['clarification', 'plan_approval']),
        prompt: boundedText,
        checkpoint: checkpointSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('review_ready'),
        artifacts: z.array(artifactSchema).min(2).max(8),
        checkpoint: checkpointSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('completed'),
        artifacts: z.array(artifactSchema).min(2).max(8),
        checkpoint: checkpointSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal('usage'),
        reservationId: safeId,
        requestCount: z.number().int().positive(),
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
        costUsd: z.number().finite().nonnegative().nullable(),
        final: z.boolean(),
      })
      .strict(),
    z.object({ type: z.literal('credentials_required'), checkpoint: checkpointSchema.nullable() }).strict(),
    z.object({ type: z.literal('funds_required'), checkpoint: checkpointSchema.nullable() }).strict(),
    z
      .object({
        type: z.literal('failed'),
        code: safeFailureCodeSchema,
        message: boundedText,
        retryable: z.boolean(),
        diagnostics: z.array(boundedText).min(1).max(20).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('canceled'),
        code: z.enum(['PROTOTYPE_CANCELED', 'PROTOTYPE_LEASE_LOST', 'PROTOTYPE_DEADLINE_EXCEEDED']),
      })
      .strict(),
  ])
  .superRefine((payload, context) => {
    const forbidden = /authorization|cookie|credential|token|api[_-]?key|workspace|absolutePath/i;
    const safeTokenCount = /^(input|output)Tokens$/;
    const visit = (entry: unknown): boolean => {
      if (Array.isArray(entry)) return entry.every(visit);
      if (entry && typeof entry === 'object') {
        return Object.entries(entry).every(
          ([key, child]) => (!forbidden.test(key) || safeTokenCount.test(key)) && visit(child),
        );
      }
      return true;
    };
    if (!visit(payload)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event payload contains sensitive data' });
    }
    if (payload.type === 'review_ready' || payload.type === 'completed') {
      const requiredKinds = new Set(['checkpoint', 'html', 'sources_zip', 'qa_evidence']);
      for (const artifact of payload.artifacts) {
        requiredKinds.delete(artifact.kind);
        if (!artifact.executionId || artifact.revision === undefined || !artifact.templateDigest || !artifact.toolchainDigest) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Published artifacts require execution, revision, template and toolchain metadata' });
        }
      }
      if (requiredKinds.size > 0) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Publication is missing required artifacts' });
    }
  });

const eventSchemaV2 = z
  .object({
    schemaVersion: z.literal(2),
    eventId: safeId,
    commandId: safeId,
    leaseId: safeId,
    payload: payloadSchema,
    createdAt: isoDate,
  })
  .merge(identitySchema)
  .superRefine((event, context) => {
    if (event.payload.type === 'stage_completed' && event.pipelineStep === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['pipelineStep'], message: 'Stage completion requires pipelineStep' });
    }
  });

export type PrototypeCommandV2 = z.infer<typeof commandSchemaV2>;
export type PrototypeWorkerEventV2 = z.infer<typeof eventSchemaV2>;
export type PrototypeStage = z.infer<typeof prototypeStageSchema>;

export const PROTOTYPE_COMMAND_STREAM_V2 = 'prototype.commands.v2';
export const PROTOTYPE_EVENT_STREAM_V2 = 'prototype.events.v2';

export function parsePrototypeCommandV2(value: unknown): PrototypeCommandV2 {
  return commandSchemaV2.parse(value);
}

export function parsePrototypeWorkerEventV2(value: unknown): PrototypeWorkerEventV2 {
  return eventSchemaV2.parse(value);
}

/**
 * Trusted drain adapter. Values absent from v1 must be read from Mongo/config,
 * never inferred from the untrusted stream entry.
 */
export function adaptPrototypeCommandV1(
  command: PrototypeCommand,
  context: Pick<
    PrototypeCommandV2,
    'attemptId' | 'fenceToken' | 'stage' | 'checkpoint' | 'sourceDigest' | 'budget' | 'deadlineAt'
    | 'userId'
  >,
): PrototypeCommandV2 {
  if (command.attachmentManifest.length > 0) {
    throw new Error('Prototype v1 attachments cannot be adapted to the text-only v2 contract');
  }
  return parsePrototypeCommandV2({
    schemaVersion: 2,
    commandId: command.commandId,
    kind: command.kind === 'cancel_execution' ? 'cancel_execution' : 'execute_stage',
    jobId: command.jobId,
    turnId: command.turnId,
    tenantId: command.tenantId,
    userId: context.userId,
    modelId: command.modelId,
    expectedRevision: command.expectedRevision,
    attemptId: context.attemptId,
    executionId: command.executionId,
    stage: context.stage,
    fenceToken: context.fenceToken,
    checkpoint: context.checkpoint,
    sourceDigest: context.sourceDigest,
    budget: context.budget,
    createdAt: command.createdAt,
    deadlineAt: context.deadlineAt,
  });
}
