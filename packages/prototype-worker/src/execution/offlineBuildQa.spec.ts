import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfflineBuildQaRunner, RepairCoordinator } from './offlineBuildQa';

const hash = `sha256:${'a'.repeat(64)}` as const;

describe('OfflineBuildQaRunner', () => {
  it('build-only runs all compiler checks and archives the project without invoking browser scenarios', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-build-only-'));
    await fs.mkdir(path.join(root, 'dist'));
    await fs.writeFile(path.join(root, 'dist/index.html'), '<main>Compiled React</main>');
    const run = jest.fn(async () => ({ stdout: '', stderr: '' }));
    const browserQa = jest.fn();
    try {
      const result = await new OfflineBuildQaRunner(run as never, browserQa)
        .execute({ workspace: root, timeoutMs: 1_000, templateDigest: hash,
          toolchainDigest: hash, validation: 'build-only' });
      expect(run.mock.calls.map((call) => call[1])).toEqual([['run', 'type-check'], ['run', 'lint'], ['run', 'build']]);
      expect(browserQa).not.toHaveBeenCalled();
      expect(JSON.parse(result.qaEvidence.toString())).toMatchObject({
        passed: true, validation: 'build-only', browserQaPerformed: false,
        checks: ['type-check', 'lint', 'build'], htmlDigest: result.digests.html,
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it('runs type/lint/build offline and emits digest-bound QA evidence from the same HTML snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-offline-'));
    await fs.mkdir(path.join(root, 'dist')); await fs.writeFile(path.join(root, 'dist/index.html'), '<main>safe</main>');
    const run = jest.fn(async () => ({ stdout: '', stderr: '' }));
    try {
      const result = await new OfflineBuildQaRunner(run as never, async ({ sandbox }) => ({ checks: [String(sandbox)], consoleErrors: [], networkRequests: [] }))
        .execute({ workspace: root, timeoutMs: 1_000, templateDigest: hash, toolchainDigest: hash });
      expect(run.mock.calls.map((call) => call[1])).toEqual([['run', 'type-check'], ['run', 'lint'], ['run', 'build']]);
      expect(run.mock.calls[0][2].env).toMatchObject({ npm_config_offline: 'true', HTTPS_PROXY: 'http://127.0.0.1:9' });
      expect(JSON.parse(result.qaEvidence.toString()).htmlDigest).toBe(result.digests.html);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('rejects network references before browser QA', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-offline-'));
    await fs.mkdir(path.join(root, 'dist')); await fs.writeFile(path.join(root, 'dist/index.html'), '<script src="https://evil.test/a.js"></script>');
    try { await expect(new OfflineBuildQaRunner(jest.fn(async () => ({})) as never).execute({ workspace: root, timeoutMs: 1_000, templateDigest: hash, toolchainDigest: hash })).rejects.toThrow('NETWORK_REFERENCE'); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('RepairCoordinator', () => {
  it('requires new identities and allows at most two repairs', () => {
    const repair = new RepairCoordinator(2); let index = 0;
    expect(repair.next({ previousAttemptId: 'attempt_0', diagnostics: ['safe'] }, () => ({ attemptId: `attempt_${++index}`, executionId: `exec_${index}` }))).toMatchObject({ repairOrdinal: 1 });
    expect(repair.next({ previousAttemptId: 'attempt_1', diagnostics: ['safe'] }, () => ({ attemptId: `attempt_${++index}`, executionId: `exec_${index}` }))).toMatchObject({ repairOrdinal: 2 });
    expect(() => repair.next({ previousAttemptId: 'attempt_2', diagnostics: [] }, () => ({ attemptId: 'attempt_3', executionId: 'exec_3' }))).toThrow('REPAIR_LIMIT');
  });
});
