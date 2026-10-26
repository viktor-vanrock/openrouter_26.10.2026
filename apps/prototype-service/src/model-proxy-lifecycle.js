/** Trusted worker only: obtains scoped credentials over the existing private service-auth transport. */
export class ModelProxyLifecycle {
  constructor({ controlPlane, command, proxyBaseUrl, now = Date.now }) {
    const url = new URL(proxyBaseUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !url.pathname.endsWith('/api/prototype-model/v1') ||
      typeof controlPlane?.post !== 'function' ||
      command?.stage !== 'generation'
    )
      throw new Error('PROTOTYPE_PROXY_CONFIG_INVALID');
    this.controlPlane = controlPlane;
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.identity = Object.fromEntries(
      [
        'jobId',
        'turnId',
        'commandId',
        'attemptId',
        'executionId',
        'stage',
        'fenceToken',
        'leaseId',
      ].map((key) => [key, command[key]]),
    );
    this.now = now;
    this.closed = false;
    this.current = null;
  }
  async credentials() {
    if (this.closed) throw new Error('PROTOTYPE_AGENT_AUTHORITY_REVOKED');
    if (this.current?.expiresAt > this.now() + 10000) return this.current;
    if (!this.pending)
      this.pending = this.controlPlane
        .post('/internal/prototype-tokens/refresh', this.identity)
        .then((value) => {
          const expiresAt = Date.parse(value?.expiresAt);
          if (
            this.closed ||
            typeof value?.token !== 'string' ||
            value.token.length > 16384 ||
            !Number.isFinite(expiresAt) ||
            expiresAt <= this.now() ||
            expiresAt > this.now() + 45000
          ) {
            throw new Error('PROTOTYPE_PROXY_TOKEN_INVALID');
          }
          this.current = { baseUrl: this.baseUrl, token: value.token, expiresAt };
          return this.current;
        })
        .finally(() => {
          this.pending = undefined;
        });
    return this.pending;
  }
  close() {
    this.closed = true;
    this.current = null;
  }
}

/** Sandbox-side transport: stable authority ID, zero redirects and zero automatic POST retry. */
export function createScopedModelFetch({ baseUrl, credentials, requestId, fetchImpl = fetch }) {
  const allowed = new URL(baseUrl);
  if (
    allowed.protocol !== 'https:' ||
    allowed.username ||
    allowed.password ||
    allowed.search ||
    allowed.hash ||
    !allowed.pathname.endsWith('/api/prototype-model/v1') ||
    typeof credentials !== 'function' ||
    typeof requestId !== 'function'
  ) {
    throw new Error('PROTOTYPE_PROXY_CONFIG_INVALID');
  }
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const suffix = url.pathname.slice(allowed.pathname.length);
    const method = (init.method ?? input?.method ?? 'GET').toUpperCase();
    if (
      url.origin !== allowed.origin ||
      !url.pathname.startsWith(allowed.pathname) ||
      url.search ||
      url.hash ||
      !(
        (method === 'GET' && suffix === '/models') ||
        (method === 'POST' && suffix === '/chat/completions')
      )
    ) {
      throw new Error('PROTOTYPE_PROXY_TARGET_DENIED');
    }
    const headers = new Headers(init.headers ?? input?.headers);
    headers.set('Authorization', `Bearer ${await credentials()}`);
    if (method === 'POST') headers.set('X-Prototype-Request-Id', requestId());
    // OpenCode provider maxRetries must additionally be zero; confirmed by installed-binary gate T011/T012.
    return fetchImpl(input, { ...init, headers, redirect: 'error' });
  };
}
