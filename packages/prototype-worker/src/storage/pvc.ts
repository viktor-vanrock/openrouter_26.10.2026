import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { artifactKey, checkpointKey } from './keys';
import type { PrototypeStorage, StoredObject } from './types';

const execFileAsync = promisify(execFile);

function resolvedBelow(root: string, key: string): string {
  const target = path.resolve(root, key);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Storage path escapes root');
  return target;
}

async function hashFile(filename: string): Promise<{ sha256: string; size: number }> {
  const bytes = await fsp.readFile(filename);
  return {
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.byteLength,
  };
}

export class PvcPrototypeStorage implements PrototypeStorage {
  private readonly root: string;

  constructor(storageRoot: string) {
    if (!path.isAbsolute(storageRoot)) throw new Error('Storage root must be absolute');
    this.root = path.resolve(storageRoot);
  }

  private async publish(source: string, objectKey: string, expectedSha256: string): Promise<StoredObject> {
    const destination = resolvedBelow(this.root, objectKey);
    const directory = path.dirname(destination);
    const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
    await fsp.mkdir(directory, { recursive: true });
    try {
      await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
      const handle = await fsp.open(temporary, 'r');
      await handle.sync();
      await handle.close();
      const digest = await hashFile(temporary);
      if (digest.sha256 !== expectedSha256) throw new Error('SHA-256 digest mismatch');
      try {
        await fsp.stat(destination);
        const existing = await hashFile(destination);
        if (existing.sha256 === digest.sha256 && existing.size === digest.size) {
          await fsp.rm(temporary, { force: true });
          return { objectKey, ...existing };
        }
        throw new Error(`Prototype object already exists: ${objectKey}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fsp.rename(temporary, destination);
      const dir = await fsp.open(directory, 'r');
      await dir.sync();
      await dir.close();
      return { objectKey, ...digest };
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      throw error;
    }
  }

  async saveCheckpoint(input: { jobId: string; revision: number; source: string; sha256: string }) {
    return this.publish(input.source, checkpointKey(input.jobId, input.revision), input.sha256);
  }

  async saveArtifact(input: {
    jobId: string;
    revision: number;
    kind: 'html' | 'sources_zip';
    source: string;
    sha256: string;
  }) {
    return this.publish(
      input.source,
      artifactKey(input.jobId, input.revision, input.kind),
      input.sha256,
    );
  }

  async openObject(objectKey: string): Promise<NodeJS.ReadableStream> {
    const valid =
      /^jobs\/job_[a-zA-Z0-9_-]+\/checkpoints\/\d+\/workspace\.tar\.zst$/.test(objectKey) ||
      /^jobs\/job_[a-zA-Z0-9_-]+\/artifacts\/\d+\/(preview\.html|sources\.zip)$/.test(objectKey);
    if (!valid) {
      throw new Error('Invalid object key');
    }
    return fs.createReadStream(resolvedBelow(this.root, objectKey));
  }

  async restoreWorkspace(input: {
    jobId: string;
    checkpointRevision: number;
    destination: string;
  }): Promise<void> {
    const key = checkpointKey(input.jobId, input.checkpointRevision);
    const archive = resolvedBelow(this.root, key);
    const destination = path.resolve(input.destination);
    try {
      await fsp.mkdir(destination, { recursive: false });
    } catch (error) {
      throw new Error(`Restore destination must be newly created: ${(error as Error).message}`);
    }

    try {
      const { stdout } = await execFileAsync('tar', ['--zstd', '-tvf', archive]);
      for (const line of stdout.split('\n').filter(Boolean)) {
        const type = line[0];
        const name = line.trim().split(/\s+/).at(-1) ?? '';
        if ((type !== '-' && type !== 'd') || path.isAbsolute(name) || name.split('/').includes('..')) {
          throw new Error('Checkpoint archive contains an unsafe entry');
        }
      }
      await execFileAsync('tar', ['--zstd', '-xf', archive, '-C', destination]);
    } catch (error) {
      await fsp.rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}
