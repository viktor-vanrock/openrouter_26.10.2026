import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const SEMVERISH = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_SOURCE =
  /^(?:git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|file:|link:|workspace:|https?:\/\/)/i;

function v4Number(address) {
  return address.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

export function isPublicAddress(address) {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicAddress(mapped);
  const family = net.isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const value = address.toLowerCase();
    return !(
      value === '::' ||
      value === '::1' ||
      value.startsWith('fc') ||
      value.startsWith('fd') ||
      /^fe[89ab]/.test(value) ||
      value.startsWith('ff') ||
      value.startsWith('2001:db8:') ||
      value.startsWith('2001:2:')
    );
  }
  const numeric = v4Number(address);
  return !PRIVATE_V4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (numeric & mask) === (v4Number(network) & mask);
  });
}

export function canonicalPackagePath(name) {
  if (!PACKAGE_NAME.test(name)) throw new Error('DEPENDENCY_PACKAGE_DENIED');
  return encodeURIComponent(name);
}

export function validateRegistryRequest({ method, url, allowlist, closure }) {
  if (!['GET', 'HEAD'].includes(method)) throw new Error('DEPENDENCY_METHOD_DENIED');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('DEPENDENCY_PROTOCOL_DENIED');
  if (!allowlist.includes(parsed.hostname) || net.isIP(parsed.hostname))
    throw new Error('DEPENDENCY_HOST_DENIED');
  if (parsed.username || parsed.password || parsed.port || parsed.hash || parsed.search)
    throw new Error('DEPENDENCY_AUTHORITY_DENIED');
  if (
    /\b(?:publish|unpublish)\b/i.test(parsed.pathname) ||
    /\/-\/(?:user|npm\/v1\/tokens|whoami)/i.test(parsed.pathname)
  ) {
    throw new Error('DEPENDENCY_OPERATION_DENIED');
  }
  if (
    !closure.some(
      (entry) => entry.metadataPath === parsed.pathname || entry.tarballPath === parsed.pathname,
    )
  ) {
    throw new Error('DEPENDENCY_CLOSURE_DENIED');
  }
  return parsed;
}

export async function resolvePublicRegistryHost(hostname, lookup = dns.lookup) {
  if (net.isIP(hostname)) throw new Error('DEPENDENCY_DESTINATION_DENIED');
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (
    !Array.isArray(records) ||
    records.length === 0 ||
    records.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error('DEPENDENCY_DESTINATION_DENIED');
  }
  return records;
}

export function validateLockfilePackage(entry, gatewayBaseUrl) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    typeof entry.version !== 'string' ||
    typeof entry.integrity !== 'string'
  ) {
    throw new Error('DEPENDENCY_LOCK_ENTRY_INVALID');
  }
  if (!SEMVERISH.test(entry.version) || FORBIDDEN_SOURCE.test(entry.version))
    throw new Error('DEPENDENCY_SOURCE_DENIED');
  if (!/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity))
    throw new Error('DEPENDENCY_INTEGRITY_INVALID');
  let resolved;
  try {
    resolved = new URL(entry.resolved);
  } catch {
    throw new Error('DEPENDENCY_RESOLVED_BYPASS');
  }
  const gateway = new URL(gatewayBaseUrl);
  if (
    resolved.origin !== gateway.origin ||
    resolved.username ||
    resolved.password ||
    resolved.search ||
    !resolved.pathname.startsWith('/v1/tarballs/')
  )
    throw new Error('DEPENDENCY_RESOLVED_BYPASS');
}

function packageNameFromLockPath(lockPath, entry) {
  if (typeof entry.name === 'string') return entry.name;
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  return index >= 0 ? lockPath.slice(index + marker.length) : null;
}

function assertTrustedSpec(value) {
  if (typeof value !== 'string' || FORBIDDEN_SOURCE.test(value))
    throw new Error('DEPENDENCY_SOURCE_DENIED');
}

function platformAllowed(entry, platform) {
  const matches = (rules, actual) =>
    !Array.isArray(rules) ||
    rules.length === 0 ||
    (rules.includes(actual) && !rules.includes(`!${actual}`)) ||
    (!rules.some((rule) => !rule.startsWith('!')) && !rules.includes(`!${actual}`));
  return matches(entry.os, platform.os) && matches(entry.cpu, platform.arch);
}

export function buildDependencyClosure({ lockfile, gatewayBaseUrl, registryAllowlist, platform }) {
  if (!lockfile || lockfile.lockfileVersion !== 3 || typeof lockfile.packages !== 'object') {
    throw new Error('DEPENDENCY_LOCKFILE_VERSION_DENIED');
  }
  const gateway = new URL(gatewayBaseUrl);
  if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password)
    throw new Error('DEPENDENCY_GATEWAY_INVALID');
  const rewritten = structuredClone(lockfile);
  const closure = [];
  for (const [lockPath, entry] of Object.entries(rewritten.packages)) {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const spec of Object.values(entry?.[field] ?? {})) assertTrustedSpec(spec);
    }
    if (lockPath === '' || !entry?.version) continue;
    if (entry.optional && !platformAllowed(entry, platform)) {
      delete rewritten.packages[lockPath];
      continue;
    }
    const name = packageNameFromLockPath(lockPath, entry);
    if (!name || !PACKAGE_NAME.test(name) || !SEMVERISH.test(entry.version))
      throw new Error('DEPENDENCY_PACKAGE_DENIED');
    if (
      typeof entry.integrity !== 'string' ||
      !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)
    ) {
      throw new Error('DEPENDENCY_INTEGRITY_INVALID');
    }
    let upstream;
    try {
      upstream = new URL(entry.resolved);
    } catch {
      throw new Error('DEPENDENCY_UPSTREAM_INVALID');
    }
    if (
      upstream.protocol !== 'https:' ||
      !registryAllowlist.includes(upstream.hostname) ||
      upstream.username ||
      upstream.password ||
      upstream.port ||
      upstream.search ||
      upstream.hash
    )
      throw new Error('DEPENDENCY_UPSTREAM_INVALID');
    const encodedName = canonicalPackagePath(name);
    const metadataPath = `/v1/packages/${encodedName}`;
    const tarballPath = `/v1/tarballs/${encodedName}/${encodeURIComponent(entry.version)}.tgz`;
    entry.resolved = new URL(tarballPath, gateway).toString();
    validateLockfilePackage(entry, gateway.toString());
    closure.push({
      name,
      version: entry.version,
      integrity: entry.integrity,
      metadataPath,
      tarballPath,
      metadataUrl: `https://${upstream.hostname}/${encodedName}`,
      tarballUrl: upstream.toString(),
    });
  }
  closure.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  const digest = createHash('sha256').update(JSON.stringify(closure)).digest('hex');
  return { lockfile: rewritten, closure, digest: `sha256:${digest}` };
}

export function createTemplateContract({
  manifest,
  lockfile,
  buildConfig,
  versions,
  gatewayBaseUrl,
  registryAllowlist,
  platform,
}) {
  const prepared = buildDependencyClosure({
    lockfile,
    gatewayBaseUrl,
    registryAllowlist,
    platform,
  });
  const canonical = JSON.stringify({
    manifest,
    lockfile: prepared.lockfile,
    buildConfig,
    versions,
  });
  return Object.freeze({
    manifest: structuredClone(manifest),
    lockfile: prepared.lockfile,
    buildConfig: structuredClone(buildConfig),
    templateVersion: versions.templateVersion,
    toolchainVersion: versions.toolchainVersion,
    templateDigest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    toolchainDigest: versions.toolchainDigest,
    dependencyClosure: prepared.closure,
    dependencyClosureDigest: prepared.digest,
  });
}
