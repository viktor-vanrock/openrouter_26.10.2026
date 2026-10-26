import http from 'node:http';
import https from 'node:https';
import { resolvePublicRegistryHost, validateRegistryRequest } from './dependency-policy.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
]);

function responseHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers))
    if (!HOP_BY_HOP.has(key.toLowerCase()) && value != null) result[key] = value;
  return result;
}

export function createForwardProxyTransport({ proxyUrl, timeoutMs, maxResponseBytes }) {
  const proxy = new URL(proxyUrl);
  const protocol = proxy.protocol === 'https:' ? https : http;
  return async function request(target, method, signal) {
    return new Promise((resolve, reject) => {
      const request = protocol.request({
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxy.port || undefined,
        method,
        path: target.toString(),
        signal,
        timeout: timeoutMs,
        headers: { host: target.host, accept: 'application/json, application/octet-stream' },
      });
      request.once('timeout', () => request.destroy(new Error('DEPENDENCY_UPSTREAM_TIMEOUT')));
      request.once('error', reject);
      request.once('response', (upstream) => {
        let bytes = 0;
        const chunks = [];
        upstream.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) upstream.destroy(new Error('DEPENDENCY_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        upstream.once('error', reject);
        upstream.once('end', () =>
          resolve({
            statusCode: upstream.statusCode ?? 502,
            headers: responseHeaders(upstream.headers),
            body: Buffer.concat(chunks),
          }),
        );
      });
      request.end();
    });
  };
}

export class DependencyGatewayRuntime {
  constructor({
    allowlist,
    closure,
    transport,
    lookup,
    gatewayBaseUrl = 'http://dependency.internal',
    maxRequests = 2_000,
    maxRedirects = 3,
  }) {
    Object.assign(this, {
      allowlist,
      closure,
      transport,
      lookup,
      gatewayBaseUrl,
      maxRequests,
      maxRedirects,
    });
    this.requests = 0;
    this.ready = false;
  }
  rewriteMetadata(entries, result) {
    if (result.statusCode !== 200) return result;
    let metadata;
    try {
      metadata = JSON.parse(result.body.toString('utf8'));
    } catch {
      throw new Error('DEPENDENCY_METADATA_INVALID');
    }
    const versions = {};
    for (const entry of entries) {
      const version = metadata?.versions?.[entry.version];
      if (
        !version ||
        version.name !== entry.name ||
        version.version !== entry.version ||
        version.dist?.integrity !== entry.integrity
      ) {
        throw new Error('DEPENDENCY_METADATA_MISMATCH');
      }
      versions[entry.version] = {
        ...version,
        dist: {
          ...version.dist,
          tarball: new URL(entry.tarballPath, this.gatewayBaseUrl).toString(),
          integrity: entry.integrity,
        },
      };
    }
    const body = Buffer.from(JSON.stringify({ name: entries[0].name, versions }));
    return {
      ...result,
      headers: {
        ...result.headers,
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
      body,
    };
  }
  async start() {
    if (!this.transport || this.allowlist.length === 0 || this.closure.length === 0)
      throw new Error('DEPENDENCY_GATEWAY_NOT_CONFIGURED');
    this.ready = true;
  }
  async stop() {
    this.ready = false;
  }
  async isReady() {
    return this.ready;
  }
  async fetch(entry, kind, method, signal) {
    let target = new URL(kind === 'metadata' ? entry.metadataUrl : entry.tarballUrl);
    for (let redirect = 0; redirect <= this.maxRedirects; redirect += 1) {
      validateRegistryRequest({
        method,
        url: target.toString(),
        allowlist: this.allowlist,
        closure: [
          {
            metadataPath: new URL(entry.metadataUrl).pathname,
            tarballPath: new URL(entry.tarballUrl).pathname,
          },
        ],
      });
      await resolvePublicRegistryHost(target.hostname, this.lookup);
      const result = await this.transport(target, method, signal);
      if (![301, 302, 303, 307, 308].includes(result.statusCode)) return result;
      if (redirect === this.maxRedirects) throw new Error('DEPENDENCY_REDIRECT_LIMIT');
      const location = result.headers.location;
      if (typeof location !== 'string') throw new Error('DEPENDENCY_REDIRECT_INVALID');
      target = new URL(location, target);
    }
    throw new Error('DEPENDENCY_REDIRECT_LIMIT');
  }
  async handleRequest(req, res, signal) {
    if (!this.ready) return false;
    if (!['GET', 'HEAD'].includes(req.method ?? '')) {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return true;
    }
    const pathname = new URL(req.url, 'http://dependency.internal').pathname;
    const entries = this.closure.filter(
      (item) => item.metadataPath === pathname || item.tarballPath === pathname,
    );
    const entry = entries[0];
    if (!entry) {
      res.writeHead(404);
      res.end();
      return true;
    }
    if (++this.requests > this.maxRequests) {
      res.writeHead(429);
      res.end();
      return true;
    }
    try {
      const kind = entry.metadataPath === pathname ? 'metadata' : 'tarball';
      let result = await this.fetch(entry, kind, req.method, signal);
      if (kind === 'metadata' && req.method === 'GET')
        result = this.rewriteMetadata(entries, result);
      res.writeHead(result.statusCode, { ...result.headers, 'cache-control': 'private, no-store' });
      res.end(req.method === 'HEAD' ? undefined : result.body);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          error: { code: error instanceof Error ? error.message : 'DEPENDENCY_UPSTREAM_FAILED' },
        }),
      );
    }
    return true;
  }
}
