import { dependencyCacheKey, immutableArtifactKey, immutableObjectKey } from './keys';

describe('immutable artifact keys', () => {
  it('binds the object key to job, revision, kind, and digest', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(immutableArtifactKey('job_abc', 7, 'html', digest)).toBe(
      `jobs/job_abc/immutable/7/${'a'.repeat(64)}/preview.html`,
    );
  });

  it('rejects malformed storage identity and digest', () => {
    expect(() => immutableArtifactKey('../job', 1, 'html', `sha256:${'a'.repeat(64)}`)).toThrow();
    expect(() => immutableArtifactKey('job_abc', 1, 'html', 'sha256:bad')).toThrow();
  });
});

describe('phase 3 immutable storage keys', () => {
  it('binds tenant, job, execution, revision and digest', () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    expect(immutableObjectKey({ tenantId: 'tenant_1', jobId: 'job_abc', executionId: 'exec_1', revision: 4 }, 'qa_evidence', digest)).toBe(
      `tenants/tenant_1/jobs/job_abc/executions/exec_1/revisions/4/${'b'.repeat(64)}/qa.json`,
    );
  });

  it('binds dependency cache to lockfile, platform, ABI and toolchain', () => {
    const key = dependencyCacheKey({
      lockfileDigest: `sha256:${'a'.repeat(64)}`, os: 'linux', arch: 'x64', nodeAbi: '127',
      toolchainDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(key).toContain('/linux/x64/abi-127/');
    expect(key).toContain('a'.repeat(64));
    expect(key).toContain('b'.repeat(64));
  });
});
