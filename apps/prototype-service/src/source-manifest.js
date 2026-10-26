import { createHash } from 'node:crypto';
import path from 'node:path';
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
export const SOURCE_LIMITS = Object.freeze({
  maxFiles: 500,
  maxFileBytes: 256 * 1024,
  maxSourceBytes: 5 * 1024 * 1024,
  maxArchiveBytes: 5 * 1024 * 1024,
  maxExpandedBytes: 20 * 1024 * 1024,
  maxHtmlBytes: 3 * 1024 * 1024,
});
export const SOURCE_PROFILES = Object.freeze({
  baseline: 'react-source-v1',
  fsd: 'react-fsd-source-v1',
});
function reject() {
  throw new Error('PROTOTYPE_SOURCE_MANIFEST_INVALID');
}
function exact(value, keys) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    reject();
}
export function validateSourcePath(value) {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    value !== value.normalize('NFC') ||
    !/^src\/(?:app|pages|widgets|features|entities|shared)\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|css)$/.test(
      value,
    ) ||
    value.includes('\\') ||
    value.includes('//') ||
    value.split('/').some((part) => part === '..' || part === '.' || part.startsWith('.')) ||
    path.posix.normalize(value) !== value
  )
    reject();
  return value;
}
export function sourceBytes(content) {
  if (typeof content !== 'string' || !content.length || content.includes('\0')) reject();
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.toString('utf8') !== content) reject();
  return bytes;
}
const payload = (value) => ({
  schemaVersion: value.schemaVersion,
  profile: value.profile,
  modelId: value.modelId,
  engineId: value.engineId,
  revision: value.revision,
  rulesDigest: value.rulesDigest,
  templateDigest: value.templateDigest,
  toolchainDigest: value.toolchainDigest,
  files: value.files,
  totalBytes: value.totalBytes,
});
export function validateSourceManifest(value) {
  exact(value, [
    'schemaVersion',
    'profile',
    'engineId',
    'modelId',
    'revision',
    'rulesDigest',
    'templateDigest',
    'toolchainDigest',
    'files',
    'totalBytes',
    'digest',
  ]);
  if (
    value.schemaVersion !== 1 ||
    !Object.values(SOURCE_PROFILES).includes(value.profile) ||
    !['direct-react-v1', 'opencode-fsd-v1'].includes(value.engineId) ||
    typeof value.modelId !== 'string' ||
    !value.modelId.trim() ||
    value.modelId.length > 256 ||
    (value.profile === SOURCE_PROFILES.baseline) !== (value.engineId === 'direct-react-v1') ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    ![value.rulesDigest, value.templateDigest, value.toolchainDigest, value.digest].every((v) =>
      digestPattern.test(v),
    ) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > SOURCE_LIMITS.maxFiles
  )
    reject();
  let size = 0;
  let previous = '';
  for (const file of value.files) {
    exact(file, ['path', 'bytes', 'digest']);
    validateSourcePath(file.path);
    if (
      file.path <= previous ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > SOURCE_LIMITS.maxFileBytes ||
      !digestPattern.test(file.digest)
    )
      reject();
    previous = file.path;
    size += file.bytes;
  }
  if (
    size > SOURCE_LIMITS.maxSourceBytes ||
    value.totalBytes !== size ||
    hash(JSON.stringify(payload(value))) !== value.digest ||
    (value.profile === SOURCE_PROFILES.baseline &&
      (value.files.length !== 1 || value.files[0].path !== 'src/app/App.tsx'))
  )
    reject();
  return value;
}
export function createSourceManifest(sources, metadata) {
  const files = Object.entries(sources)
    .map(([name, source]) => {
      validateSourcePath(name);
      const bytes = sourceBytes(source);
      return { path: name, bytes: bytes.length, digest: hash(bytes) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const value = {
    schemaVersion: 1,
    ...metadata,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
  value.digest = hash(JSON.stringify(payload(value)));
  return validateSourceManifest(value);
}
export function verifySourceManifest(manifest, sources) {
  validateSourceManifest(manifest);
  if (Object.keys(sources).sort().join('\0') !== manifest.files.map((file) => file.path).join('\0'))
    reject();
  for (const file of manifest.files) {
    const bytes = sourceBytes(sources[file.path]);
    if (bytes.length !== file.bytes || hash(bytes) !== file.digest) reject();
  }
  return manifest;
}
