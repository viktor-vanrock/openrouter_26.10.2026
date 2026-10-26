/** Prepare a dedicated pinned installed-binary candidate; never calls a model or enables a release pin. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import { digest, writePrivate } from '../src/adapter-acceptance.js';
import { SandboxGatewayClient } from '../src/sandbox-gateway-client.js';
const exec = promisify(execFile);
dotenv.config({ quiet: true });
const resume = process.argv.indexOf('--resume');
const directory =
  resume >= 0
    ? path.dirname(path.resolve(process.argv[resume + 1]))
    : path.resolve('.prototype-dev', `gateway-agent-image-${Date.now()}`);
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
const receiptFile = path.join(directory, 'receipt.json');
const receipt =
  resume >= 0
    ? JSON.parse(await fs.readFile(path.resolve(process.argv[resume + 1])))
    : {
        at: new Date().toISOString(),
        providerPosts: 0,
        productionDbWrites: 0,
        releasePinUpdated: false,
        purpose: 'dedicated installed agent candidate / no-model runtime and network probe',
      };
const gateway = await SandboxGatewayClient.fromConfig({
  url: process.env.SANDBOX_GATEWAY_URL,
  token: process.env.SANDBOX_GATEWAY_TOKEN,
  caFile: process.env.SANDBOX_GATEWAY_CA_FILE,
});
const save = () => writePrivate(receiptFile, receipt);
const idOk = (v) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
try {
  await gateway.probe();
  if (!receipt.imageBuildId) {
    if (resume >= 0) throw new Error('AGENT_UNKNOWN_BUILD_RECONCILE_REQUIRED');
    const context = path.join(directory, 'context');
    await fs.mkdir(path.join(context, 'runner'), { recursive: true });
    for (const file of ['Dockerfile', 'runtime-lock.json'])
      await fs.copyFile(
        `apps/prototype-service/deploy/gateway/agent/${file}`,
        path.join(context, file),
      );
    await fs.copyFile(
      'apps/prototype-service/src/gateway-agent-launch.mjs',
      path.join(context, 'runner/launch.mjs'),
    );
    await fs.copyFile(
      'apps/prototype-service/src/gateway-agent-runtime-probe.mjs',
      path.join(context, 'runner/runtime-probe.mjs'),
    );
    await fs.copyFile(
      'apps/prototype-service/scripts/gateway-adapter-sandbox.mjs',
      path.join(context, 'runner/gateway-adapter-sandbox.mjs'),
    );
    // Synthetic provider only. Binary is executed exclusively inside the Gateway sandbox.
    let hostile = await fs.readFile(
      'packages/prototype-worker/scripts/opencode-hostile-config.mjs',
      'utf8',
    );
    hostile = hostile.replace(
      "path.join(repositoryRoot, 'node_modules/opencode-darwin-arm64/bin/opencode')",
      "'/opt/prototype/opencode/opencode'",
    );
    await fs.writeFile(path.join(context, 'runner/hostile-config.mjs'), hostile);
    const archive = path.join(directory, 'context.tar.gz');
    await exec('tar', ['-czf', archive, '-C', context, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const bytes = await fs.readFile(archive);
    receipt.contextDigest = digest(bytes);
    receipt.phase = 'build_dispatch_intent';
    await save();
    const build = await gateway.request('POST', '/images', {
      body: bytes,
      contentType: 'application/gzip',
      timeoutMs: 30000,
    });
    if (!idOk(build?.id)) throw new Error('AGENT_BUILD_ID_INVALID');
    receipt.imageBuildId = build.id;
    receipt.phase = 'building';
    await save();
  }
  if (!idOk(receipt.imageBuildId)) throw new Error('AGENT_BUILD_ID_INVALID');
  if (!receipt.image) {
    const until = Date.now() + 15 * 60000;
    let result, previous;
    while (Date.now() < until) {
      result = await gateway.request('GET', `/images/${receipt.imageBuildId}`);
      if (['ready', 'failed'].includes(result.state)) break;
      const phase = `${result.state}/${result.phase}`;
      if (phase !== previous) {
        console.log(
          JSON.stringify({
            event: 'agent.image.progress',
            state: result.state,
            phase: result.phase,
          }),
        );
        previous = phase;
      }
      await delay(5000);
    }
    if (result?.state !== 'ready') {
      receipt.phase = result?.state === 'failed' ? 'build_failed' : 'build_pending';
      const state = await gateway.request('GET', `/images/${receipt.imageBuildId}?log=1`, {
        maxBytes: 2 * 1024 * 1024,
      });
      if (state.log)
        await fs.writeFile(path.join(directory, 'build.log'), state.log, { mode: 0o600 });
      throw new Error('AGENT_IMAGE_NOT_READY');
    }
    const final = await gateway.request('GET', `/images/${receipt.imageBuildId}?log=1`, {
      maxBytes: 2 * 1024 * 1024,
    });
    const pin = final.log?.match(/pushing manifest for (\S+@sha256:[a-f0-9]{64})/);
    if (!pin || pin[1].split('@')[0] !== result.image)
      throw new Error('AGENT_IMAGE_PIN_UNAVAILABLE');
    receipt.image = `${result.image.replace(/:[^/:]+$/, '')}@${pin[1].split('@')[1]}`;
    if (final.log)
      await fs.writeFile(path.join(directory, 'build.log'), final.log, { mode: 0o600 });
    receipt.phase = 'image_ready';
    await save();
  }
  if (receipt.sandboxDispatchIntent || receipt.sandboxId)
    throw new Error('AGENT_EXISTING_SANDBOX_RECONCILE_REQUIRED');
  receipt.sandboxDispatchIntent = true;
  await save();
  const sandbox = await gateway.request('POST', '/sandboxes', {
    body: {
      image: receipt.image,
      cpus: 1,
      memory_mb: 1024,
      storage_mb: 2048,
      name: `agent_runtime_${receipt.imageBuildId.slice(0, 16)}`,
      labels: { tool: 'prototype-agent-image-acceptance', run: receipt.imageBuildId.slice(0, 40) },
    },
  });
  if (!idOk(sandbox?.id)) throw new Error('AGENT_SANDBOX_ID_INVALID');
  receipt.sandboxId = sandbox.id;
  receipt.phase = 'sandbox_starting';
  await save();
  const base = `/sandboxes/${sandbox.id}`,
    until = Date.now() + 120000;
  let state;
  while (Date.now() < until) {
    state = await gateway.request('GET', `${base}?wait=10`, { timeoutMs: 15000 });
    if (state.state === 'ready' || state.state === 'failed') break;
  }
  if (state?.state !== 'ready') {
    const diag = await gateway.request('GET', `${base}/diagnostics`);
    receipt.diagnostics = {
      state: diag.state,
      reason: diag.reason,
      events: Array.isArray(diag.events)
        ? diag.events.map((x) => ({ reason: x.reason, message: x.message })).slice(-10)
        : [],
    };
    throw new Error('AGENT_SANDBOX_NOT_READY');
  }
  receipt.phase = 'runtime_probe_dispatch_intent';
  await save();
  const session = await gateway.request('POST', `${base}/sessions`, {
    body: { argv: ['node', '/opt/prototype/agent/launch.mjs', 'runtime-probe'], cwd: '/work' },
  });
  if (!idOk(session?.id)) throw new Error('AGENT_SESSION_ID_INVALID');
  receipt.sessionId = session.id;
  receipt.phase = 'runtime_probing';
  await save();
  const sessionUntil = Date.now() + 95000;
  let ended;
  while (Date.now() < sessionUntil) {
    const s = await gateway.request('GET', `${base}/sessions/${session.id}`);
    if (!s.running) {
      ended = s;
      break;
    }
    await delay(1000);
  }
  if (!ended) throw new Error('AGENT_RUNTIME_DEADLINE');
  const bytes = await gateway.request(
    'GET',
    `${base}/files?path=%2Frun%2Finput%2Fagent-runtime-result.json`,
    { raw: true, maxBytes: 64000 },
  );
  receipt.runtime = JSON.parse(bytes);
  receipt.exitCode = ended.exit_code;
  if (receipt.runtime.passed) {
    receipt.phase = 'hostile_config_dispatch_intent';
    await save();
    const hostile = await gateway.request('POST', `${base}/sessions`, {
      body: {
        argv: ['node', '/opt/prototype/agent/launch.mjs', 'hostile-config'],
        cwd: '/work',
      },
    });
    if (!idOk(hostile?.id)) throw new Error('AGENT_SESSION_ID_INVALID');
    receipt.hostileSessionId = hostile.id;
    await save();
    const hostileDeadline = Date.now() + 120000;
    let hostileEnd;
    while (Date.now() < hostileDeadline) {
      const state = await gateway.request('GET', `${base}/sessions/${hostile.id}`);
      if (!state.running) {
        hostileEnd = state;
        break;
      }
      await delay(1000);
    }
    if (!hostileEnd) throw new Error('AGENT_HOSTILE_DEADLINE');
    const logs = await gateway.request('GET', `${base}/sessions/${hostile.id}/logs`, {
      raw: true,
      maxBytes: 256000,
    });
    await fs.writeFile(path.join(directory, 'hostile-config.log'), logs, { mode: 0o600 });
    receipt.hostileConfig = {
      exitCode: hostileEnd.exit_code,
      passed: hostileEnd.exit_code === 0 && logs.toString().includes('"status":"PASS"'),
    };
  }
  receipt.phase = 'runtime_probe_finished';
  receipt.result =
    receipt.runtime.passed && receipt.hostileConfig?.passed
      ? 'RUNTIME_PASS_EGRESS_UNACCEPTED'
      : 'RUNTIME_FAIL';
} catch (error) {
  receipt.result = 'BLOCKED_BY_ENVIRONMENT';
  receipt.code = /^[A-Z_]+$/.test(error.message ?? '')
    ? error.message
    : 'AGENT_IMAGE_OPERATION_FAILED';
  receipt.httpStatus = error.status ?? null;
  process.exitCode = 2;
} finally {
  if (receipt.sandboxId && idOk(receipt.sandboxId)) {
    if (receipt.hostileSessionId)
      await gateway
        .request('DELETE', `/sandboxes/${receipt.sandboxId}/sessions/${receipt.hostileSessionId}`)
        .catch(() => {});
    if (receipt.sessionId)
      await gateway
        .request('DELETE', `/sandboxes/${receipt.sandboxId}/sessions/${receipt.sessionId}`)
        .catch(() => {});
    try {
      await gateway.request('DELETE', `/sandboxes/${receipt.sandboxId}`);
      receipt.cleanup = 'delete_acknowledged; cgroup stop unknown';
    } catch {
      receipt.cleanup = 'stop_unknown';
    }
  }
  await save();
  console.log(JSON.stringify({ ...receipt, evidenceFile: receiptFile }));
}
