import fs from 'node:fs/promises';
import https from 'node:https';

function encode(value) {
  return encodeURIComponent(value);
}

export class KubernetesApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'KubernetesApiError';
    this.statusCode = statusCode;
  }
}

export class KubernetesHttpApi {
  constructor({ baseUrl, tokenPath, caPath, namespace, capabilitiesConfigMap, request }) {
    this.baseUrl = new URL(baseUrl);
    this.tokenPath = tokenPath;
    this.caPath = caPath;
    this.namespace = namespace;
    this.capabilitiesConfigMap = capabilitiesConfigMap;
    this.requestOverride = request;
  }

  async credentials() {
    const [token, ca] = await Promise.all([
      fs.readFile(this.tokenPath, 'utf8'),
      fs.readFile(this.caPath),
    ]);
    return { token: token.trim(), ca };
  }

  async request(method, pathname, body) {
    if (this.requestOverride) return this.requestOverride(method, pathname, body);
    const { token, ca } = await this.credentials();
    const payload = body == null ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(
        new URL(pathname, this.baseUrl),
        {
          method,
          ca,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(payload == null
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }),
          },
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > 1_048_576)
              req.destroy(new KubernetesApiError('Kubernetes response is too large'));
            else chunks.push(chunk);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let value = null;
            try {
              value = raw.length === 0 ? null : JSON.parse(raw);
            } catch {
              return reject(
                new KubernetesApiError('Kubernetes returned invalid JSON', res.statusCode),
              );
            }
            if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
              return reject(
                new KubernetesApiError(
                  `Kubernetes API request failed (${res.statusCode})`,
                  res.statusCode,
                ),
              );
            }
            resolve(value);
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(10_000, () =>
        req.destroy(new KubernetesApiError('Kubernetes API request timed out')),
      );
      if (payload != null) req.write(payload);
      req.end();
    });
  }

  async readCapabilities(runtimeClass) {
    const [runtime, configMap] = await Promise.all([
      this.request('GET', `/apis/node.k8s.io/v1/runtimeclasses/${encode(runtimeClass)}`),
      this.request(
        'GET',
        `/api/v1/namespaces/${encode(this.namespace)}/configmaps/${encode(this.capabilitiesConfigMap)}`,
      ),
    ]);
    const data = configMap?.data ?? {};
    return {
      runtimeClasses: runtime?.metadata?.name === runtimeClass ? [runtimeClass] : [],
      networkPolicyEnforced: data.networkPolicyEnforced === 'true',
      admissionPolicyEnforced: data.admissionPolicyEnforced === 'true',
      pidLimitEnforced: data.pidLimitEnforced === 'true',
    };
  }

  createJob(job) {
    return this.request('POST', `/apis/batch/v1/namespaces/${encode(this.namespace)}/jobs`, job);
  }

  getJob(name) {
    return this.request(
      'GET',
      `/apis/batch/v1/namespaces/${encode(this.namespace)}/jobs/${encode(name)}`,
    );
  }

  deleteJob({ namespace, name, propagationPolicy, gracePeriodSeconds }) {
    if (namespace !== this.namespace) throw new KubernetesApiError('Kubernetes namespace mismatch');
    return this.request(
      'DELETE',
      `/apis/batch/v1/namespaces/${encode(namespace)}/jobs/${encode(name)}`,
      {
        apiVersion: 'v1',
        kind: 'DeleteOptions',
        propagationPolicy,
        gracePeriodSeconds,
      },
    );
  }
}
