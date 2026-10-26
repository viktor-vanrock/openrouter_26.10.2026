/** Acceptance-only trusted helpers. No credentials in plans, receipts or errors. */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { deterministicLeaseId } from './stage-supervisor.js';

const require = createRequire(import.meta.url);
const {
  quoteAgentRequest,
} = require('../../../api/server/services/Prototypes/PrototypeModelProxyStartup');
const { default: MongoConnectionString } = require('mongodb-connection-string-url');
export const digest = (value) =>
  `sha256:${createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
    .digest('hex')}`;
export const fail = (code) => {
  throw new Error(code);
};
export const safeCode = (error) =>
  /^ACCEPTANCE_[A-Z_]+$/.test(error?.message) ? error.message : 'ACCEPTANCE_OPERATION_FAILED';
export function origin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('ACCEPTANCE_ORIGIN_INVALID');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    fail('ACCEPTANCE_ORIGIN_INVALID');
  return url.origin;
}
export function storeScope(value) {
  let url;
  try {
    url = new MongoConnectionString(value);
  } catch {
    fail('ACCEPTANCE_STORE_INVALID');
  }
  if (
    !['mongodb:', 'mongodb+srv:'].includes(url.protocol) ||
    !/^\/[a-zA-Z0-9_-]+$/.test(url.pathname) ||
    ['admin', 'local', 'config'].includes(url.pathname.slice(1))
  )
    fail('ACCEPTANCE_STORE_INVALID');
  return {
    database: url.pathname.slice(1),
    fingerprint: digest({
      protocol: url.protocol,
      hosts: url.hosts,
      database: url.pathname,
      replicaSet: url.searchParams.get('replicaSet'),
    }),
  };
}
export async function readPrivate(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 128 * 1024)
      fail('ACCEPTANCE_PRIVATE_FILE_REQUIRED');
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
export async function writePrivate(file, value, exclusive = false) {
  const handle = await fs.open(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (exclusive ? constants.O_EXCL : constants.O_TRUNC),
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export function tuple(command) {
  return Object.fromEntries(
    [
      'jobId',
      'turnId',
      'commandId',
      'attemptId',
      'executionId',
      'stage',
      'fenceToken',
      'leaseId',
    ].map((k) => [k, command[k]]),
  );
}
export function makePlan({
  apiOrigin,
  scope,
  owner,
  tenant,
  model,
  conversation,
  message,
  pins,
  metadata,
  selectionVerified = false,
}) {
  const id = randomBytes(12).toString('hex');
  const command = {
    jobId: `job_${id}`,
    turnId: `turn_acceptance_${id}`,
    commandId: `command_acceptance_${id}`,
    attemptId: `attempt_acceptance_${id}`,
    executionId: `execution_acceptance_${id}`,
    stage: 'generation',
    expectedRevision: 2,
    fenceToken: 1,
    userId: owner ?? null,
    tenantId: tenant ?? null,
    modelId: model ?? null,
  };
  command.leaseId = deterministicLeaseId(command);
  const generation = {
    schemaVersion: 1,
    engineId: 'opencode-fsd-v1',
    sourceProfile: 'react-fsd-source-v1',
    rulesDigest: pins.buildFsd.rulesDigest,
    templateDigest: pins.buildFsd.templateDigest,
    toolchainDigest: pins.buildFsd.toolchainDigest,
  };
  const blockers = [];
  if (!scope) blockers.push('production_store_scope');
  if (
    !/^[a-f0-9]{24}$/.test(owner ?? '') ||
    !tenant ||
    !model ||
    !conversation ||
    !message ||
    !selectionVerified
  )
    blockers.push('selected_chat_owner_model_evidence');
  if (!pins.agent?.image || !/@sha256:[a-f0-9]{64}$/.test(pins.agent.image))
    blockers.push('agent_image_egress_pin');
  let quote = null;
  if (metadata && model) {
    try {
      // Bound second request including accumulated assistant tool-call/text and tool result.
      quote =
        quoteAgentRequest(
          { model, max_tokens: 1024, messages: [{ role: 'user', content: 'x'.repeat(16_000) }] },
          metadata,
        ) * 2;
      if (quote > 0.1) blockers.push('quote_exceeds_ceiling');
    } catch {
      blockers.push('selected_model_metadata_incompatible');
    }
  } else blockers.push('selected_model_price_metadata');
  return {
    schemaVersion: 1,
    runId: id,
    apiOrigin: origin(apiOrigin),
    scope: scope ?? null,
    selection: {
      owner: owner ?? null,
      tenant: tenant ?? null,
      model: model ?? null,
      conversation: conversation ?? null,
      message: message ?? null,
      verified: selectionVerified,
    },
    generation,
    command,
    image: pins.agent?.image ?? null,
    fixtureKind: 'isolated acceptance authority without planner or intake',
    ceilings: {
      usd: 0.1,
      providerPosts: 2,
      outputTokensPerRequest: 1024,
      turnMs: 600000,
      requestBytes: 16000,
    },
    quoteUsd: quote,
    metadataDigest: metadata ? digest(metadata) : null,
    blockers,
    changes: [
      'own schema-validated job and turn',
      'register own generation lease through CAS',
      'own Gateway create/session intents',
      'API-issued model leases and durable request/budget receipts',
      'cancel own authority and retain request/cleanup evidence; no shared deletion',
    ],
    requires: [
      'production_store_attestation',
      'explicit_scope_owner_model_write_approval',
      'explicit_cost_approval',
      'actual_service_identity',
      'agent_image_egress_evidence',
      'deployed_commit_digest',
    ],
  };
}
export function approve(plan, approval, action, now = Date.now()) {
  if (
    approval?.planDigest !== digest(plan) ||
    !approval.operator ||
    !Array.isArray(approval.actions) ||
    !approval.actions.includes(action) ||
    !(Date.parse(approval.validUntil) > now) ||
    approval.productionStoreFingerprint !== plan.scope?.fingerprint ||
    approval.owner !== plan.selection.owner ||
    approval.model !== plan.selection.model ||
    !approval.sameStoreAsProductionAdapter ||
    !plan.selection.verified ||
    !plan.scope ||
    !/^[a-f0-9]{24}$/.test(plan.selection.owner ?? '') ||
    !plan.selection.tenant ||
    !plan.selection.model
  )
    fail('ACCEPTANCE_APPROVAL_REQUIRED');
  if (['live', 'gateway-discovery'].includes(action) && !approval.actions.includes('cleanup'))
    fail('ACCEPTANCE_CLEANUP_APPROVAL_REQUIRED');
  if (
    plan.command.userId !== plan.selection.owner ||
    plan.command.tenantId !== plan.selection.tenant ||
    plan.command.modelId !== plan.selection.model ||
    plan.command.stage !== 'generation' ||
    plan.command.expectedRevision !== 2 ||
    plan.command.fenceToken !== 1 ||
    plan.command.leaseId !== deterministicLeaseId(plan.command) ||
    plan.generation.engineId !== 'opencode-fsd-v1' ||
    plan.generation.sourceProfile !== 'react-fsd-source-v1' ||
    ![
      plan.generation.rulesDigest,
      plan.generation.templateDigest,
      plan.generation.toolchainDigest,
    ].every((v) => /^sha256:[a-f0-9]{64}$/.test(v)) ||
    plan.ceilings.turnMs !== 600000 ||
    plan.ceilings.requestBytes !== 16000
  )
    fail('ACCEPTANCE_PLAN_IDENTITY_INVALID');
  if (
    ['live', 'gateway-discovery'].includes(action) &&
    (!approval.agentEgressVerified ||
      !/^[a-f0-9]{40}$/.test(approval.deployedCommit ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(approval.deployedImageDigest ?? ''))
  )
    fail('ACCEPTANCE_DEPLOYMENT_EVIDENCE_REQUIRED');
  if (
    ['gateway-discovery', 'live'].includes(action) &&
    (!plan.image || plan.blockers.includes('agent_image_egress_pin'))
  )
    fail('ACCEPTANCE_AGENT_IMAGE_REQUIRED');
  if (
    action === 'live' &&
    (!Number.isFinite(plan.quoteUsd) ||
      plan.quoteUsd < 0 ||
      plan.quoteUsd > plan.ceilings.usd ||
      approval.maxUsd !== plan.ceilings.usd ||
      approval.maxProviderPosts !== 2 ||
      plan.ceilings.usd > 0.1 ||
      plan.ceilings.providerPosts !== 2 ||
      plan.ceilings.outputTokensPerRequest !== 1024)
  )
    fail('ACCEPTANCE_COST_APPROVAL_REQUIRED');
  if (
    action === 'live' &&
    (approval.metadataDigest !== plan.metadataDigest ||
      !(Date.parse(approval.metadataVerifiedAt) <= now) ||
      now - Date.parse(approval.metadataVerifiedAt) > 300000)
  )
    fail('ACCEPTANCE_CURRENT_PRICE_EVIDENCE_REQUIRED');
}
export async function boundedHttp(url, init = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  const reader = response.body?.getReader();
  let size = 0;
  const chunks = [];
  if (reader)
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) {
          await reader.cancel();
          fail('ACCEPTANCE_RESPONSE_LIMIT');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    value = null;
  }
  return { status: response.status, value };
}
export async function preflight({ apiOrigin, serviceToken, fetchImpl = fetch, gateway }) {
  const base = origin(apiOrigin);
  const checks = {};
  const cases = [
    ['config', '/api/config', 'GET', undefined, 200],
    ['modelsMissing', '/api/prototype-model/v1/models', 'GET', undefined, 401],
    ['modelsInvalid', '/api/prototype-model/v1/models', 'GET', 'invalid-acceptance-token', 401],
    ['refreshMissing', '/api/internal/prototype-tokens/refresh', 'POST', undefined, 401],
    [
      'refreshInvalid',
      '/api/internal/prototype-tokens/refresh',
      'POST',
      'invalid-acceptance-token',
      401,
    ],
    ['legacyRefresh', '/internal/prototype-tokens/refresh', 'POST', undefined, 404],
  ];
  if (serviceToken)
    cases.push([
      'serviceAuthOnly',
      '/api/internal/prototype-tokens/refresh',
      'POST',
      serviceToken,
      422,
    ]);
  for (const [name, pathname, method, token, expected] of cases) {
    try {
      const response = await boundedHttp(
        `${base}${pathname}`,
        {
          method,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(method === 'POST' ? { body: '{}' } : {}),
        },
        fetchImpl,
      );
      checks[name] = {
        status: response.status,
        expected,
        result: response.status === expected ? 'PASS' : 'FAIL',
      };
    } catch {
      checks[name] = { result: 'BLOCKED_BY_ENVIRONMENT', code: 'ACCEPTANCE_HTTP_UNAVAILABLE' };
    }
  }
  if (!serviceToken)
    checks.serviceAuthOnly = {
      result: 'BLOCKED_BY_ENVIRONMENT',
      code: 'ACCEPTANCE_SERVICE_IDENTITY_MISSING',
    };
  if (gateway) {
    try {
      const version = await gateway.probe();
      checks.gateway = {
        result: 'PASS',
        api: version.api,
        version: /^v?[0-9.]+$/.test(version.version ?? '') ? version.version : 'unknown',
      };
    } catch {
      checks.gateway = { result: 'BLOCKED_BY_ENVIRONMENT', code: 'ACCEPTANCE_GATEWAY_UNAVAILABLE' };
    }
  }
  return {
    checks,
    paidProviderPosts: 0,
    productionStoreWrites: 0,
    deployedCommit: 'unknown',
    deployedImageDigest: 'unknown',
  };
}
