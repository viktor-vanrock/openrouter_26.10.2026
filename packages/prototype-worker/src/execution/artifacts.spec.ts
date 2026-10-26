import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { buildCheckpointArchive, buildSourcesArchive, readBuiltPreview } from './artifacts';

describe('local prototype artifacts', () => {
  it('reads the built HTML and creates a deterministic source archive without dependencies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-artifacts-'));
    try {
      await fs.mkdir(path.join(root, 'dist'));
      await fs.mkdir(path.join(root, 'src'));
      await fs.mkdir(path.join(root, 'node_modules'));
      await fs.writeFile(path.join(root, 'dist/index.html'), '<main>preview</main>');
      await fs.writeFile(path.join(root, 'src/app.ts'), 'export const app = true;');
      await fs.writeFile(path.join(root, 'node_modules/secret.js'), 'excluded');
      for (const name of ['.env', '.env.local', '.npmrc', 'tsconfig.tsbuildinfo', 'opencode.json']) {
        await fs.writeFile(path.join(root, name), 'excluded-private-or-cache');
      }

      expect(await readBuiltPreview(root)).toEqual(Buffer.from('<main>preview</main>'));
      const archive = await buildSourcesArchive(root);
      const zip = await JSZip.loadAsync(archive);
      expect(Object.keys(zip.files)).toContain('src/app.ts');
      expect(Object.keys(zip.files)).not.toContain('node_modules/secret.js');
      expect(Object.keys(zip.files)).not.toContain('dist/index.html');
      for (const name of ['.env', '.env.local', '.npmrc', 'tsconfig.tsbuildinfo', 'opencode.json']) expect(zip.file(name)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('creates identical checkpoints for identical workspace contents with different timestamps', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-checkpoint-'));
    try {
      const workspace = path.join(root, 'workspace');
      const first = path.join(root, 'first.tar.zst');
      const second = path.join(root, 'second.tar.zst');
      await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
      await fs.writeFile(path.join(workspace, 'src/app.ts'), 'export const app = true;');

      await buildCheckpointArchive(workspace, first);
      await fs.utimes(path.join(workspace, 'src/app.ts'), new Date('2026-09-11T10:00:00Z'), new Date('2026-09-11T10:00:00Z'));
      await fs.utimes(path.join(workspace, 'src'), new Date('2026-09-11T10:00:00Z'), new Date('2026-09-11T10:00:00Z'));
      await buildCheckpointArchive(workspace, second);

      expect(await fs.readFile(second)).toEqual(await fs.readFile(first));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not traverse or change excluded dependency and build directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-checkpoint-mounts-'));
    const workspace = path.join(root, 'workspace');
    const sentinel = new Date('2026-09-11T10:00:00Z');
    try {
      for (const name of ['node_modules', 'dist']) {
        await fs.mkdir(path.join(workspace, name), { recursive: true });
        await fs.writeFile(path.join(workspace, name, 'unchanged.txt'), 'excluded');
        await fs.utimes(path.join(workspace, name, 'unchanged.txt'), sentinel, sentinel);
      }
      await fs.writeFile(path.join(workspace, 'source.txt'), 'source');
      await buildCheckpointArchive(workspace, path.join(root, 'checkpoint.tar.zst'));
      for (const name of ['node_modules', 'dist']) {
        expect((await fs.stat(path.join(workspace, name, 'unchanged.txt'))).mtime.getTime()).toBe(sentinel.getTime());
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
