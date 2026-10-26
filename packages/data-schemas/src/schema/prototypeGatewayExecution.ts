import { Schema } from 'mongoose';

/** Durable command intent. No credentials, raw logs or source bytes belong here. */
const prototypeGatewayExecutionSchema = new Schema({
  jobId: { type: String, required: true },
  turnId: { type: String, required: true },
  commandId: { type: String, required: true, unique: true },
  tenantId: { type: String, required: true },
  userId: { type: String, required: true },
  modelId: { type: String, required: true },
  expectedRevision: { type: Number, required: true, min: 0 },
  attemptId: { type: String, required: true },
  executionId: { type: String, required: true },
  stage: { type: String, required: true, enum: ['build_qa', 'generation'] },
  fenceToken: { type: Number, required: true, min: 1 },
  leaseId: { type: String, required: true },
  inputDigest: { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
  image: { type: String, required: true, match: /@sha256:[a-f0-9]{64}$/ },
  runId: { type: String, required: true },
  phase: { type: String, required: true },
  sandboxId: { type: String, default: null },
  sessionId: { type: String, default: null },
  stdoutOffset: { type: Number, default: 0, min: 0 },
  stderrOffset: { type: Number, default: 0, min: 0 },
  snapshotRefs: { type: Schema.Types.Mixed, default: null },
  cleanup: { type: String, default: 'pending' },
  stopEvidence: { type: String, default: 'stop_unknown', enum: ['stop_unknown'] },
  errorCode: { type: String, default: null },
  ledgerRevision: { type: Number, default: 0, min: 0 },
}, { timestamps: true, strict: 'throw' });
prototypeGatewayExecutionSchema.index({ jobId: 1, executionId: 1, fenceToken: 1 });
prototypeGatewayExecutionSchema.index({ cleanup: 1, updatedAt: 1 });
export default prototypeGatewayExecutionSchema;
