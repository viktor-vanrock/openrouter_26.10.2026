const ROLES = new Set(['orchestrator', 'model-gateway', 'dependency-gateway']);

export class PrototypeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrototypeConfigError';
    this.code = 'PROTOTYPE_CONFIG_INVALID';
  }
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PrototypeConfigError(`${name} is required`);
  }
  return value.trim();
}

function integer(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new PrototypeConfigError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PrototypeConfigError(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function optionalUrl(env, name, protocols, requiredInProduction = true) {
  const raw = env[name];
  if ((raw == null || raw === '') && env.NODE_ENV !== 'production' && !requiredInProduction)
    return null;
  const value = required(env, name);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new PrototypeConfigError(`${name} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol))
    throw new PrototypeConfigError(`${name} uses an unsupported protocol`);
  if (parsed.username || parsed.password)
    throw new PrototypeConfigError(`${name} must reference credentials separately`);
  return parsed.toString();
}

function list(env, name, requiredInProduction = true) {
  const raw = env[name];
  if ((raw == null || raw === '') && env.NODE_ENV !== 'production' && !requiredInProduction)
    return [];
  const values = required(env, name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new PrototypeConfigError(`${name} must contain unique comma-separated values`);
  }
  return values;
}

function stageProfiles(env, trustedImages, requiredInProduction) {
  const raw = env.PROTOTYPE_STAGE_PROFILES_JSON;
  if (!raw && !requiredInProduction) return null;
  if (!raw) throw new PrototypeConfigError('PROTOTYPE_STAGE_PROFILES_JSON is required');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PrototypeConfigError('PROTOTYPE_STAGE_PROFILES_JSON must be valid JSON');
  }
  const stages = ['generation', 'transfer', 'dependency_preparation', 'build_qa', 'publish'];
  for (const stage of stages) {
    const profile = value?.[stage];
    if (!profile || !trustedImages.includes(profile.image)) {
      throw new PrototypeConfigError(
        `Prototype stage ${stage} must use an allowlisted digest-pinned image`,
      );
    }
    if (!Number.isSafeInteger(profile.activeDeadlineSeconds) || profile.activeDeadlineSeconds < 1) {
      throw new PrototypeConfigError(`Prototype stage ${stage} requires activeDeadlineSeconds`);
    }
    for (const resource of ['cpu', 'memory', 'ephemeral-storage']) {
      if (
        typeof profile.resources?.[resource] !== 'string' ||
        profile.resources[resource].length === 0
      ) {
        throw new PrototypeConfigError(`Prototype stage ${stage} requires ${resource}`);
      }
    }
  }
  return value;
}

function common(env, expectedRole) {
  const role = expectedRole ?? required(env, 'PROTOTYPE_SERVICE_ROLE');
  if (!ROLES.has(role)) throw new PrototypeConfigError('PROTOTYPE_SERVICE_ROLE is unsupported');
  if (expectedRole && env.PROTOTYPE_SERVICE_ROLE && env.PROTOTYPE_SERVICE_ROLE !== expectedRole) {
    throw new PrototypeConfigError('PROTOTYPE_SERVICE_ROLE does not match the selected entrypoint');
  }
  return {
    role,
    environment: env.NODE_ENV ?? 'development',
    host: env.PROTOTYPE_BIND_HOST ?? '0.0.0.0',
    port: integer(env, 'PROTOTYPE_PORT', 3090, 1, 65_535),
    shutdownTimeoutMs: integer(env, 'PROTOTYPE_SHUTDOWN_TIMEOUT_MS', 15_000, 1_000, 120_000),
  };
}

export function loadPrototypeConfig(env = process.env, expectedRole) {
  const config = common(env, expectedRole);
  const controlPlaneEnv =
    env.NODE_ENV === 'production'
      ? env
      : {
          ...env,
          PROTOTYPE_CONTROL_PLANE_URL:
            env.PROTOTYPE_CONTROL_PLANE_URL ||
            env.DOMAIN_SERVER ||
            `http://localhost:${env.PORT || 3080}`,
        };
  if (config.role === 'orchestrator') {
    const executionBackend = env.PROTOTYPE_EXECUTION_BACKEND || 'legacy-kubernetes';
    if (!['sandbox-gateway', 'legacy-kubernetes'].includes(executionBackend)) {
      throw new PrototypeConfigError('PROTOTYPE_EXECUTION_BACKEND is unsupported');
    }
    const gatewayBackend = executionBackend === 'sandbox-gateway';
    if (
      env.PROTOTYPE_WORKER_INTAKE_ENABLED != null &&
      !['true', 'false'].includes(env.PROTOTYPE_WORKER_INTAKE_ENABLED)
    ) {
      throw new PrototypeConfigError('PROTOTYPE_WORKER_INTAKE_ENABLED must be true or false');
    }
    const serviceAuthMode = env.PROTOTYPE_SERVICE_AUTH_MODE || 'mtls';
    if (!['mtls', 'bearer'].includes(serviceAuthMode))
      throw new PrototypeConfigError('PROTOTYPE_SERVICE_AUTH_MODE is unsupported');
    if (
      env.NODE_ENV === 'production' &&
      serviceAuthMode === 'bearer' &&
      !/^[a-f0-9]{64}$/.test(env.PROTOTYPE_SERVICE_TOKEN || '')
    ) {
      throw new PrototypeConfigError(
        'PROTOTYPE_SERVICE_TOKEN must be a random 32-byte lowercase hex token',
      );
    }
    let gateway = null;
    if (gatewayBackend) {
      const tokenMode = env.SANDBOX_GATEWAY_TOKEN_MODE || 'inline';
      if (!['inline', 'file'].includes(tokenMode))
        throw new PrototypeConfigError('SANDBOX_GATEWAY_TOKEN_MODE is unsupported');
      const token = tokenMode === 'inline' ? required(env, 'SANDBOX_GATEWAY_TOKEN') : null;
      if (token && /\s/.test(token))
        throw new PrototypeConfigError('SANDBOX_GATEWAY_TOKEN is invalid');
      gateway = {
        url: optionalUrl(env, 'SANDBOX_GATEWAY_URL', ['https:']),
        tokenMode,
        token,
        tokenFile: tokenMode === 'file' ? required(env, 'SANDBOX_GATEWAY_TOKEN_FILE') : null,
        caFile: env.SANDBOX_GATEWAY_CA_FILE || null,
      };
      if (!env.AWS_BUCKET_NAME || !env.AWS_REGION)
        throw new PrototypeConfigError('AWS_BUCKET_NAME and AWS_REGION are required');
      required(env, 'REDIS_URI');
    }
    const requiredScheduler =
      !gatewayBackend &&
      (env.NODE_ENV === 'production' || env.PROTOTYPE_REQUIRE_SCHEDULER_CONFIG === '1');
    const imageDigests = gatewayBackend
      ? []
      : list(env, 'PROTOTYPE_TRUSTED_IMAGE_DIGESTS', requiredScheduler);
    if (imageDigests.some((value) => !/^.+@sha256:[a-f0-9]{64}$/.test(value))) {
      throw new PrototypeConfigError(
        'PROTOTYPE_TRUSTED_IMAGE_DIGESTS must use image@sha256 references',
      );
    }
    return {
      ...config,
      executionBackend,
      workerIntakeEnabled: env.PROTOTYPE_WORKER_INTAKE_ENABLED === 'true',
      workspaceDirectory: env.PROTOTYPE_WORKSPACE_DIR || '/var/lib/prototype',
      gateway,
      serviceAuthMode,
      serviceToken:
        env.NODE_ENV === 'production' && serviceAuthMode === 'bearer'
          ? env.PROTOTYPE_SERVICE_TOKEN
          : null,
      controlPlaneUrl: optionalUrl(
        controlPlaneEnv,
        'PROTOTYPE_CONTROL_PLANE_URL',
        config.environment === 'production' ? ['https:'] : ['http:', 'https:'],
        false,
      ),
      modelProviderUrl: gatewayBackend ? optionalUrl(env, 'OPENROUTER_API_URL', ['https:']) : null,
      projectedOutputRoot: env.PROTOTYPE_PROJECTED_OUTPUT_ROOT ?? null,
      testWorkerIdentity:
        env.NODE_ENV === 'production' ? null : (env.PROTOTYPE_TEST_WORKER_IDENTITY ?? null),
      mtlsCertPath: env.PROTOTYPE_MTLS_CERT_PATH || null,
      mtlsKeyPath: env.PROTOTYPE_MTLS_KEY_PATH || null,
      mtlsCaPath: env.PROTOTYPE_MTLS_CA_PATH || null,
      redisUrl: optionalUrl(env, 'REDIS_URI', ['redis:', 'rediss:'], false),
      schedulerContext: requiredScheduler ? required(env, 'PROTOTYPE_SCHEDULER_CONTEXT') : null,
      schedulerNamespace: requiredScheduler ? required(env, 'PROTOTYPE_SCHEDULER_NAMESPACE') : null,
      runtimeClass: requiredScheduler ? required(env, 'PROTOTYPE_RUNTIME_CLASS') : null,
      trustedImageDigests: imageDigests,
      stageProfiles: stageProfiles(env, imageDigests, requiredScheduler),
      kubernetesApiUrl: gatewayBackend
        ? null
        : optionalUrl(
            {
              ...env,
              PROTOTYPE_KUBERNETES_API_URL:
                env.PROTOTYPE_KUBERNETES_API_URL ?? 'https://kubernetes.default.svc',
            },
            'PROTOTYPE_KUBERNETES_API_URL',
            ['https:'],
            false,
          ),
      kubernetesTokenPath: gatewayBackend
        ? null
        : (env.PROTOTYPE_KUBERNETES_TOKEN_PATH ??
          '/var/run/secrets/kubernetes.io/serviceaccount/token'),
      kubernetesCaPath: gatewayBackend
        ? null
        : (env.PROTOTYPE_KUBERNETES_CA_PATH ??
          '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
      schedulerCapabilitiesConfigMap: requiredScheduler
        ? required(env, 'PROTOTYPE_SCHEDULER_CAPABILITIES_CONFIGMAP')
        : null,
      schedulerTtlSeconds: integer(env, 'PROTOTYPE_SCHEDULER_TTL_SECONDS', 600, 60, 86_400),
      terminationGracePeriodSeconds: integer(
        env,
        'PROTOTYPE_TERMINATION_GRACE_SECONDS',
        10,
        1,
        120,
      ),
      tmpSizeLimit: env.PROTOTYPE_TMP_SIZE_LIMIT ?? '256Mi',
      commandConsumer: env.PROTOTYPE_COMMAND_CONSUMER ?? `prototype-service-${process.pid}`,
      concurrencyLimits: {
        global: integer(env, 'PROTOTYPE_CONCURRENCY_GLOBAL', gatewayBackend ? 2 : 20, 1, 10_000),
        tenant: integer(env, 'PROTOTYPE_CONCURRENCY_TENANT', gatewayBackend ? 2 : 5, 1, 1_000),
        user: integer(env, 'PROTOTYPE_CONCURRENCY_USER', gatewayBackend ? 1 : 2, 1, 100),
      },
      storageEndpoint: env.AWS_ENDPOINT_URL
        ? optionalUrl(env, 'AWS_ENDPOINT_URL', ['http:', 'https:'], false)
        : null,
      storageBucket: env.AWS_BUCKET_NAME ?? null,
      storageRegion: env.AWS_REGION ?? null,
      storageCredentialRef: env.PROTOTYPE_STORAGE_CREDENTIAL_REF ?? null,
      archiveLimits: {
        maxArchiveBytes: integer(
          env,
          'PROTOTYPE_ARCHIVE_MAX_BYTES',
          100_000_000,
          1_024,
          2_000_000_000,
        ),
        maxExpandedBytes: integer(
          env,
          'PROTOTYPE_ARCHIVE_MAX_EXPANDED_BYTES',
          500_000_000,
          1_024,
          4_000_000_000,
        ),
        maxFiles: integer(env, 'PROTOTYPE_ARCHIVE_MAX_FILES', 100_000, 1, 1_000_000),
        maxPathBytes: integer(env, 'PROTOTYPE_ARCHIVE_MAX_PATH_BYTES', 1_024, 16, 16_384),
        maxDurationMs: integer(env, 'PROTOTYPE_ARCHIVE_TIMEOUT_MS', 60_000, 100, 600_000),
      },
    };
  }
  if (config.role === 'model-gateway') {
    return {
      ...config,
      controlPlaneUrl: optionalUrl(
        controlPlaneEnv,
        'PROTOTYPE_CONTROL_PLANE_URL',
        ['http:', 'https:'],
        false,
      ),
      mtlsCertPath:
        env.NODE_ENV === 'production' ? required(env, 'PROTOTYPE_MTLS_CERT_PATH') : null,
      mtlsKeyPath: env.NODE_ENV === 'production' ? required(env, 'PROTOTYPE_MTLS_KEY_PATH') : null,
      mtlsCaPath: env.NODE_ENV === 'production' ? required(env, 'PROTOTYPE_MTLS_CA_PATH') : null,
    };
  }
  const proxyType = env.PROTOTYPE_OUTBOUND_PROXY_TYPE ?? null;
  if (
    (env.NODE_ENV === 'production' || proxyType) &&
    !['http-forward', 'http-connect', 'socks5'].includes(proxyType)
  ) {
    throw new PrototypeConfigError('PROTOTYPE_OUTBOUND_PROXY_TYPE is unsupported');
  }
  const proxyUrl = optionalUrl(
    env,
    'PROTOTYPE_OUTBOUND_PROXY_URL',
    ['http:', 'https:', 'socks5:'],
    false,
  );
  if (proxyUrl && (proxyType === 'socks5') !== proxyUrl.startsWith('socks5:')) {
    throw new PrototypeConfigError('PROTOTYPE_OUTBOUND_PROXY_TYPE does not match its URL');
  }
  return {
    ...config,
    outboundProxyType: proxyType,
    outboundProxyUrl: proxyUrl,
    outboundProxyCredentialRef:
      env.NODE_ENV === 'production'
        ? required(env, 'PROTOTYPE_OUTBOUND_PROXY_CREDENTIAL_REF')
        : null,
    outboundProxyDestinationGuard: env.PROTOTYPE_OUTBOUND_PROXY_DESTINATION_GUARD ?? null,
    registryAllowlist: list(env, 'PROTOTYPE_REGISTRY_ALLOWLIST', false),
    dependencyClosurePath: env.PROTOTYPE_DEPENDENCY_CLOSURE_PATH ?? null,
    dependencyGatewayPublicUrl:
      optionalUrl(env, 'PROTOTYPE_DEPENDENCY_GATEWAY_PUBLIC_URL', ['http:', 'https:'], false) ??
      'http://dependency.internal',
    dependencyRequestTimeoutMs: integer(
      env,
      'PROTOTYPE_DEPENDENCY_REQUEST_TIMEOUT_MS',
      30_000,
      100,
      120_000,
    ),
    dependencyMaxResponseBytes: integer(
      env,
      'PROTOTYPE_DEPENDENCY_MAX_RESPONSE_BYTES',
      25_000_000,
      1_024,
      250_000_000,
    ),
    dependencyMaxRequests: integer(env, 'PROTOTYPE_DEPENDENCY_MAX_REQUESTS', 2_000, 1, 100_000),
  };
}
