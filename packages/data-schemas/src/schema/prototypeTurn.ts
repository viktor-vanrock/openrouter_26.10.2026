import { Schema } from 'mongoose';
import type { IPrototypeTurn } from '~/types/prototype';
import prototypeGenerationSchema from './prototypeGeneration';

const attachmentSchema = new Schema(
  {
    fileId: { type: String, required: true },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0, validate: Number.isInteger },
  },
  { _id: false },
);

const prototypeTurnSchema = new Schema<IPrototypeTurn>(
  {
    generation: { type: prototypeGenerationSchema, default: undefined },
    turnId: { type: String, required: true },
    jobId: { type: String, required: true },
    ordinal: { type: Number, required: true, min: 0, validate: Number.isInteger },
    kind: { type: String, enum: ['initial', 'user_reply', 'recovery_retry'], required: true },
    sourceMessageId: { type: String, default: null },
    replyToPrototypeMessageId: { type: String, default: null },
    text: { type: String, required: true },
    modelId: { type: String, required: true },
    attachmentManifest: { type: [attachmentSchema], default: [] },
    commandId: { type: String, required: true },
    executionAttempts: { type: Number, required: true, min: 0, validate: Number.isInteger, default: 0 },
    status: { type: String, enum: ['pending', 'running', 'applied', 'failed', 'canceled'], required: true },
    costUsd: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true },
);

prototypeTurnSchema.index({ turnId: 1 }, { unique: true });
prototypeTurnSchema.index({ jobId: 1, ordinal: 1 }, { unique: true });
prototypeTurnSchema.index({ commandId: 1 }, { unique: true });

export default prototypeTurnSchema;
