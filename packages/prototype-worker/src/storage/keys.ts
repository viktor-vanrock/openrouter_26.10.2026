const JOB_ID = /^job_[a-zA-Z0-9_-]+$/;
const SAFE_ID = /^[a-zA-Z0-9_.:-]+$/;

export function validateStorageIdentity(jobId: string, revision: number): void {
  if (!JOB_ID.test(jobId) || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Invalid prototype storage identity');
  }
}

export const checkpointKey = (jobId: string, revision: number): string => {
  validateStorageIdentity(jobId, revision);
  return `jobs/${jobId}/checkpoints/${revision}/workspace.tar.zst`;
};

export const artifactKey = (
  jobId: string,
  revision: number,
  kind: 'html' | 'sources_zip',
): string => {
  validateStorageIdentity(jobId, revision);
  return `jobs/${jobId}/artifacts/${revision}/${kind === 'html' ? 'preview.html' : 'sources.zip'}`;
};

export const immutableArtifactKey = (
  jobId: string,
  revision: number,
  kind: 'checkpoint' | 'html' | 'sources_zip' | 'qa_evidence',
  digest: string,
): string => {
  validateStorageIdentity(jobId, revision);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid prototype artifact digest');
  const filename = {
    checkpoint: 'workspace.tar.zst',
    html: 'preview.html',
    sources_zip: 'sources.zip',
    qa_evidence: 'qa.json',
  }[kind];
  return `jobs/${jobId}/immutable/${revision}/${digest.slice(7)}/${filename}`;
};

export type ImmutableObjectIdentity = {
  tenantId: string;
  jobId: string;
  executionId: string;
  revision: number;
};

export type ImmutableObjectKind = 'checkpoint' | 'dependency_bundle' | 'html' | 'sources_zip' | 'qa_evidence';

function validateImmutableIdentity(identity: ImmutableObjectIdentity): void {
  validateStorageIdentity(identity.jobId, identity.revision);
  if (!SAFE_ID.test(identity.tenantId) || !SAFE_ID.test(identity.executionId)) {
    throw new Error('Invalid prototype immutable object identity');
  }
}

export function immutableObjectKey(
  identity: ImmutableObjectIdentity,
  kind: ImmutableObjectKind,
  digest: string,
): string {
  validateImmutableIdentity(identity);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid prototype artifact digest');
  const filename: Record<ImmutableObjectKind, string> = {
    checkpoint: 'workspace.tar.zst', dependency_bundle: 'dependencies.zip', html: 'preview.html',
    sources_zip: 'sources.zip', qa_evidence: 'qa.json',
  };
  return `tenants/${identity.tenantId}/jobs/${identity.jobId}/executions/${identity.executionId}/revisions/${identity.revision}/${digest.slice(7)}/${filename[kind]}`;
}

export function dependencyCacheKey(input: {
  lockfileDigest: string;
  os: string;
  arch: string;
  nodeAbi: string;
  toolchainDigest: string;
}): string {
  for (const digest of [input.lockfileDigest, input.toolchainDigest]) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid dependency cache digest');
  }
  for (const value of [input.os, input.arch, input.nodeAbi]) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error('Invalid dependency cache platform');
  }
  return `dependency-cache/${input.os}/${input.arch}/abi-${input.nodeAbi}/${input.toolchainDigest.slice(7)}/${input.lockfileDigest.slice(7)}.zip`;
}
