import { Schema } from 'mongoose';
import type { IPrototypeEvent } from '~/types/prototype';

const CARD_FIELDS = [
  'type',
  'jobId',
  'conversationId',
  'turnId',
  'revision',
  'cursor',
  'status',
  'phase',
  'waitingReason',
  'promptMessageId',
  'modelId',
  'modelWarning',
  'prototypeName',
  'previewAvailable',
  'sourcesAvailable',
  'failure',
  'activity',
  'versions',
  'actions',
  'canCancel',
  'canReply',
  'estimatedCost',
  'actualCostUsd',
] as const;
const JOB_STATUSES = new Set([
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
const ESTIMATE_FIELDS = new Set([
  'currency',
  'low',
  'likely',
  'high',
  'recoveryBufferPercent',
  'method',
  'sampleSize',
  'modelId',
  'calculatedAt',
  'balanceRemaining',
]);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function isExactCostEstimate(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const estimate = value as Record<string, unknown>;
  if (
    Object.keys(estimate).length !== ESTIMATE_FIELDS.size ||
    Object.keys(estimate).some((key) => !ESTIMATE_FIELDS.has(key))
  ) {
    return false;
  }
  return (
    estimate.currency === 'USD' &&
    isFiniteNumber(estimate.low) &&
    isFiniteNumber(estimate.likely) &&
    isFiniteNumber(estimate.high) &&
    estimate.recoveryBufferPercent === 20 &&
    (estimate.method === 'admin_default' || estimate.method === 'historical_quantiles') &&
    Number.isInteger(estimate.sampleSize) &&
    (estimate.sampleSize as number) >= 0 &&
    typeof estimate.modelId === 'string' &&
    estimate.modelId.length > 0 &&
    estimate.calculatedAt instanceof Date &&
    !Number.isNaN(estimate.calculatedAt.getTime()) &&
    (estimate.balanceRemaining === null || isFiniteNumber(estimate.balanceRemaining))
  );
}

function isExactPrototypeCardData(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const card = value as Record<string, unknown>;
  // Older events omit the choice; current snapshots include null until selection.
  const hasSelectedVariant = Object.prototype.hasOwnProperty.call(card, 'selectedVariant');
  if (
    Object.keys(card).length !== CARD_FIELDS.length + Number(hasSelectedVariant) ||
    Object.keys(card).some(
      (key) =>
        key !== 'selectedVariant' && !CARD_FIELDS.includes(key as (typeof CARD_FIELDS)[number]),
    ) ||
    (hasSelectedVariant &&
      card.selectedVariant !== null &&
      card.selectedVariant !== 'A' &&
      card.selectedVariant !== 'B')
  ) {
    return false;
  }
  return (
    card.type === 'prototype' &&
    typeof card.jobId === 'string' &&
    card.jobId.length > 0 &&
    typeof card.conversationId === 'string' &&
    card.conversationId.length > 0 &&
    isNullableString(card.turnId) &&
    Number.isInteger(card.revision) &&
    (card.revision as number) >= 0 &&
    Number.isInteger(card.cursor) &&
    (card.cursor as number) >= 0 &&
    JOB_STATUSES.has(card.status as string) &&
    isNullableString(card.phase) &&
    (card.waitingReason === null ||
      card.waitingReason === 'clarification' ||
      card.waitingReason === 'plan_approval') &&
    isNullableString(card.promptMessageId) &&
    typeof card.modelId === 'string' &&
    card.modelId.length > 0 &&
    isNullableString(card.modelWarning) &&
    isNullableString(card.prototypeName) &&
    typeof card.previewAvailable === 'boolean' &&
    typeof card.sourcesAvailable === 'boolean' &&
    (card.failure === null ||
      (typeof card.failure === 'object' &&
        !Array.isArray(card.failure) &&
        typeof (card.failure as Record<string, unknown>).code === 'string' &&
        typeof (card.failure as Record<string, unknown>).message === 'string')) &&
    Array.isArray(card.activity) &&
    Array.isArray(card.versions) &&
    typeof card.actions === 'object' &&
    card.actions !== null &&
    !Array.isArray(card.actions) &&
    ['approve', 'cancel', 'retry', 'finalize', 'reply'].every(
      (key) => typeof (card.actions as Record<string, unknown>)[key] === 'boolean',
    ) &&
    typeof card.canCancel === 'boolean' &&
    typeof card.canReply === 'boolean' &&
    isExactCostEstimate(card.estimatedCost) &&
    isFiniteNumber(card.actualCostUsd)
  );
}

const prototypeEventSchema = new Schema<IPrototypeEvent>(
  {
    jobId: { type: String, required: true },
    eventId: { type: Number, required: true, min: 0, validate: Number.isInteger },
    revision: { type: Number, required: true, min: 0, validate: Number.isInteger },
    sourceEventId: { type: String, required: true },
    type: { type: String, enum: ['job_state'], required: true },
    publicPayload: {
      type: Schema.Types.Mixed,
      required: true,
      validate: {
        validator: isExactPrototypeCardData,
        message: 'job_state publicPayload must be an exact PrototypeCardData payload',
      },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

prototypeEventSchema.index({ jobId: 1, eventId: 1 }, { unique: true });
prototypeEventSchema.index({ jobId: 1, sourceEventId: 1 }, { unique: true });

export default prototypeEventSchema;
