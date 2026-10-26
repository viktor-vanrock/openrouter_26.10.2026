import type {
  CostEstimate,
  PrototypeCardData,
  PrototypeJobStatus,
  PrototypeWaitingReason,
} from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

export type PrototypeModelRecommendation = 'recommended' | 'not_recommended';
export type PrototypeTurnKind = 'initial' | 'user_reply' | 'recovery_retry';
export type PrototypeTurnStatus = 'pending' | 'running' | 'applied' | 'failed' | 'canceled';
export type PrototypeArtifactKind = 'checkpoint' | 'dependency_bundle' | 'html' | 'sources_zip' | 'qa_evidence';
export type PrototypeOutboxKind = 'start_turn' | 'execute_stage' | 'cancel_execution';
export type PrototypeOutboxStatus = 'pending' | 'publishing' | 'published' | 'failed';

export interface PrototypeGenerationBinding {
  schemaVersion: 1;
  engineId: 'direct-react-v1' | 'opencode-fsd-v1';
  sourceProfile: 'react-source-v1' | 'react-fsd-source-v1';
  rulesDigest: string;
  templateDigest: string;
  toolchainDigest: string;
}

/** Sanitized error information suitable for browser-facing state. */
export interface PrototypeSafeFailure {
  code: string;
  message: string;
}

export interface PrototypeActivity {
  id: string;
  phase: string | null;
  message: string;
  createdAt: string;
}

export interface PrototypeVersion {
  revision: number;
  turnId: string;
  htmlDigest: string;
  sourcesDigest: string;
  acceptedAt: string;
  selectedVariant?: 'A' | 'B' | null;
}

/** File references derived from authorized message records. */
export interface PrototypeAttachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface IPrototypeJob {
  selectedVariant?: 'A' | 'B' | null;
  generation?: PrototypeGenerationBinding | null;
  jobId: string;
  userId: Types.ObjectId;
  tenantId: string;
  conversationId: string;
  originMessageId: string;
  originToolCallId: string;
  status: PrototypeJobStatus;
  waitingReason: PrototypeWaitingReason;
  phase: string | null;
  modelId: string;
  modelPolicyVersion: string;
  modelRecommendation: PrototypeModelRecommendation;
  revision: number;
  eventSequence: number;
  fenceToken: number;
  activeCommandId: string | null;
  activeTurnId: string | null;
  activeAttemptId: string | null;
  activeExecutionId: string | null;
  activeLeaseId: string | null;
  activeStage: 'generation' | 'transfer' | 'dependency_preparation' | 'build_qa' | 'publish' | null;
  pipelineStep?: number;
  checkpointRevision: number | null;
  checkpointDigest: string | null;
  latestPromptMessageId: string | null;
  previewArtifactId: Types.ObjectId | null;
  previewDigest: string | null;
  sourcesArtifactId: Types.ObjectId | null;
  sourcesDigest: string | null;
  qaArtifactId: Types.ObjectId | null;
  templateDigest: string | null;
  toolchainDigest: string | null;
  estimatedCost: CostEstimate | null;
  actualCostUsd: number;
  failure: PrototypeSafeFailure | null;
  activity: PrototypeActivity[];
  versions: PrototypeVersion[];
  accessRevokedAt: Date | null;
  cleanupStatus: 'none' | 'pending' | 'running' | 'completed' | 'failed';
  cleanupAttempts: number;
  cleanupNextAttemptAt: Date | null;
  completedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPrototypeTurn {
  generation?: PrototypeGenerationBinding | null;
  turnId: string;
  jobId: string;
  ordinal: number;
  kind: PrototypeTurnKind;
  sourceMessageId: string | null;
  replyToPrototypeMessageId: string | null;
  text: string;
  modelId: string;
  attachmentManifest: PrototypeAttachment[];
  commandId: string;
  executionAttempts: number;
  status: PrototypeTurnStatus;
  costUsd: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IPrototypeEvent {
  jobId: string;
  eventId: number;
  revision: number;
  sourceEventId: string;
  /** Phase 2 persists only durable job/card state events. */
  type: 'job_state';
  publicPayload: PrototypeCardData;
  createdAt?: Date;
}

export interface IPrototypeArtifact {
  artifactId: Types.ObjectId;
  jobId: string;
  tenantId: string;
  userId: Types.ObjectId;
  revision: number;
  kind: PrototypeArtifactKind;
  objectKey: string;
  storageBucket?: string;
  size: number;
  sha256: string;
  contentType: string;
  executionId: string;
  templateDigest: string;
  toolchainDigest: string;
  createdAt?: Date;
}

/** Durable, explicitly-shaped command envelope. It intentionally excludes credentials and job tokens. */
export interface IPrototypeOutbox {
  schemaVersion: 1 | 2;
  commandId: string;
  kind: PrototypeOutboxKind;
  jobId: string;
  turnId: string;
  tenantId: string;
  userId?: string;
  modelId: string;
  expectedRevision: number;
  executionId: string;
  attemptId?: string;
  stage?: 'generation' | 'transfer' | 'dependency_preparation' | 'build_qa' | 'publish';
  pipelineStep?: number;
  fenceToken?: number;
  checkpointRevision: number | null;
  checkpointDigest?: string | null;
  sourceDigest?: string | null;
  dependencyDigest?: string | null;
  budget?: {
    currency: 'USD';
    maxCostUsd: number;
    maxRequests: number;
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
  };
  deadlineAt?: Date;
  repair?: { ordinal: number; diagnostics: string[] } | null;
  attachmentManifest: PrototypeAttachment[];
  status: PrototypeOutboxStatus;
  publishAttempts: number;
  publishedAt: Date | null;
  lastAttemptAt: Date | null;
  publisherId?: string | null;
  claimExpiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Idempotency receipt committed in the same transaction as a worker event effect. */
export interface IPrototypeWorkerEventReceipt {
  eventId: string;
  jobId: string;
  commandId: string;
  payloadType: string;
  payloadDigest: string;
  createdAt?: Date;
}

export type IPrototypeJobDocument = IPrototypeJob & Document;
export type IPrototypeTurnDocument = IPrototypeTurn & Document;
export type IPrototypeEventDocument = IPrototypeEvent & Document;
export type IPrototypeArtifactDocument = IPrototypeArtifact & Document;
export type IPrototypeOutboxDocument = IPrototypeOutbox & Document;
export type IPrototypeWorkerEventReceiptDocument = IPrototypeWorkerEventReceipt & Document;
