import type { ArtifactOwner, ArtifactStore, ImmutableStoredObject } from '../storage/types';
import type { VerifiedArtifactSnapshot } from './artifacts';

export class PublicationAdapter {
  constructor(private readonly store: ArtifactStore) {}
  async publish(input: {
    owner: ArtifactOwner; snapshot: VerifiedArtifactSnapshot; checkpoint: Buffer;
    checkpointDigest: `sha256:${string}`; templateDigest: `sha256:${string}`; toolchainDigest: `sha256:${string}`;
  }): Promise<ImmutableStoredObject[]> {
    const common = { owner: input.owner, templateDigest: input.templateDigest, toolchainDigest: input.toolchainDigest };
    const artifacts = [
      { ...common, kind: 'checkpoint' as const, bytes: input.checkpoint, digest: input.checkpointDigest, contentType: 'application/zstd' },
      { ...common, kind: 'html' as const, bytes: input.snapshot.html, digest: input.snapshot.digests.html, contentType: 'text/html; charset=utf-8' },
      { ...common, kind: 'sources_zip' as const, bytes: input.snapshot.sourcesZip, digest: input.snapshot.digests.sourcesZip, contentType: 'application/zip' },
      { ...common, kind: 'qa_evidence' as const, bytes: input.snapshot.qaEvidence, digest: input.snapshot.digests.qaEvidence, contentType: 'application/json' },
    ];
    const published: ImmutableStoredObject[] = [];
    for (const artifact of artifacts) published.push(await this.store.publish(artifact));
    return published;
  }
}
