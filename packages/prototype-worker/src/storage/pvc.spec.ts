import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PvcPrototypeStorage } from './pvc';

const sha256 = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');

describe('PvcPrototypeStorage', () => {
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pvc-'));
    source = path.join(root, 'input.bin');
    await fs.writeFile(source, Buffer.from('artifact bytes'));
  });

  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  it('publishes an artifact atomically at a fixed traversal-safe key', async () => {
    const storage = new PvcPrototypeStorage(root);
    const bytes = Buffer.from('artifact bytes');
    const result = await storage.saveArtifact({
      jobId: 'job_abc',
      revision: 1,
      kind: 'html',
      source,
      sha256: sha256(bytes),
    });

    expect(result.objectKey).toBe('jobs/job_abc/artifacts/1/preview.html');
    expect(await fs.readFile(path.join(root, result.objectKey))).toEqual(bytes);
  });

  it('does not replace an already published immutable artifact', async () => {
    const storage = new PvcPrototypeStorage(root);
    const original = Buffer.from('artifact bytes');
    await storage.saveArtifact({ jobId: 'job_abc', revision: 1, kind: 'html', source, sha256: sha256(original) });
    await fs.writeFile(source, 'replacement');
    await expect(storage.saveArtifact({
      jobId: 'job_abc', revision: 1, kind: 'html', source,
      sha256: sha256(Buffer.from('replacement')),
    })).rejects.toThrow('already exists');
    expect(await fs.readFile(path.join(root, 'jobs/job_abc/artifacts/1/preview.html'))).toEqual(original);
  });

  it('returns the existing object for an idempotent publication of identical bytes', async () => {
    const storage = new PvcPrototypeStorage(root);
    const expected = { jobId: 'job_abc', revision: 1, kind: 'html' as const, source, sha256: sha256(Buffer.from('artifact bytes')) };
    const first = await storage.saveArtifact(expected);
    await expect(storage.saveArtifact(expected)).resolves.toEqual(first);
  });

  it.each(['../escape', 'job/a', '/absolute', 'job_'])('rejects unsafe job ID %s', async (jobId) => {
    const storage = new PvcPrototypeStorage(root);
    await expect(
      storage.saveArtifact({ jobId, revision: 1, kind: 'html', source, sha256: sha256(Buffer.from('artifact bytes')) }),
    ).rejects.toThrow();
  });

  it('removes the temporary object and leaves no final object on digest failure', async () => {
    const storage = new PvcPrototypeStorage(root);
    await expect(
      storage.saveArtifact({ jobId: 'job_abc', revision: 1, kind: 'html', source, sha256: '0'.repeat(64) }),
    ).rejects.toThrow('SHA-256');
    await expect(fs.stat(path.join(root, 'jobs/job_abc/artifacts/1/preview.html'))).rejects.toThrow();
    const directory = path.join(root, 'jobs/job_abc/artifacts/1');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('uses the fixed checkpoint key and rejects invalid revisions', async () => {
    const storage = new PvcPrototypeStorage(root);
    const result = await storage.saveCheckpoint({
      jobId: 'job_abc',
      revision: 1,
      source,
      sha256: sha256(Buffer.from('artifact bytes')),
    });
    expect(result.objectKey).toBe('jobs/job_abc/checkpoints/1/workspace.tar.zst');
    await expect(
      storage.saveCheckpoint({
        jobId: 'job_abc',
        revision: -1,
        source,
        sha256: sha256(Buffer.from('artifact bytes')),
      }),
    ).rejects.toThrow();
  });

  it('restores a validated checkpoint archive into a newly created destination', async () => {
    const workspace = path.join(root, 'workspace');
    const archive = path.join(root, 'checkpoint.tar.zst');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'index.html'), '<h1>safe</h1>');
    execFileSync('tar', ['--zstd', '-cf', archive, '-C', workspace, '.']);
    const bytes = await fs.readFile(archive);
    const storage = new PvcPrototypeStorage(root);
    await storage.saveCheckpoint({ jobId: 'job_abc', revision: 2, source: archive, sha256: sha256(bytes) });

    const destination = path.join(root, 'restored');
    await storage.restoreWorkspace({ jobId: 'job_abc', checkpointRevision: 2, destination });
    expect(await fs.readFile(path.join(destination, 'index.html'), 'utf8')).toBe('<h1>safe</h1>');
  });

  it('rejects checkpoint archives containing symbolic links', async () => {
    const workspace = path.join(root, 'unsafe-workspace');
    const archive = path.join(root, 'unsafe.tar.zst');
    await fs.mkdir(workspace);
    await fs.symlink('/etc/passwd', path.join(workspace, 'escape-link'));
    execFileSync('tar', ['--zstd', '-cf', archive, '-C', workspace, '.']);
    const bytes = await fs.readFile(archive);
    const storage = new PvcPrototypeStorage(root);
    await storage.saveCheckpoint({ jobId: 'job_abc', revision: 3, source: archive, sha256: sha256(bytes) });
    await expect(
      storage.restoreWorkspace({
        jobId: 'job_abc', checkpointRevision: 3, destination: path.join(root, 'unsafe-restored'),
      }),
    ).rejects.toThrow('unsafe entry');
  });

  it('rejects opening object keys that are not exact fixed storage keys', async () => {
    const storage = new PvcPrototypeStorage(root);
    await expect(storage.openObject('jobs/job_abc/artifacts/1/../../secret')).rejects.toThrow();
    await expect(storage.openObject('jobs/job_abc/artifacts/1/custom.html')).rejects.toThrow();
  });
});
