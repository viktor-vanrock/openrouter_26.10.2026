import path from 'node:path';
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import * as zlib from 'node:zlib';

export type ArchiveLimits = {
  maxArchiveBytes: number;
  maxExpandedBytes: number;
  maxFiles: number;
  maxPathBytes: number;
  maxCompressionRatio: number;
  maxDurationMs?: number;
};

export type ArchiveEntryDescriptor = {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'character' | 'block' | 'fifo' | 'socket';
  compressedBytes: number;
  expandedBytes: number;
};

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

export function validateArchiveLimits(limits: ArchiveLimits): void {
  assertPositiveInteger(limits.maxArchiveBytes, 'maxArchiveBytes');
  assertPositiveInteger(limits.maxExpandedBytes, 'maxExpandedBytes');
  assertPositiveInteger(limits.maxFiles, 'maxFiles');
  assertPositiveInteger(limits.maxPathBytes, 'maxPathBytes');
  if (!Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio < 1) {
    throw new Error('maxCompressionRatio must be finite and at least one');
  }
  if (limits.maxDurationMs !== undefined) assertPositiveInteger(limits.maxDurationMs, 'maxDurationMs');
}

export function inspectArchiveEntries(entries: ArchiveEntryDescriptor[], limits: ArchiveLimits): {
  files: number;
  expandedBytes: number;
} {
  validateArchiveLimits(limits);
  let files = 0;
  let expandedBytes = 0;
  let compressedBytes = 0;
  for (const entry of entries) {
    validateArchivePath(entry.name, limits.maxPathBytes);
    if (!['file', 'directory'].includes(entry.type)) throw new Error('PROTOTYPE_ARCHIVE_ENTRY_TYPE_REJECTED');
    if (entry.type === 'directory') continue;
    files += 1;
    expandedBytes += entry.expandedBytes;
    compressedBytes += entry.compressedBytes;
    if (files > limits.maxFiles) throw new Error('PROTOTYPE_ARCHIVE_FILE_LIMIT');
    if (expandedBytes > limits.maxExpandedBytes) throw new Error('PROTOTYPE_ARCHIVE_EXPANDED_LIMIT');
  }
  if (expandedBytes / Math.max(compressedBytes, 1) > limits.maxCompressionRatio) throw new Error('PROTOTYPE_ARCHIVE_RATIO_LIMIT');
  return { files, expandedBytes };
}

async function withTimeout<T>(operation: Promise<T>, maxDurationMs = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PROTOTYPE_ARCHIVE_TIMEOUT')), maxDurationMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function validateArchivePath(name: string, maxPathBytes: number): void {
  const normalized = name.replaceAll('\\', '/');
  if (
    !name || name.includes('\0') || name.includes('\\') || name !== name.normalize('NFC') ||
    Buffer.byteLength(normalized) > maxPathBytes ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some((part) => part === '..') ||
    path.posix.normalize(normalized) !== normalized.replace(/^\.\//, '')
  ) throw new Error('PROTOTYPE_ARCHIVE_PATH_REJECTED');
}

/** Inspect the central directory before JSZip normalizes names or inflates CRC data.
 * This source profile excludes ZIP64/multi-disk/encrypted archives.
 */
function inspectZipDirectory(buffer: Buffer, limits: ArchiveLimits): void {
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset; break;
    }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 ||
      buffer.readUInt16LE(end + 8) !== buffer.readUInt16LE(end + 10)) throw new Error('PROTOTYPE_ARCHIVE_ZIP_INVALID');
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), start = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || start + size !== end || count > limits.maxFiles * 8 + 16) throw new Error('PROTOTYPE_ARCHIVE_ZIP_INVALID');
  const names = new Set<string>(), entries: ArchiveEntryDescriptor[] = [];
  let cursor = start, files = 0, totalExpanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('PROTOTYPE_ARCHIVE_ZIP_INVALID');
    const flags = buffer.readUInt16LE(cursor + 8), compression = buffer.readUInt16LE(cursor + 10);
    const compressedBytes = buffer.readUInt32LE(cursor + 20), expandedBytes = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(compression) || compressedBytes === 0xffffffff || expandedBytes === 0xffffffff) {
      throw new Error('PROTOTYPE_ARCHIVE_ZIP_INVALID');
    }
    const bytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength), name = bytes.toString('utf8');
    if (!Buffer.from(name).equals(bytes)) throw new Error('PROTOTYPE_ARCHIVE_PATH_REJECTED');
    validateArchivePath(name, limits.maxPathBytes);
    const normalized = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (names.has(normalized)) throw new Error('PROTOTYPE_ARCHIVE_DUPLICATE_PATH');
    names.add(normalized);
    const unixType = (buffer.readUInt32LE(cursor + 38) >>> 16) & 0o170000;
    if (![0, 0o100000, 0o040000].includes(unixType)) throw new Error('PROTOTYPE_ARCHIVE_ENTRY_TYPE_REJECTED');
    const local = buffer.readUInt32LE(cursor + 42);
    if (local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50 ||
        buffer.readUInt16LE(local + 26) !== nameLength ||
        !buffer.subarray(local + 30, local + 30 + nameLength).equals(bytes)) throw new Error('PROTOTYPE_ARCHIVE_ZIP_INVALID');
    const dataStart = local + 30 + nameLength + buffer.readUInt16LE(local + 28);
    if (!name.endsWith('/')) {
      files++; totalExpanded += expandedBytes;
      if (files > limits.maxFiles) throw new Error('PROTOTYPE_ARCHIVE_FILE_LIMIT');
      if (totalExpanded > limits.maxExpandedBytes) throw new Error('PROTOTYPE_ARCHIVE_EXPANDED_LIMIT');
    }
    if (dataStart + compressedBytes > start || expandedBytes > limits.maxExpandedBytes ||
        (name.endsWith('/') && (expandedBytes !== 0 || compressedBytes !== 0))) throw new Error('PROTOTYPE_ARCHIVE_EXPANDED_LIMIT');
    const content = buffer.subarray(dataStart, dataStart + compressedBytes);
    const actual = compression === 0 ? content : zlib.inflateRawSync(content, { maxOutputLength: Math.max(1, expandedBytes) });
    if (actual.length !== expandedBytes) throw new Error('PROTOTYPE_ARCHIVE_ZIP_INVALID');
    entries.push({ name, type: name.endsWith('/') ? 'directory' : 'file', compressedBytes, expandedBytes });
    cursor = next;
  }
  if (cursor !== end) throw new Error('PROTOTYPE_ARCHIVE_ZIP_INVALID');
  inspectArchiveEntries(entries, limits);
}

export async function inspectZipArchive(buffer: Buffer, limits: ArchiveLimits): Promise<{
  files: number;
  expandedBytes: number;
}> {
  validateArchiveLimits(limits);
  if (buffer.length > limits.maxArchiveBytes) throw new Error('PROTOTYPE_ARCHIVE_TOO_LARGE');
  inspectZipDirectory(buffer, limits);
  return withTimeout(inspectZipArchiveUnbounded(buffer, limits), limits.maxDurationMs);
}

async function inspectZipArchiveUnbounded(buffer: Buffer, limits: ArchiveLimits): Promise<{ files: number; expandedBytes: number }> {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  let files = 0;
  let expandedBytes = 0;
  for (const entry of Object.values(zip.files)) {
    validateArchivePath(entry.name, limits.maxPathBytes);
    const unixPermissions = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
    const type = unixPermissions & 0o170000;
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new Error('PROTOTYPE_ARCHIVE_ENTRY_TYPE_REJECTED');
    if (entry.dir) continue;
    files += 1;
    if (files > limits.maxFiles) throw new Error('PROTOTYPE_ARCHIVE_FILE_LIMIT');
    const contents = await entry.async('uint8array');
    expandedBytes += contents.byteLength;
    if (expandedBytes > limits.maxExpandedBytes) throw new Error('PROTOTYPE_ARCHIVE_EXPANDED_LIMIT');
  }
  const ratio = expandedBytes / Math.max(buffer.length, 1);
  if (ratio > limits.maxCompressionRatio) throw new Error('PROTOTYPE_ARCHIVE_RATIO_LIMIT');
  return { files, expandedBytes };
}

export async function extractZipArchive(buffer: Buffer, destination: string, limits: ArchiveLimits): Promise<void> {
  await inspectZipArchive(buffer, limits);
  const root = path.resolve(destination);
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  await withTimeout((async () => {
    for (const entry of Object.values(zip.files)) {
      validateArchivePath(entry.name, limits.maxPathBytes);
      const target = path.resolve(root, entry.name);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('PROTOTYPE_ARCHIVE_PATH_REJECTED');
      if (entry.dir) await fs.mkdir(target, { recursive: true });
      else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, await entry.async('nodebuffer'), { flag: 'wx', mode: 0o600 });
      }
    }
  })(), limits.maxDurationMs);
}

type ParsedTarEntry = ArchiveEntryDescriptor & { offset: number; mode: number };

function tarString(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start);
  return block.subarray(start, end >= start && end < start + length ? end : start + length).toString('utf8');
}

function tarOctal(block: Buffer, start: number, length: number): number {
  const value = tarString(block, start, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('PROTOTYPE_ARCHIVE_TAR_HEADER_REJECTED');
  return value ? Number.parseInt(value, 8) : 0;
}

function verifyTarChecksum(block: Buffer): void {
  const expected = tarOctal(block, 148, 8);
  let actual = 0;
  for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 32 : block[index];
  if (actual !== expected) throw new Error('PROTOTYPE_ARCHIVE_TAR_CHECKSUM_REJECTED');
}

function parseTar(buffer: Buffer, limits: ArchiveLimits): ParsedTarEntry[] {
  const entries: ParsedTarEntry[] = [];
  let offset = 0;
  let pax: Record<string, string> = {};
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    verifyTarChecksum(header);
    const shortName = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const headerName = prefix ? `${prefix}/${shortName}` : shortName;
    const headerSize = tarOctal(header, 124, 12);
    const mode = tarOctal(header, 100, 8);
    const flag = String.fromCharCode(header[156] || 48);
    const dataOffset = offset + 512;
    const nextOffset = dataOffset + Math.ceil(headerSize / 512) * 512;
    if (nextOffset > buffer.length) throw new Error('PROTOTYPE_ARCHIVE_TAR_TRUNCATED');
    if (flag === 'x') {
      const contents = buffer.subarray(dataOffset, dataOffset + headerSize);
      const parsed: Record<string, string> = {};
      let cursor = 0;
      while (cursor < contents.length) {
        const separator = contents.indexOf(32, cursor);
        if (separator < 0) throw new Error('PROTOTYPE_ARCHIVE_TAR_HEADER_REJECTED');
        const length = Number(contents.subarray(cursor, separator).toString('ascii'));
        if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > contents.length) throw new Error('PROTOTYPE_ARCHIVE_TAR_HEADER_REJECTED');
        const record = contents.subarray(separator + 1, cursor + length - 1);
        const equals = record.indexOf(61);
        if (equals <= 0) throw new Error('PROTOTYPE_ARCHIVE_TAR_HEADER_REJECTED');
        parsed[record.subarray(0, equals).toString('ascii')] = record.subarray(equals + 1).toString('utf8');
        cursor += length;
      }
      pax = parsed;
      offset = nextOffset;
      continue;
    }
    if (flag === 'g') throw new Error('PROTOTYPE_ARCHIVE_TAR_HEADER_REJECTED');
    const name = pax.path ?? headerName;
    const size = pax.size !== undefined && /^\d+$/.test(pax.size) ? Number(pax.size) : headerSize;
    if (!Number.isSafeInteger(size) || size < 0 || size !== headerSize) throw new Error('PROTOTYPE_ARCHIVE_TAR_HEADER_REJECTED');
    const type: ArchiveEntryDescriptor['type'] = ({
      '0': 'file', '\0': 'file', '5': 'directory', '1': 'hardlink', '2': 'symlink',
      '3': 'character', '4': 'block', '6': 'fifo', '7': 'file',
    } as Record<string, ArchiveEntryDescriptor['type']>)[flag] ?? 'socket';
    if (type === 'directory' && (name === '.' || name === './')) {
      pax = {};
      offset = nextOffset;
      continue;
    }
    entries.push({ name, type, compressedBytes: Math.max(1, size), expandedBytes: size, offset: dataOffset, mode });
    pax = {};
    offset = nextOffset;
  }
  inspectArchiveEntries(entries, limits);
  return entries;
}

async function decompressZstdBounded(buffer: Buffer, limits: ArchiveLimits): Promise<Buffer> {
  if (buffer.length > limits.maxArchiveBytes) throw new Error('PROTOTYPE_ARCHIVE_TOO_LARGE');
  return withTimeout(new Promise<Buffer>((resolve, reject) => {
    const decompress = (zlib as unknown as { zstdDecompress: (
      input: Buffer,
      options: { maxOutputLength: number },
      callback: (error: Error | null, value: Buffer) => void,
    ) => void }).zstdDecompress;
    if (typeof decompress !== 'function') return reject(new Error('PROTOTYPE_ARCHIVE_ZSTD_UNAVAILABLE'));
    decompress(buffer, { maxOutputLength: limits.maxExpandedBytes + limits.maxFiles * 1_024 }, (error, value) => {
      if (error) reject(new Error('PROTOTYPE_ARCHIVE_EXPANDED_LIMIT'));
      else resolve(value);
    });
  }), limits.maxDurationMs);
}

export async function inspectTarZstdArchive(buffer: Buffer, limits: ArchiveLimits): Promise<{
  files: number;
  expandedBytes: number;
}> {
  const tar = await decompressZstdBounded(buffer, limits);
  const entries = parseTar(tar, limits);
  const expandedBytes = entries.reduce((total, entry) => total + (entry.type === 'file' ? entry.expandedBytes : 0), 0);
  if (expandedBytes / Math.max(buffer.length, 1) > limits.maxCompressionRatio) throw new Error('PROTOTYPE_ARCHIVE_RATIO_LIMIT');
  return {
    files: entries.filter((entry) => entry.type === 'file').length,
    expandedBytes,
  };
}

export async function extractTarZstdArchive(buffer: Buffer, destination: string, limits: ArchiveLimits): Promise<void> {
  const tar = await decompressZstdBounded(buffer, limits);
  const entries = parseTar(tar, limits);
  const expandedBytes = entries.reduce((total, entry) => total + (entry.type === 'file' ? entry.expandedBytes : 0), 0);
  if (expandedBytes / Math.max(buffer.length, 1) > limits.maxCompressionRatio) throw new Error('PROTOTYPE_ARCHIVE_RATIO_LIMIT');
  const root = path.resolve(destination);
  await withTimeout((async () => {
    for (const entry of entries) {
      const target = path.resolve(root, entry.name);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('PROTOTYPE_ARCHIVE_PATH_REJECTED');
      if (entry.type === 'directory') await fs.mkdir(target, { recursive: true, mode: 0o700 });
      else {
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, tar.subarray(entry.offset, entry.offset + entry.expandedBytes), { flag: 'wx', mode: 0o600 });
      }
    }
  })(), limits.maxDurationMs);
}
