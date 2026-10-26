import { Schema } from 'mongoose';
import type { IPrototypeArtifact } from '~/types/prototype';

const prototypeArtifactSchema = new Schema<IPrototypeArtifact>(
  {
    artifactId: { type: Schema.Types.ObjectId, required: true },
    jobId: { type: String, required: true },
    tenantId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    revision: { type: Number, required: true, min: 0, validate: Number.isInteger },
    kind: { type: String, enum: ['checkpoint', 'dependency_bundle', 'html', 'sources_zip', 'qa_evidence'], required: true },
    objectKey: { type: String, required: true },
    storageBucket: { type: String, default: undefined },
    size: { type: Number, required: true, min: 0, validate: Number.isInteger },
    sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/i },
    contentType: { type: String, required: true },
    executionId: { type: String, required: true },
    templateDigest: { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
    toolchainDigest: { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

prototypeArtifactSchema.index({ artifactId: 1 }, { unique: true });
prototypeArtifactSchema.index({ jobId: 1, executionId: 1, revision: 1, kind: 1 }, { unique: true });
prototypeArtifactSchema.index({ userId: 1, tenantId: 1, artifactId: 1 });

export default prototypeArtifactSchema;
