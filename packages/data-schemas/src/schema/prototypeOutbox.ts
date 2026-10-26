import { Schema } from 'mongoose';
import type { IPrototypeOutbox } from '~/types/prototype';

const attachmentSchema = new Schema(
  {
    fileId: { type: String, required: true },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0, validate: Number.isInteger },
  },
  { _id: false },
);

const budgetSchema = new Schema(
  {
    currency: { type: String, enum: ['USD'], required: true },
    maxCostUsd: { type: Number, required: true, min: 0 },
    maxRequests: { type: Number, required: true, min: 1, validate: Number.isInteger },
    maxInputTokens: { type: Number, default: null, min: 1, validate: (value: number | null) => value === null || Number.isInteger(value) },
    maxOutputTokens: { type: Number, default: null, min: 1, validate: (value: number | null) => value === null || Number.isInteger(value) },
  },
  { _id: false },
);

const repairSchema = new Schema(
  {
    ordinal: { type: Number, required: true, min: 1, max: 2, validate: Number.isInteger },
    diagnostics: {
      type: [String], required: true,
      validate: (value: string[]) => value.length >= 1 && value.length <= 20 &&
        value.every((entry) => entry.length >= 1 && entry.length <= 2_048),
    },
  },
  { _id: false },
);

function requiredForV2(this: IPrototypeOutbox): boolean {
  return this.schemaVersion === 2;
}

const prototypeOutboxSchema = new Schema<IPrototypeOutbox>(
  {
    schemaVersion: { type: Number, enum: [1, 2], required: true, default: 2 },
    commandId: { type: String, required: true },
    kind: { type: String, enum: ['start_turn', 'execute_stage', 'cancel_execution'], required: true },
    jobId: { type: String, required: true },
    turnId: { type: String, required: true },
    tenantId: { type: String, required: true },
    userId: { type: String, required: requiredForV2 },
    modelId: { type: String, required: true },
    expectedRevision: { type: Number, required: true, min: 0, validate: Number.isInteger },
    executionId: { type: String, required: true },
    attemptId: { type: String, required: requiredForV2 },
    stage: {
      type: String,
      enum: ['generation', 'transfer', 'dependency_preparation', 'build_qa', 'publish'],
      required: requiredForV2,
    },
    pipelineStep: { type: Number, min: 0, max: 5, validate: Number.isInteger, required: requiredForV2, default: 0 },
    fenceToken: { type: Number, min: 1, validate: Number.isInteger, required: requiredForV2 },
    checkpointRevision: {
      type: Number,
      default: null,
      min: 0,
      validate: (value: number | null) => value === null || Number.isInteger(value),
    },
    checkpointDigest: { type: String, default: null, match: /^sha256:[a-f0-9]{64}$/ },
    sourceDigest: { type: String, default: null, match: /^sha256:[a-f0-9]{64}$/ },
    dependencyDigest: { type: String, default: null, match: /^sha256:[a-f0-9]{64}$/ },
    budget: { type: budgetSchema, required: requiredForV2 },
    deadlineAt: { type: Date, required: requiredForV2 },
    repair: { type: repairSchema, default: null },
    attachmentManifest: { type: [attachmentSchema], default: [] },
    status: { type: String, enum: ['pending', 'publishing', 'published', 'failed'], required: true, default: 'pending' },
    publishAttempts: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    publishedAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    publisherId: { type: String, default: null },
    claimExpiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

prototypeOutboxSchema.index({ commandId: 1 }, { unique: true });
prototypeOutboxSchema.index({ status: 1, createdAt: 1 });
prototypeOutboxSchema.index({ status: 1, claimExpiresAt: 1, createdAt: 1 });
prototypeOutboxSchema.index({ jobId: 1, createdAt: 1 });

export default prototypeOutboxSchema;
