import { Schema } from 'mongoose';
import type { PrototypeJobStatus } from 'librechat-data-provider';
import type { IPrototypeJob } from '~/types/prototype';
import prototypeGenerationSchema from './prototypeGeneration';

export const PROTOTYPE_TERMINAL_STATUSES = ['completed', 'failed', 'canceled'] as const;
export const PROTOTYPE_ACTIVE_STATUSES = [
  'queued',
  'preparing',
  'running',
  'waiting_for_input',
  'review',
  'waiting_for_credentials',
  'waiting_for_funds',
] as const satisfies readonly PrototypeJobStatus[];
const PROTOTYPE_JOB_STATUSES = [
  ...PROTOTYPE_ACTIVE_STATUSES,
  ...PROTOTYPE_TERMINAL_STATUSES,
] as const satisfies readonly PrototypeJobStatus[];

const costEstimateSchema = new Schema(
  {
    currency: { type: String, enum: ['USD'], required: true },
    low: { type: Number, required: true },
    likely: { type: Number, required: true },
    high: { type: Number, required: true },
    recoveryBufferPercent: { type: Number, enum: [20], required: true },
    method: { type: String, enum: ['admin_default', 'historical_quantiles'], required: true },
    sampleSize: { type: Number, required: true, min: 0, validate: Number.isInteger },
    modelId: { type: String, required: true },
    calculatedAt: { type: Date, required: true },
    balanceRemaining: { type: Number, default: null },
  },
  { _id: false },
);

const safeFailureSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

const activitySchema = new Schema(
  {
    id: { type: String, required: true },
    phase: { type: String, default: null },
    message: { type: String, required: true, maxlength: 2048 },
    createdAt: { type: String, required: true },
  },
  { _id: false },
);

const versionSchema = new Schema(
  {
    revision: { type: Number, required: true, min: 0, validate: Number.isInteger },
    turnId: { type: String, required: true },
    htmlDigest: { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
    sourcesDigest: { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
    acceptedAt: { type: String, required: true },
    selectedVariant: { type: String, enum: ['A', 'B', null], default: null },
  },
  { _id: false },
);

const prototypeJobSchema = new Schema<IPrototypeJob>(
  {
    generation: { type: prototypeGenerationSchema, default: undefined },
    jobId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tenantId: { type: String, required: true },
    conversationId: { type: String, required: true },
    originMessageId: { type: String, required: true },
    originToolCallId: { type: String, required: true },
    status: { type: String, enum: PROTOTYPE_JOB_STATUSES, required: true },
    waitingReason: { type: String, enum: ['clarification', 'plan_approval', null], default: null },
    phase: { type: String, default: null },
    modelId: { type: String, required: true },
    selectedVariant: { type: String, enum: ['A', 'B', null], default: null },
    modelPolicyVersion: { type: String, required: true },
    modelRecommendation: { type: String, enum: ['recommended', 'not_recommended'], required: true },
    revision: { type: Number, required: true, min: 0, validate: Number.isInteger },
    eventSequence: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    fenceToken: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    activeCommandId: { type: String, default: null },
    activeTurnId: { type: String, default: null },
    activeAttemptId: { type: String, default: null },
    activeExecutionId: { type: String, default: null },
    activeLeaseId: { type: String, default: null },
    activeStage: {
      type: String,
      enum: ['generation', 'transfer', 'dependency_preparation', 'build_qa', 'publish', null],
      default: null,
    },
    pipelineStep: { type: Number, required: true, min: 0, max: 5, validate: Number.isInteger, default: 0 },
    checkpointRevision: {
      type: Number,
      default: null,
      min: 0,
      validate: (value: number | null) => value === null || Number.isInteger(value),
    },
    checkpointDigest: { type: String, default: null, match: /^sha256:[a-f0-9]{64}$/ },
    latestPromptMessageId: { type: String, default: null },
    previewArtifactId: { type: Schema.Types.ObjectId, ref: 'PrototypeArtifact', default: null },
    previewDigest: { type: String, default: null, match: /^sha256:[a-f0-9]{64}$/ },
    sourcesArtifactId: { type: Schema.Types.ObjectId, ref: 'PrototypeArtifact', default: null },
    sourcesDigest: { type: String, default: null, match: /^sha256:[a-f0-9]{64}$/ },
    qaArtifactId: { type: Schema.Types.ObjectId, ref: 'PrototypeArtifact', default: null },
    templateDigest: { type: String, default: null, match: /^sha256:[a-f0-9]{64}$/ },
    toolchainDigest: { type: String, default: null, match: /^sha256:[a-f0-9]{64}$/ },
    estimatedCost: { type: costEstimateSchema, default: null },
    actualCostUsd: { type: Number, required: true, min: 0, default: 0 },
    failure: { type: safeFailureSchema, default: null },
    activity: { type: [activitySchema], default: [] },
    versions: { type: [versionSchema], default: [] },
    accessRevokedAt: { type: Date, default: null },
    cleanupStatus: {
      type: String,
      enum: ['none', 'pending', 'running', 'completed', 'failed'],
      default: 'none',
    },
    cleanupAttempts: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    cleanupNextAttemptAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

prototypeJobSchema.index({ jobId: 1 }, { unique: true });
prototypeJobSchema.index({ tenantId: 1, userId: 1, originToolCallId: 1 }, { unique: true });
prototypeJobSchema.index(
  { tenantId: 1, conversationId: 1 },
  {
    unique: true,
    name: 'prototype_conversation_lifetime_unique',
  },
);
prototypeJobSchema.index({ userId: 1, tenantId: 1, jobId: 1 });
prototypeJobSchema.index(
  { cleanupStatus: 1, cleanupNextAttemptAt: 1, updatedAt: 1 },
  { name: 'prototype_cleanup_retry' },
);

export default prototypeJobSchema;
