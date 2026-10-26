import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

export async function readBuiltPreview(workspace: string): Promise<Buffer> {
  return fs.readFile(path.join(workspace, 'dist', 'index.html'));
}

export async function buildSourcesArchive(
  workspace: string,
  options: { includeDependenciesOnly?: boolean } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  const excluded = new Set(['node_modules', 'dist', 'export', '.git', '.cache', 'coverage', '.npmrc', '.env', '.opencode']);
  async function addDirectory(directory: string, prefix = ''): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink() || (!options.includeDependenciesOnly && (excluded.has(entry.name) ||
          entry.name.startsWith('.env.') || entry.name.endsWith('.tsbuildinfo') || /^opencode\.jsonc?$/.test(entry.name)))) {
        continue;
      }
      if (options.includeDependenciesOnly && !prefix && entry.name !== 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      const logical = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await addDirectory(absolute, logical);
      else if (entry.isFile()) zip.file(logical, await fs.readFile(absolute), { date: new Date(0) });
    }
  }
  await addDirectory(workspace);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

export function artifactDigest(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export type VerifiedArtifactSnapshot = {
  html: Buffer;
  sourcesZip: Buffer;
  qaEvidence: Buffer;
  digests: { html: `sha256:${string}`; sourcesZip: `sha256:${string}`; qaEvidence: `sha256:${string}` };
};

export async function createVerifiedArtifactSnapshot(input: {
  workspace: string;
  qaEvidence: Record<string, unknown>;
  templateDigest: `sha256:${string}`;
  toolchainDigest: `sha256:${string}`;
}): Promise<VerifiedArtifactSnapshot> {
  const html = await readBuiltPreview(input.workspace);
  const sourcesZip = await buildSourcesArchive(input.workspace);
  const evidenceValue = {
    ...input.qaEvidence,
    htmlDigest: artifactDigest(html), sourcesDigest: artifactDigest(sourcesZip),
    templateDigest: input.templateDigest, toolchainDigest: input.toolchainDigest,
  };
  const qaEvidence = Buffer.from(`${JSON.stringify(evidenceValue)}\n`);
  return { html, sourcesZip, qaEvidence, digests: {
    html: artifactDigest(html), sourcesZip: artifactDigest(sourcesZip), qaEvidence: artifactDigest(qaEvidence),
  } };
}

export async function buildCheckpointArchive(workspace: string, destination: string): Promise<void> {
  const excluded = new Set(['node_modules', 'dist', 'sources.zip', 'checkpoint.tar.zst']);
  async function normalizeTimestamps(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      // Dependencies may be an immutable read-only image/volume mount. They are
      // excluded from the checkpoint, so never traverse or change them here.
      if (directory === workspace && excluded.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await normalizeTimestamps(absolute);
      await fs.utimes(absolute, 0, 0);
    }
  }
  await normalizeTimestamps(workspace);
  await fs.utimes(workspace, 0, 0);
  const ownership = process.platform === 'darwin'
    ? ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root']
    : ['--owner=0', '--group=0', '--numeric-owner'];
  await execFileAsync('tar', [
    '--zstd',
    ...ownership,
    '-cf',
    destination,
    '--exclude=./node_modules',
    '--exclude=./dist',
    '--exclude=./sources.zip',
    '--exclude=./checkpoint.tar.zst',
    '-C',
    workspace,
    '.',
  ], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
}
