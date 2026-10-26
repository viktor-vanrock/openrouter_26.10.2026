import JSZip from 'jszip';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  extractTarZstdArchive, inspectArchiveEntries, inspectTarZstdArchive,
  inspectZipArchive, validateArchivePath,
} from './archivePolicy';

const exec = promisify(execFile);

const limits = {
  maxArchiveBytes: 10_000,
  maxExpandedBytes: 1_000,
  maxFiles: 3,
  maxPathBytes: 100,
  maxCompressionRatio: 100,
};

describe('archive policy', () => {
  it.each(['../secret', '/etc/passwd', 'C:/secret', 'a/../../secret'])('rejects unsafe path %s', (name) => {
    expect(() => validateArchivePath(name, 100)).toThrow('PROTOTYPE_ARCHIVE_PATH_REJECTED');
  });

  it('accepts a bounded regular-file archive', async () => {
    const zip = new JSZip();
    zip.file('src/index.ts', 'export {};');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(inspectZipArchive(buffer, limits)).resolves.toEqual({ files: 1, expandedBytes: 10 });
  });

  it('rejects original traversal names before JSZip sanitization and duplicate central-directory entries', async () => {
    const traversal = new JSZip(); traversal.file('../escape.ts', 'export {};');
    await expect(inspectZipArchive(await traversal.generateAsync({ type: 'nodebuffer' }), limits)).rejects.toThrow('PATH_REJECTED');
    const zip = new JSZip(); zip.file('a.ts', 'one'); zip.file('b.ts', 'two');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const duplicate = Buffer.from(bytes);
    for (let offset = 0; offset < duplicate.length - 4; offset++) {
      if (duplicate.subarray(offset, offset + 4).toString() === 'b.ts') duplicate[offset] = 'a'.charCodeAt(0);
    }
    await expect(inspectZipArchive(duplicate, limits)).rejects.toThrow('DUPLICATE_PATH');
  });

  it('rejects file count, expanded size, and compression-ratio bombs', async () => {
    const many = new JSZip();
    for (let index = 0; index < 4; index += 1) many.file(`${index}.txt`, 'x');
    await expect(inspectZipArchive(await many.generateAsync({ type: 'nodebuffer' }), limits))
      .rejects.toThrow('PROTOTYPE_ARCHIVE_FILE_LIMIT');

    const large = new JSZip();
    large.file('large.txt', 'x'.repeat(1_001));
    const largeBuffer = await large.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await expect(inspectZipArchive(largeBuffer, limits)).rejects.toThrow();
  });

  it.each(['symlink', 'hardlink', 'character', 'block', 'fifo', 'socket'] as const)('rejects %s entries', (type) => {
    expect(() => inspectArchiveEntries([{ name: 'unsafe', type, compressedBytes: 1, expandedBytes: 1 }], limits))
      .toThrow('PROTOTYPE_ARCHIVE_ENTRY_TYPE_REJECTED');
  });

  it('rejects manifest-level bombs before extraction', () => {
    expect(() => inspectArchiveEntries([
      { name: 'large', type: 'file', compressedBytes: 1, expandedBytes: 1_001 },
    ], limits)).toThrow('PROTOTYPE_ARCHIVE_EXPANDED_LIMIT');
  });

  it('inspects and extracts bounded tar.zst without executing archive contents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-tar-zstd-'));
    try {
      const source = path.join(root, 'source');
      const destination = path.join(root, 'destination');
      const archive = path.join(root, 'checkpoint.tar.zst');
      await fs.mkdir(path.join(source, 'src'), { recursive: true });
      await fs.writeFile(path.join(source, 'src/index.ts'), 'export {};');
      await exec('tar', ['--zstd', '-cf', archive, '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      const bytes = await fs.readFile(archive);
      const tarLimits = { ...limits, maxArchiveBytes: 100_000, maxExpandedBytes: 10_000, maxCompressionRatio: 1_000, maxDurationMs: 5_000 };
      await expect(inspectTarZstdArchive(bytes, tarLimits)).resolves.toMatchObject({ files: 1 });
      await fs.mkdir(destination);
      await extractTarZstdArchive(bytes, destination, tarLimits);
      await expect(fs.readFile(path.join(destination, 'src/index.ts'), 'utf8')).resolves.toBe('export {};');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('rejects tar.zst symlinks before extraction', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-tar-zstd-link-'));
    try {
      const source = path.join(root, 'source');
      const archive = path.join(root, 'checkpoint.tar.zst');
      await fs.mkdir(source);
      await fs.symlink('/etc/passwd', path.join(source, 'escape'));
      await exec('tar', ['--zstd', '-cf', archive, '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
      const bytes = await fs.readFile(archive);
      await expect(inspectTarZstdArchive(bytes, { ...limits, maxArchiveBytes: 100_000, maxExpandedBytes: 10_000, maxCompressionRatio: 1_000 }))
        .rejects.toThrow('ENTRY_TYPE_REJECTED');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
