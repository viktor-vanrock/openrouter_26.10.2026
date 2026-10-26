export type StoredObject = { objectKey: string; size: number; sha256: string };
export type ArtifactOwner = { tenantId: string; jobId: string; executionId: string; revision: number };
export type ImmutableArtifactKind = 'checkpoint' | 'dependency_bundle' | 'html' | 'sources_zip' | 'qa_evidence';
export type ImmutableStoredObject = StoredObject & ArtifactOwner & {
  kind: ImmutableArtifactKind;
  digest: `sha256:${string}`;
  contentType: string;
  templateDigest: `sha256:${string}`;
  toolchainDigest: `sha256:${string}`;
};

export interface ArtifactStore {
  publish(input: {
    owner: ArtifactOwner;
    kind: ImmutableArtifactKind;
    bytes: Buffer;
    digest: `sha256:${string}`;
    contentType: string;
    templateDigest: `sha256:${string}`;
    toolchainDigest: `sha256:${string}`;
  }): Promise<ImmutableStoredObject>;
  readVerified(reference: ImmutableStoredObject, expectedOwner: ArtifactOwner): Promise<Buffer>;
}

export interface PrototypeStorage {
  saveCheckpoint(input: {
    jobId: string;
    revision: number;
    source: string;
    sha256: string;
  }): Promise<StoredObject>;
  saveArtifact(input: {
    jobId: string;
    revision: number;
    kind: 'html' | 'sources_zip';
    source: string;
    sha256: string;
  }): Promise<StoredObject>;
  openObject(objectKey: string): Promise<NodeJS.ReadableStream>;
  restoreWorkspace(input: {
    jobId: string;
    checkpointRevision: number;
    destination: string;
  }): Promise<void>;
}
