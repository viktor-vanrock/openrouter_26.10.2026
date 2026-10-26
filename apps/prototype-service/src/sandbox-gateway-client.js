import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import https from 'node:https';

/** Gateway API 1 transport. Never retries a command or sandbox/session creation. */
export class SandboxGatewayClient {
  constructor({ baseUrl, token, ca }) {
    this.base = new URL(baseUrl);
    if (
      this.base.protocol !== 'https:' ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      typeof token !== 'string' ||
      !token ||
      /\s/.test(token)
    ) {
      throw new Error('GATEWAY_CONFIGURATION_INVALID');
    }
    this.token = token;
    this.ca = ca;
  }

  /** Root environment is authoritative; file credentials require an explicit file mode. */
  static async fromConfig(config) {
    let token = config.token;
    if (config.tokenMode === 'file') {
      const file = await fs.open(config.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16_384)
          throw new Error('GATEWAY_PRIVATE_FILE_INVALID');
        token = (await file.readFile('utf8')).trim();
      } finally {
        await file.close();
      }
    }
    const ca = config.caFile ? await fs.readFile(config.caFile, 'utf8') : undefined;
    return new SandboxGatewayClient({ baseUrl: config.url, token, ca });
  }

  async probe({ signal } = {}) {
    const version = await this.request('GET', '/version', { signal, timeoutMs: 5_000 });
    if (version?.api !== 1) throw new Error('GATEWAY_API_UNSUPPORTED');
    // Authentication is tested separately from the public version endpoint.
    await this.request('GET', '/sandboxes?limit=1', { signal, timeoutMs: 5_000 });
    return { api: version.api, version: version.version };
  }

  static async fromDirectory(directory) {
    async function read(name, optional = false) {
      let file;
      try {
        file = await fs.open(`${directory}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile() || stat.mode & 0o077 || stat.size > 262144)
          throw new Error('GATEWAY_PRIVATE_FILE_INVALID');
        return (await file.readFile('utf8')).trim();
      } catch (error) {
        if (optional && error.code === 'ENOENT') return undefined;
        throw error;
      } finally {
        await file?.close();
      }
    }
    return new SandboxGatewayClient({
      baseUrl: await read('gateway.url'),
      token: await read('gateway.token'),
      ca: await read('gateway-ca.pem', true),
    });
  }

  url(pathname) {
    const value = new URL(this.base);
    const [path, query] = pathname.split('?');
    value.pathname = this.base.pathname.replace(/\/$/, '') + path;
    value.search = query ? `?${query}` : '';
    return value;
  }

  request(
    method,
    pathname,
    {
      body,
      raw = false,
      maxBytes = 4_000_000,
      timeoutMs = 20_000,
      signal,
      onChunk,
      contentType,
    } = {},
  ) {
    signal?.throwIfAborted();
    const payload =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = https.request(
        this.url(pathname),
        {
          method,
          ca: this.ca,
          rejectUnauthorized: true,
          signal,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: 'application/json',
            'accept-encoding': 'identity',
            ...(payload
              ? {
                  'content-type':
                    contentType ??
                    (Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json'),
                  'content-length': payload.length,
                }
              : {}),
          },
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) res.destroy(new Error('GATEWAY_RESPONSE_TOO_LARGE'));
            else {
              chunks.push(chunk);
              if (res.statusCode < 300) onChunk?.(chunk);
            }
          });
          res.on('error', reject);
          res.on('end', () => {
            const bytes = Buffer.concat(chunks);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              let code;
              try {
                code = JSON.parse(bytes).code;
              } catch {
                /* sandboxd errors can be text */
              }
              const error = new Error(`GATEWAY_HTTP_${res.statusCode}`);
              error.status = res.statusCode;
              error.gatewayCode = /^[a-z_]+$/.test(code ?? '') ? code : null;
              reject(error);
              return;
            }
            if (raw) {
              resolve(bytes);
              return;
            }
            if (!bytes.length) {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(bytes));
            } catch {
              reject(new Error('GATEWAY_RESPONSE_INVALID'));
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(new Error('GATEWAY_REQUEST_TIMEOUT')), timeoutMs);
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end(payload);
    });
  }
}
