import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import https from 'node:https';
import { Readable } from 'node:stream';
import { commandLogContext, errorLogFields } from './service-log.js';

const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,256}$/;

export class PrototypeControlPlaneError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'PrototypeControlPlaneError';
    this.code = code;
    this.status = status;
  }
}

async function readBoundedJson(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_RESPONSE_TOO_LARGE', response.status);
  }
  const reader = response.body?.getReader?.();
  if (!reader)
    throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_RESPONSE_INVALID', response.status);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new PrototypeControlPlaneError(
          'PROTOTYPE_CONTROL_RESPONSE_TOO_LARGE',
          response.status,
        );
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof PrototypeControlPlaneError) throw error;
    throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_RESPONSE_INVALID', response.status);
  }
}

function responseError(response, value) {
  const code = value?.error?.code;
  if (response.status === 409 && code === 'PROTOTYPE_STALE_REVISION') {
    return new PrototypeControlPlaneError(code, response.status);
  }
  if (response.status === 401 && code === 'PROTOTYPE_WORKER_UNAUTHORIZED') {
    return new PrototypeControlPlaneError(code, response.status);
  }
  return new PrototypeControlPlaneError('PROTOTYPE_SERVICE_UNAVAILABLE', response.status);
}

export class PrototypeControlPlaneClient {
  static fromBearerConfig({ baseUrl, token, ...options }) {
    if (!/^[a-f0-9]{64}$/.test(token || ''))
      throw new Error('PROTOTYPE_SERVICE_AUTH_CONFIG_INVALID');
    return new PrototypeControlPlaneClient({
      ...options,
      baseUrl,
      environment: 'production',
      pathPrefix: '/api',
      headers: async () => ({ Authorization: `Bearer ${token}` }),
    });
  }

  static async fromMtlsConfig({ baseUrl, certPath, keyPath, caPath, ...options }) {
    if (new URL(baseUrl).protocol !== 'https:' || !certPath || !keyPath || !caPath) {
      throw new Error('PROTOTYPE_MTLS_CONFIG_INVALID');
    }
    const file = await fs.open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let key;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16384)
        throw new Error('PROTOTYPE_MTLS_KEY_INVALID');
      key = await file.readFile();
    } finally {
      await file.close();
    }
    const [cert, ca] = await Promise.all([fs.readFile(certPath), fs.readFile(caPath)]);
    const fetchImpl = (url, request) =>
      new Promise((resolve, reject) => {
        const req = https.request(
          url,
          {
            method: request.method,
            headers: request.headers,
            signal: request.signal,
            cert,
            key,
            ca,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.2',
          },
          (res) => {
            // No redirect handling: credentials never leave the configured control-plane origin.
            resolve(
              new Response(Readable.toWeb(res), { status: res.statusCode, headers: res.headers }),
            );
          },
        );
        req.on('error', reject);
        req.end(request.body);
      });
    return new PrototypeControlPlaneClient({
      ...options,
      baseUrl,
      fetchImpl,
      environment: 'production',
    });
  }

  constructor({
    baseUrl,
    pathPrefix = '',
    fetchImpl = fetch,
    headers = async () => ({}),
    timeoutMs = 10_000,
    maxRequestBytes = 32 * 1024,
    maxResponseBytes = 64 * 1024,
    environment = process.env.NODE_ENV,
    log = () => {},
  }) {
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('Prototype control plane URL is invalid');
    }
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      (environment === 'production' && parsed.protocol !== 'https:')
    ) {
      throw new Error('Prototype control plane URL is invalid');
    }
    if (
      typeof fetchImpl !== 'function' ||
      typeof headers !== 'function' ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxRequestBytes) ||
      maxRequestBytes < 1 ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1
    ) {
      throw new Error('Prototype control plane client configuration is invalid');
    }
    if (!['', '/api'].includes(pathPrefix))
      throw new Error('Prototype control plane path prefix is invalid');
    this.pathPrefix = pathPrefix;
    this.baseUrl = parsed;
    this.fetchImpl = fetchImpl;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.maxRequestBytes = maxRequestBytes;
    this.maxResponseBytes = maxResponseBytes;
    this.log = log;
  }

  async post(pathname, body) {
    if (
      !pathname.startsWith('/internal/prototype-') ||
      pathname.includes('..') ||
      /[?#\\]/.test(pathname)
    ) {
      throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_PATH_INVALID');
    }
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > this.maxRequestBytes) {
      throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_REQUEST_TOO_LARGE');
    }
    const controller = new AbortController();
    const started = Date.now();
    // Heartbeat has its own transition-only logger; never log its five-second successes.
    const trace = pathname !== '/internal/prototype-control/v2/heartbeat';
    const context = {
      ...commandLogContext(body),
      method: 'POST',
      operation: pathname.startsWith('/internal/prototype-control/v2/')
        ? pathname.split('/').at(-1)
        : 'token_refresh',
    };
    const emit = (event, fields) => {
      if (trace) {
        try {
          this.log(event, { ...context, ...fields });
        } catch {
          /* Log transport must not affect the control-plane request. */
        }
      }
    };
    emit('control.request');
    let httpStatus;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const identityHeaders = await this.headers();
      const response = await this.fetchImpl(
        new URL(`${this.pathPrefix}${pathname}`, this.baseUrl),
        {
          method: 'POST',
          headers: {
            ...identityHeaders,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: encoded,
          signal: controller.signal,
          redirect: 'error',
        },
      );
      httpStatus = response.status;
      const value = await readBoundedJson(response, this.maxResponseBytes);
      if (!response.ok) throw responseError(response, value);
      emit('control.finished', { httpStatus: response.status, elapsedMs: Date.now() - started });
      return value;
    } catch (error) {
      emit('control.failed', {
        ...errorLogFields(error, 'PROTOTYPE_SERVICE_UNAVAILABLE'),
        httpStatus: error.status ?? httpStatus,
        elapsedMs: Date.now() - started,
      });
      if (error instanceof PrototypeControlPlaneError) throw error;
      throw new PrototypeControlPlaneError('PROTOTYPE_SERVICE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }

  async registerLease(input) {
    const value = await this.post('/internal/prototype-control/v2/leases', input);
    if (
      !SAFE_ID.test(value?.jobId ?? '') ||
      !SAFE_ID.test(value?.leaseId ?? '') ||
      !Number.isSafeInteger(value?.revision) ||
      value.revision < 0 ||
      !Number.isSafeInteger(value?.fenceToken) ||
      value.fenceToken < 1
    ) {
      throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_RESPONSE_INVALID');
    }
    return value;
  }

  async completeStage(input) {
    const value = await this.post('/internal/prototype-control/v2/stage-completions', input);
    if (value?.accepted !== true || !SAFE_ID.test(value?.eventId ?? '')) {
      throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_RESPONSE_INVALID');
    }
    return value;
  }

  async completeWaiting(input) {
    const value = await this.post('/internal/prototype-control/v2/waiting', input);
    if (value?.accepted !== true || !SAFE_ID.test(value?.eventId ?? '')) {
      throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_RESPONSE_INVALID');
    }
    return value;
  }

  async completePublication(input) {
    const value = await this.post('/internal/prototype-control/v2/publications', input);
    if (value?.accepted !== true || !SAFE_ID.test(value?.eventId ?? '')) {
      throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_RESPONSE_INVALID');
    }
    return value;
  }

  async failStage(input) {
    const value = await this.post('/internal/prototype-control/v2/stage-failures', input);
    if (value?.accepted !== true || !SAFE_ID.test(value?.eventId ?? '')) {
      throw new PrototypeControlPlaneError('PROTOTYPE_CONTROL_RESPONSE_INVALID');
    }
    return value;
  }
}
