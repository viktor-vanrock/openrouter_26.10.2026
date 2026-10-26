/** Default is read-only preflight. Explicit approved modes never enable intake or retry POST. */
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  digest,
  fail,
  safeCode,
  origin,
  storeScope,
  readPrivate,
  writePrivate,
  tuple,
  makePlan,
  approve,
  boundedHttp,
  preflight,
} from '../src/adapter-acceptance.js';
import { SandboxGatewayClient } from '../src/sandbox-gateway-client.js';
import { GatewayExecutionRepository } from '../src/gateway-execution-repository.js';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const mongoose = require('mongoose');
const { createPrototypeStoreModels, createPrototypeMethods } = require('@librechat/data-schemas');
const idOk = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

async function connectStore(env, plan) {
  if (
    storeScope(env.PROTOTYPE_MONGO_URI).fingerprint !== plan.scope?.fingerprint ||
    env.PROTOTYPE_MONGO_URI === env.MONGO_URI
  )
    fail('ACCEPTANCE_STORE_MISMATCH');
  // Index creation is deployment-owned; connecting this probe must not create shared indexes.
  const store = new mongoose.Mongoose();
  try {
    await store.connect(env.PROTOTYPE_MONGO_URI, {
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 3000,
    });
    const hello = await store.connection.db.admin().command({ hello: 1 });
    if (!hello.setName || !hello.isWritablePrimary) fail('ACCEPTANCE_REPLICA_PRIMARY_REQUIRED');
    createPrototypeStoreModels(store);
    return store;
  } catch {
    await store.disconnect();
    fail('ACCEPTANCE_STORE_UNAVAILABLE');
  }
}
export async function fixture(store, plan, out) {
  const c = plan.command,
    models = store.models,
    methods = createPrototypeMethods(store);
  if (await models.PrototypeJob.findOne({ jobId: c.jobId }).lean())
    fail('ACCEPTANCE_FIXTURE_ALREADY_EXISTS');
  // Durable private intent precedes transaction. No outbox means no ordinary Redis intake.
  await writePrivate(
    path.join(out, 'fixture-intent.json'),
    { planDigest: digest(plan), command: c },
    true,
  );
  const session = await store.startSession();
  try {
    await session.withTransaction(async () => {
      const input = {
        jobId: c.jobId,
        userId: c.userId,
        tenantId: c.tenantId,
        conversationId: `acceptance_${plan.runId}`,
        originMessageId: `acceptance_${plan.runId}`,
        originToolCallId: `acceptance_${plan.runId}`,
        status: 'queued',
        modelId: c.modelId,
        modelPolicyVersion: 'acceptance-only-v1',
        modelRecommendation: 'not_recommended',
        revision: 0,
        fenceToken: 1,
        generation: plan.generation,
        activeTurnId: c.turnId,
        activeCommandId: c.commandId,
        activeAttemptId: c.attemptId,
        activeExecutionId: c.executionId,
        activeStage: 'generation',
      };
      // Validate the complete schema, including generation pins, before existing upsert method.
      await new models.PrototypeJob(input).validate();
      const created = await methods.createPrototypeJob(input, session);
      if (!created.created) fail('ACCEPTANCE_FIXTURE_CONFLICT');
      await models.PrototypeTurn.create(
        [
          {
            turnId: c.turnId,
            jobId: c.jobId,
            ordinal: 0,
            kind: 'initial',
            text: 'Bounded adapter acceptance; no planner or product generation.',
            modelId: c.modelId,
            commandId: c.commandId,
            status: 'running',
            generation: plan.generation,
          },
        ],
        { session },
      );
      await methods.transitionPrototypeJob({
        jobId: c.jobId,
        expectedRevision: 0,
        from: 'queued',
        to: 'preparing',
        patch: {},
        session,
      });
      await methods.transitionPrototypeJob({
        jobId: c.jobId,
        expectedRevision: 1,
        from: 'preparing',
        to: 'running',
        patch: {},
        session,
      });
      await methods.registerPrototypeLease({ ...tuple(c), expectedRevision: 2, session });
      // A fixture that never reaches refresh must still have bounded mint authority.
      await store.connection.db.collection('prototypemodelturnleases').insertOne(
        {
          _id: c.turnId,
          jobId: c.jobId,
          deadlineAt: new Date(Date.now() + plan.ceilings.turnMs),
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
  return {
    result: 'PASS',
    jobId: c.jobId,
    revision: 2,
    planner: 'not exercised',
    authorityDeadlineMs: 600000,
  };
}
export async function assertOwn(store, plan, active = true) {
  const c = plan.command;
  const job = await store.models.PrototypeJob.findOne({
    jobId: c.jobId,
    userId: c.userId,
    tenantId: c.tenantId,
    conversationId: `acceptance_${plan.runId}`,
    originToolCallId: `acceptance_${plan.runId}`,
    modelId: c.modelId,
  }).lean();
  if (
    !job ||
    Object.entries(plan.generation).some(([key, value]) => job.generation?.[key] !== value) ||
    (active &&
      (job.status !== 'running' ||
        job.revision !== c.expectedRevision ||
        job.fenceToken !== c.fenceToken ||
        job.activeLeaseId !== c.leaseId ||
        job.activeTurnId !== c.turnId ||
        job.activeCommandId !== c.commandId ||
        job.activeAttemptId !== c.attemptId ||
        job.activeExecutionId !== c.executionId))
  )
    fail('ACCEPTANCE_OWN_AUTHORITY_REQUIRED');
  return job;
}
async function credentials(env, plan) {
  if (!/^[a-f0-9]{64}$/.test(env.PROTOTYPE_SERVICE_TOKEN ?? ''))
    fail('ACCEPTANCE_SERVICE_IDENTITY_REQUIRED');
  const reply = await boundedHttp(
    `${origin(plan.apiOrigin)}/api/internal/prototype-tokens/refresh`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PROTOTYPE_SERVICE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tuple(plan.command)),
    },
  );
  if (reply.status !== 200) fail('ACCEPTANCE_ACTIVE_REFRESH_FAILED');
  const expiresAt = Date.parse(reply.value?.expiresAt);
  if (
    typeof reply.value?.token !== 'string' ||
    reply.value.token.length > 16384 ||
    !(expiresAt > Date.now()) ||
    expiresAt > Date.now() + 45000
  )
    fail('ACCEPTANCE_TOKEN_INVALID');
  // Decode only to compare server-issued identity; discovery/DB prove acceptance, no client JWT signing.
  let claims;
  try {
    claims = JSON.parse(Buffer.from(reply.value.token.split('.')[1], 'base64url'));
  } catch {
    fail('ACCEPTANCE_TOKEN_INVALID');
  }
  const expected = {
    ...tuple(plan.command),
    userId: plan.selection.owner,
    tenantId: plan.selection.tenant,
    modelId: plan.selection.model,
    revision: plan.command.expectedRevision,
  };
  if (
    Object.entries(expected).some(([k, v]) => claims[k] !== v) ||
    claims.exp * 1000 !== expiresAt ||
    claims.iss !== 'chatrouter-prototype-model' ||
    claims.aud !== 'prototype-model-proxy'
  )
    fail('ACCEPTANCE_TOKEN_IDENTITY_INVALID');
  return { token: reply.value.token, expiresAt: reply.value.expiresAt };
}
export async function cancel(store, plan) {
  const job = await assertOwn(store, plan, false);
  if (job.status === 'canceled') return { result: 'PASS', status: 'canceled' };
  const session = await store.startSession();
  try {
    await session.withTransaction(async () => {
      await createPrototypeMethods(store).transitionPrototypeJob({
        jobId: job.jobId,
        expectedRevision: job.revision,
        from: job.status,
        to: 'canceled',
        fenceToken: job.fenceToken,
        patch: {
          fenceToken: job.fenceToken + 1,
          accessRevokedAt: new Date(),
          completedAt: new Date(),
        },
        session,
      });
      await store.models.PrototypeTurn.updateOne(
        { turnId: plan.command.turnId, jobId: job.jobId },
        { $set: { status: 'canceled' } },
        { session, runValidators: true },
      );
    });
  } finally {
    await session.endSession();
  }
  return {
    result: 'PASS',
    status: 'canceled',
    retained: 'authority, budgets, requests and cleanup journal',
  };
}
export async function cleanupGateway(store, env, plan, deps = {}) {
  const row = await store.models.PrototypeGatewayExecution.findOne({
    commandId: plan.command.commandId,
  }).lean();
  if (!row) return { sandbox: 'none recorded', stopEvidence: 'not applicable' };
  if (
    row.runId !== plan.runId ||
    row.jobId !== plan.command.jobId ||
    row.userId !== plan.selection.owner ||
    row.tenantId !== plan.selection.tenant ||
    row.image !== plan.image
  )
    fail('ACCEPTANCE_OWN_GATEWAY_REQUIRED');
  if (!row.sandboxId)
    return {
      result: 'BLOCKED_BY_ENVIRONMENT',
      cleanup: 'create_outcome_unknown',
      next: 'Gateway operator reconcile own run label before retry',
      stopEvidence: 'stop_unknown',
    };
  if (!idOk(row.sandboxId) || (row.sessionId && !idOk(row.sessionId)))
    fail('ACCEPTANCE_GATEWAY_ID_INVALID');
  const gateway =
    deps.gateway ??
    (await SandboxGatewayClient.fromConfig({
      url: env.SANDBOX_GATEWAY_URL,
      token: env.SANDBOX_GATEWAY_TOKEN,
      caFile: env.SANDBOX_GATEWAY_CA_FILE,
    }));
  if (row.sessionId)
    await gateway
      .request('DELETE', `/sandboxes/${row.sandboxId}/sessions/${row.sessionId}`)
      .catch(() => {});
  let cleanup;
  try {
    await gateway.request('DELETE', `/sandboxes/${row.sandboxId}`);
    cleanup = 'delete_acknowledged';
  } catch {
    cleanup = 'stop_unknown';
  }
  const ledger =
    deps.ledger ??
    new GatewayExecutionRepository({
      model: store.models.PrototypeGatewayExecution,
      jobs: store.models.PrototypeJob,
    });
  await ledger.update(plan.command, row.ledgerRevision, { cleanup }, { requireActive: false });
  return { cleanup, stopEvidence: 'stop_unknown', result: 'BLOCKED_BY_ENVIRONMENT' };
}
async function remote(store, env, plan, mode, out, receipt, save) {
  await assertOwn(store, plan);
  const gateway = await SandboxGatewayClient.fromConfig({
    url: env.SANDBOX_GATEWAY_URL,
    token: env.SANDBOX_GATEWAY_TOKEN,
    caFile: env.SANDBOX_GATEWAY_CA_FILE,
  });
  const ledger = new GatewayExecutionRepository({
    model: store.models.PrototypeGatewayExecution,
    jobs: store.models.PrototypeJob,
  });
  const begun = await ledger.begin(plan.command, {
    image: plan.image,
    inputDigest: digest({ mode, planDigest: digest(plan) }),
    runId: plan.runId,
  });
  if (!begun.created) fail('ACCEPTANCE_EXISTING_INTENT_RECONCILE_REQUIRED');
  let revision = begun.record.ledgerRevision,
    sandbox,
    session;
  const update = async (changes, requireActive = true) => {
    const row = await ledger.update(plan.command, revision, changes, { requireActive });
    revision = row.ledgerRevision;
  };
  receipt.gateway = { phase: 'create_intent', image: plan.image, stopEvidence: 'stop_unknown' };
  await save();
  try {
    const created = await gateway.request('POST', '/sandboxes', {
      body: {
        image: plan.image,
        cpus: 1,
        memory_mb: 1024,
        storage_mb: 4096,
        name: `adapter_acceptance_${plan.runId}`,
        labels: { tool: 'chatrouter-adapter-acceptance', run: plan.runId },
      },
    });
    if (!idOk(created.id)) fail('ACCEPTANCE_GATEWAY_ID_INVALID');
    sandbox = created.id;
    receipt.gateway.sandboxId = sandbox;
    await update({ phase: 'starting', sandboxId: sandbox });
    await save();
    const base = `/sandboxes/${sandbox}`,
      deadline = Date.now() + 120000;
    let ready = false;
    while (Date.now() < deadline) {
      const state = await gateway.request('GET', `${base}?wait=10`, { timeoutMs: 15000 });
      if (state.state === 'ready') {
        ready = true;
        break;
      }
      if (state.state === 'failed') fail('ACCEPTANCE_GATEWAY_START_FAILED');
    }
    if (!ready) fail('ACCEPTANCE_GATEWAY_START_DEADLINE');
    const runner = await fs.readFile(new URL('./gateway-adapter-sandbox.mjs', import.meta.url));
    await gateway.request(
      'PUT',
      `${base}/files?path=%2Frun%2Finput%2Fgateway-adapter-sandbox.mjs`,
      { body: runner },
    );
    const input = {
      baseUrl: `${plan.apiOrigin}/api/prototype-model/v1`,
      model: plan.selection.model,
      mode,
      quoteUsd: plan.quoteUsd,
      requestIds: [0, 1].map((i) => `acceptance_${plan.runId}_${i}`),
    };
    // Trusted dispatch IDs are recorded before any remote session/model POST.
    await writePrivate(
      path.join(out, 'request-intent.json'),
      { requestIds: input.requestIds, inputDigest: digest(input), mode },
      true,
    );
    await gateway.request('PUT', `${base}/files?path=%2Frun%2Finput%2Fadapter-input.json`, {
      body: Buffer.from(JSON.stringify(input)),
    });
    const scoped = await credentials(env, plan);
    receipt.tokenExpiresAt = scoped.expiresAt;
    await update({ phase: 'session_intent' });
    receipt.gateway.phase = 'session_intent';
    await save();
    const started = await gateway.request('POST', `${base}/sessions`, {
      body: {
        argv: ['node', '/run/input/gateway-adapter-sandbox.mjs'],
        cwd: '/run/input',
        env: { PROTOTYPE_SCOPED_TOKEN: scoped.token },
      },
    });
    if (!idOk(started.id)) fail('ACCEPTANCE_GATEWAY_ID_INVALID');
    session = started.id;
    receipt.gateway.sessionId = session;
    await update({ phase: 'running', sessionId: session });
    await save();
    let complete,
      renewed = false;
    const sessionDeadline = Date.now() + 95000;
    while (Date.now() < sessionDeadline) {
      const state = await gateway.request('GET', `${base}/sessions/${session}`);
      if (!state.running) {
        complete = state;
        break;
      }
      if (mode === 'live' && !renewed) {
        let needed = false;
        try {
          await gateway.request('GET', `${base}/files?path=%2Frun%2Finput%2Frenew-needed`, {
            raw: true,
            maxBytes: 10,
          });
          needed = true;
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        if (needed) {
          const renewal = await credentials(env, plan);
          await gateway.request('PUT', `${base}/files?path=%2Frun%2Finput%2Fscoped-renewal.json`, {
            body: Buffer.from(JSON.stringify(renewal)),
          });
          renewed = true;
          receipt.renewal = {
            expiresAt: renewal.expiresAt,
            result: 'issued; consumption requires follow-up success',
          };
          await save();
        }
      }
      await delay(1000);
    }
    if (!complete) fail('ACCEPTANCE_GATEWAY_SESSION_DEADLINE');
    const bytes = await gateway.request(
      'GET',
      `${base}/files?path=%2Frun%2Finput%2Fadapter-result.json`,
      { raw: true, maxBytes: 64000 },
    );
    const result = JSON.parse(bytes);
    // Whitelist remote evidence; never copy logs/arbitrary tool text into trusted receipt.
    receipt.remote = {
      discovery: result.discovery,
      providerPostAttempts: result.providerPostAttempts,
      usableResult: result.usableResult === true,
      toolExecuted: result.tool?.executed === true,
    };
    receipt.remote.negatives = Object.fromEntries(
      ['replay', 'changedBody', 'modelMismatch'].map((name) => [
        name,
        {
          status: Number.isInteger(result.negatives?.[name]?.status)
            ? result.negatives[name].status
            : null,
        },
      ]),
    );
    receipt.durableRequests = [];
    for (const requestId of input.requestIds) {
      const row = await store.connection.db
        .collection('prototypeagentrequests')
        .findOne({ jobId: plan.command.jobId, turnId: plan.command.turnId, requestId });
      if (row)
        receipt.durableRequests.push({
          requestId,
          requestDigest: row.requestDigest,
          status: row.status,
          reservedMicros: row.reservedMicros,
          actualMicros: row.actualMicros ?? null,
          promptTokens: row.promptTokens ?? null,
          completionTokens: row.completionTokens ?? null,
        });
    }
    const rows = await store.connection.db
      .collection('prototypeagentrequests')
      .find(
        { jobId: plan.command.jobId, turnId: plan.command.turnId },
        { projection: { requestId: 1, status: 1 }, limit: 9 },
      )
      .toArray();
    receipt.durableReservationCount = rows.length;
    receipt.paidProviderPosts = mode === 'live' ? null : 0;
    receipt.remote.actualCostUsd =
      receipt.durableRequests.length === 2 &&
      receipt.durableRequests.every((row) => Number.isSafeInteger(row.actualMicros))
        ? receipt.durableRequests.reduce((sum, row) => sum + row.actualMicros, 0) / 1000000
        : null;
    await save();
    if (
      complete.exit_code !== 0 ||
      result.discovery !== 200 ||
      (mode === 'live' &&
        (!result.usableResult ||
          !result.tool?.executed ||
          result.providerPostAttempts !== 2 ||
          receipt.durableRequests.length !== 2 ||
          receipt.durableRequests.some((row) => row.status !== 'settled') ||
          rows.length !== 2 ||
          receipt.durableRequests.some(
            (row) =>
              result.requests?.find((v) => v.requestId === row.requestId)?.requestDigest !==
              row.requestDigest,
          ) ||
          receipt.remote.actualCostUsd == null ||
          receipt.remote.actualCostUsd > plan.ceilings.usd ||
          !renewed ||
          result.negatives?.replay?.status !== 409 ||
          result.negatives?.changedBody?.status !== 409 ||
          result.negatives?.modelMismatch?.status !== 422))
    )
      fail('ACCEPTANCE_REMOTE_GATES_FAILED');
    await update({ phase: 'response_received' });
    receipt.gateway.phase = 'response_received';
    receipt.extraBillingEvidence =
      'requires provider/API operator journal; durable reservations alone do not prove upstream POST count';
  } catch (error) {
    receipt.gateway.phase = 'outcome_unknown';
    await update({ phase: 'outcome_unknown', errorCode: safeCode(error) }, false).catch(() => {
      receipt.ledgerUpdate = 'unknown';
    });
    throw error;
  } finally {
    if (sandbox) {
      if (session)
        await gateway
          .request('DELETE', `/sandboxes/${sandbox}/sessions/${session}`)
          .catch(() => {});
      try {
        await gateway.request('DELETE', `/sandboxes/${sandbox}`);
        receipt.gateway.cleanup = 'delete_acknowledged';
      } catch {
        receipt.gateway.cleanup = 'stop_unknown';
      }
      await update({ cleanup: receipt.gateway.cleanup }, false).catch(() => {
        receipt.ledgerUpdate = 'unknown';
      });
    } else
      receipt.gateway.cleanup =
        'create_outcome_unknown; reconcile durable own run label before any retry';
    await save();
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  dotenv.config({ path: path.join(root, '.env'), quiet: true, processEnv: env });
  const modes = ['preflight', 'plan', 'fixture', 'token', 'gateway-discovery', 'live', 'cleanup'];
  const mode = args[0] ?? 'preflight';
  if (!modes.includes(mode)) fail('ACCEPTANCE_MODE_INVALID');
  const option = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? null : args[i + 1];
  };
  const apiOrigin = origin(env.PROTOTYPE_ACCEPTANCE_API_ORIGIN ?? 'https://orchat.sberai-rnd.ru');
  const at = new Date();
  const receipt = {
    at: at.toISOString(),
    moscow: at.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }),
    mode,
    callingCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    deployedCommit: 'unknown',
    deployedImageDigest: 'unknown',
    result: 'BLOCKED_BY_ENVIRONMENT',
    paidProviderPosts: mode === 'live' ? null : 0,
  };
  const plan = ['preflight', 'plan'].includes(mode) ? null : await readPrivate(option('--plan'));
  const out = plan
    ? path.join(root, '.prototype-dev', `adapter-gateway-acceptance-${plan.runId}`)
    : path.join(root, '.prototype-dev', `adapter-gateway-acceptance-${at.getTime()}`);
  if (plan && (!/^[a-f0-9]{24}$/.test(plan.runId) || origin(plan.apiOrigin) !== apiOrigin))
    fail('ACCEPTANCE_PLAN_INVALID');
  await fs.mkdir(out, { recursive: true, mode: 0o700 });
  const outStat = await fs.lstat(out);
  if (!outStat.isDirectory() || outStat.isSymbolicLink() || outStat.uid !== process.getuid())
    fail('ACCEPTANCE_PRIVATE_DIRECTORY_REQUIRED');
  await fs.chmod(out, 0o700);
  const receiptFile = path.join(out, `receipt-${mode}-${at.getTime()}.json`);
  const save = () => writePrivate(receiptFile, receipt);
  let store;
  try {
    if (mode === 'preflight') {
      let gateway;
      if (env.SANDBOX_GATEWAY_URL && env.SANDBOX_GATEWAY_TOKEN)
        gateway = await SandboxGatewayClient.fromConfig({
          url: env.SANDBOX_GATEWAY_URL,
          token: env.SANDBOX_GATEWAY_TOKEN,
          caFile: env.SANDBOX_GATEWAY_CA_FILE,
        });
      Object.assign(
        receipt,
        await preflight({ apiOrigin, serviceToken: env.PROTOTYPE_SERVICE_TOKEN, gateway }),
      );
      receipt.result = Object.values(receipt.checks).some((v) => v.result === 'FAIL')
        ? 'FAIL'
        : Object.values(receipt.checks).every((v) => v.result === 'PASS')
          ? 'PASS'
          : 'BLOCKED_BY_ENVIRONMENT';
    } else if (mode === 'plan') {
      const pins = JSON.parse(
        await fs.readFile(
          path.join(root, 'apps/prototype-service/deploy/gateway/release-lock.json'),
        ),
      );
      const scope =
        env.PROTOTYPE_ACCEPTANCE_PRODUCTION_STORE_CONFIRMED === 'true'
          ? storeScope(env.PROTOTYPE_MONGO_URI)
          : null;
      const selection = option('--selection') ? await readPrivate(option('--selection')) : {};
      const metadata = option('--metadata') ? await readPrivate(option('--metadata')) : null;
      const prepared = makePlan({
        apiOrigin,
        scope,
        owner: selection.owner,
        tenant: selection.tenant,
        model: selection.model,
        conversation: selection.conversation,
        message: selection.message,
        pins,
        metadata,
        selectionVerified: selection.verifiedByOperator === true && !!selection.operator,
      });
      const planOut = path.join(
        root,
        '.prototype-dev',
        `adapter-gateway-acceptance-${prepared.runId}`,
      );
      await fs.mkdir(planOut, { recursive: true, mode: 0o700 });
      await writePrivate(path.join(planOut, 'plan.json'), prepared, true);
      receipt.plan = {
        ...prepared,
        planDigest: digest(prepared),
        file: path.join(planOut, 'plan.json'),
      };
      receipt.result = prepared.blockers.length ? 'BLOCKED_BY_ENVIRONMENT' : 'READY_FOR_APPROVAL';
    } else {
      const approval = await readPrivate(option('--approval'));
      approve(plan, approval, mode);
      receipt.planDigest = digest(plan);
      receipt.command = plan.command;
      receipt.scope = plan.scope;
      receipt.approval = {
        operator: approval.operator,
        actions: approval.actions,
        validUntil: approval.validUntil,
      };
      receipt.deployedCommit = approval.deployedCommit ?? 'unknown';
      receipt.deployedImageDigest = approval.deployedImageDigest ?? 'unknown';
      // Every production action must match operator-attested scope. No implicit URI fallback.
      store = await connectStore(env, plan);
      if (mode === 'fixture') receipt.fixture = await fixture(store, plan, out);
      else if (mode === 'cleanup') {
        receipt.cleanup = await cancel(store, plan);
        receipt.gatewayCleanup = await cleanupGateway(store, env, plan);
      } else {
        await assertOwn(store, plan);
        if (mode === 'token') {
          const scoped = await credentials(env, plan);
          const models = await boundedHttp(`${apiOrigin}/api/prototype-model/v1/models`, {
            headers: { Authorization: `Bearer ${scoped.token}` },
          });
          if (
            models.status !== 200 ||
            models.value?.data?.length !== 1 ||
            models.value.data[0].id !== plan.selection.model
          )
            fail('ACCEPTANCE_DISCOVERY_FAILED');
          receipt.token = { refresh: 200, discovery: 200, expiresAt: scoped.expiresAt };
        } else {
          // Never resume an existing remote create/session/model intent automatically.
          await remote(store, env, plan, mode, out, receipt, save);
        }
      }
      receipt.result =
        mode === 'live' || receipt.gatewayCleanup?.result === 'BLOCKED_BY_ENVIRONMENT'
          ? 'BLOCKED_BY_ENVIRONMENT'
          : 'PASS';
      if (mode === 'live')
        receipt.remainingGate =
          'operator upstream POST journal; full expiry/stale/cancel/egress acceptance';
    }
  } catch (error) {
    receipt.code = safeCode(error);
    receipt.result = 'BLOCKED_BY_ENVIRONMENT';
  } finally {
    if (store && ['live', 'gateway-discovery'].includes(mode)) {
      try {
        receipt.cleanup = await cancel(store, plan);
        const revoked = await boundedHttp(`${apiOrigin}/api/internal/prototype-tokens/refresh`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.PROTOTYPE_SERVICE_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(tuple(plan.command)),
        });
        receipt.cleanup.refreshAfterCancel = revoked.status;
        if (revoked.status !== 409) {
          receipt.result = 'BLOCKED_BY_ENVIRONMENT';
          receipt.cleanup.result = 'FAIL';
        }
      } catch {
        receipt.cleanup = { result: 'BLOCKED_BY_ENVIRONMENT', code: 'ACCEPTANCE_CLEANUP_UNKNOWN' };
        receipt.result = 'BLOCKED_BY_ENVIRONMENT';
      }
    }
    if (['live', 'gateway-discovery', 'cleanup'].includes(mode)) {
      try {
        const ordinary = await boundedHttp(`${apiOrigin}/api/config`);
        receipt.ordinaryApiAfter = {
          status: ordinary.status,
          result: ordinary.status === 200 ? 'PASS' : 'FAIL',
        };
        if (ordinary.status !== 200) receipt.result = 'BLOCKED_BY_ENVIRONMENT';
      } catch {
        receipt.ordinaryApiAfter = { result: 'BLOCKED_BY_ENVIRONMENT' };
        receipt.result = 'BLOCKED_BY_ENVIRONMENT';
      }
    }
    await store?.disconnect();
    await save();
  }
  console.log(JSON.stringify({ ...receipt, evidenceFile: receiptFile }));
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((value) => {
      if (value.result === 'BLOCKED_BY_ENVIRONMENT') process.exitCode = 2;
      else if (value.result === 'FAIL') process.exitCode = 1;
    })
    .catch((error) => {
      console.error(safeCode(error));
      process.exitCode = 2;
    });
}
