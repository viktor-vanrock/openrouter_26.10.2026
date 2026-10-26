import { createHash, randomUUID } from 'node:crypto';
import { immutableObjectKey } from './keys';
import { isConditionalCreateConflict } from './s3Conditional';
import type { ArtifactOwner, ArtifactStore, ImmutableStoredObject } from './types';

export type S3Head = { size: number; metadata: Record<string, string> };
export interface S3CompatibleClient {
  putObject(input: { bucket: string; key: string; body: Buffer; metadata: Record<string, string>; ifNoneMatch?: '*' }): Promise<void>;
  headObject(input: { bucket: string; key: string }): Promise<S3Head | null>;
  getObject(input: { bucket: string; key: string }): Promise<Buffer>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
}

const sha256 = (bytes: Buffer): `sha256:${string}` => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sameOwner = (left: ArtifactOwner, right: ArtifactOwner) =>
  left.tenantId === right.tenantId && left.jobId === right.jobId && left.executionId === right.executionId && left.revision === right.revision;

export class S3ArtifactStore implements ArtifactStore {
  constructor(private readonly client: S3CompatibleClient, private readonly bucket: string) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid S3 bucket');
  }

  async publish(input: Parameters<ArtifactStore['publish']>[0]): Promise<ImmutableStoredObject> {
    if (sha256(input.bytes) !== input.digest) throw new Error('PROTOTYPE_ARTIFACT_DIGEST_MISMATCH');
    const key = immutableObjectKey(input.owner, input.kind, input.digest);
    const stagingKey = `staging/${input.owner.tenantId}/${input.owner.jobId}/${input.owner.executionId}/${randomUUID()}`;
    const metadata = {
      tenant: input.owner.tenantId, job: input.owner.jobId, execution: input.owner.executionId,
      revision: String(input.owner.revision), digest: input.digest,
      template: input.templateDigest, toolchain: input.toolchainDigest, kind: input.kind,
    };
    try {
      await this.client.putObject({ bucket: this.bucket, key: stagingKey, body: input.bytes, metadata });
      const staged = await this.client.headObject({ bucket: this.bucket, key: stagingKey });
      if (!staged || staged.size !== input.bytes.length || staged.metadata.digest !== input.digest) {
        throw new Error('PROTOTYPE_ARTIFACT_STAGING_VERIFY_FAILED');
      }
      const existing = await this.client.headObject({ bucket: this.bucket, key });
      if (existing) {
        if (existing.size !== input.bytes.length || existing.metadata.digest !== input.digest) throw new Error('PROTOTYPE_ARTIFACT_IMMUTABLE_CONFLICT');
      } else {
        try {
          await this.client.putObject({ bucket: this.bucket, key, body: input.bytes, metadata, ifNoneMatch: '*' });
        } catch (error) {
          // Another identical immutable upload may win the race. Verify it; never retry an ambiguous PUT.
          if (!isConditionalCreateConflict(error)) throw error;
        }
      }
      const published = await this.client.headObject({ bucket: this.bucket, key });
      if (!published || published.size !== input.bytes.length || published.metadata.digest !== input.digest ||
          published.metadata.tenant !== input.owner.tenantId || published.metadata.job !== input.owner.jobId ||
          published.metadata.execution !== input.owner.executionId || published.metadata.revision !== String(input.owner.revision) ||
          published.metadata.template !== input.templateDigest || published.metadata.toolchain !== input.toolchainDigest ||
          published.metadata.kind !== input.kind) {
        throw new Error('PROTOTYPE_ARTIFACT_PUBLICATION_VERIFY_FAILED');
      }
      const uploaded = await this.client.getObject({ bucket: this.bucket, key });
      if (uploaded.length !== input.bytes.length || sha256(uploaded) !== input.digest) {
        throw new Error('PROTOTYPE_ARTIFACT_PUBLICATION_DIGEST_MISMATCH');
      }
      return { objectKey: key, size: published.size, sha256: input.digest.slice(7), digest: input.digest,
        ...input.owner, kind: input.kind, contentType: input.contentType,
        templateDigest: input.templateDigest, toolchainDigest: input.toolchainDigest };
    } finally {
      await this.client.deleteObject({ bucket: this.bucket, key: stagingKey }).catch(() => undefined);
    }
  }

  async readVerified(reference: ImmutableStoredObject, expectedOwner: ArtifactOwner): Promise<Buffer> {
    if (!sameOwner(reference, expectedOwner) || reference.objectKey !== immutableObjectKey(expectedOwner, reference.kind, reference.digest)) {
      throw new Error('PROTOTYPE_ARTIFACT_OWNERSHIP_MISMATCH');
    }
    const head = await this.client.headObject({ bucket: this.bucket, key: reference.objectKey });
    if (!head || head.metadata.digest !== reference.digest || head.metadata.tenant !== expectedOwner.tenantId ||
        head.metadata.job !== expectedOwner.jobId || head.metadata.execution !== expectedOwner.executionId ||
        head.metadata.revision !== String(expectedOwner.revision) || head.metadata.template !== reference.templateDigest ||
        head.metadata.toolchain !== reference.toolchainDigest || head.metadata.kind !== reference.kind) throw new Error('PROTOTYPE_ARTIFACT_METADATA_MISMATCH');
    const bytes = await this.client.getObject({ bucket: this.bucket, key: reference.objectKey });
    if (bytes.length !== reference.size || sha256(bytes) !== reference.digest) throw new Error('PROTOTYPE_ARTIFACT_DIGEST_MISMATCH');
    return bytes;
  }
}
