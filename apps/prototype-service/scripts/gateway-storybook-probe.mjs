/** Real Storybook MCP reachability/auth/tool call inside an owned Gateway sandbox; no model calls. */
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { SandboxGatewayClient } from '../src/sandbox-gateway-client.js';
import { loadPrototypeConfig } from '../src/config.js';
import { probeStorybookMcp } from '../src/storybook-mcp.js';
dotenv.config({ quiet: true });
const out = `.prototype-dev/storybook-gateway-${Date.now()}`;
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const evidence = { at: new Date().toISOString(), providerRequests: 0 };
const save = () =>
  fs.writeFile(`${out}/receipt.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
let gateway, sandbox;
try {
  evidence.local = await probeStorybookMcp();
  evidence.localDns = await lookup('storybook.ekim-evgeny.ru', { all: true });
  await save();
  if (!process.argv.includes('--gateway')) throw new Error('EXPLICIT_GATEWAY_PROBE_REQUIRED');
  const lock = JSON.parse(
    await fs.readFile('apps/prototype-service/deploy/gateway/release-lock.json'),
  );
  gateway = await SandboxGatewayClient.fromConfig(
    loadPrototypeConfig(process.env, 'orchestrator').gateway,
  );
  evidence.image = lock.build.image;
  evidence.state = 'create_reserved';
  await save();
  sandbox = (
    await gateway.request('POST', '/sandboxes', {
      body: {
        image: lock.build.image,
        cpus: 1,
        memory_mb: 512,
        storage_mb: 4096,
        name: `storybook_probe_${Date.now()}`,
        labels: { tool: 'chatrouter-storybook-probe' },
      },
    })
  ).id;
  evidence.sandboxId = sandbox;
  await save();
  const base = `/sandboxes/${sandbox}`;
  const deadline = Date.now() + 420000;
  let ready = false;
  while (Date.now() < deadline) {
    const status = await gateway.request('GET', `${base}?wait=10`, { timeoutMs: 20000 });
    if (status.state === 'ready') {
      ready = true;
      break;
    }
    if (status.state === 'failed') throw new Error('STORYBOOK_SANDBOX_START_FAILED');
    console.log('Storybook sandbox starting');
  }
  if (!ready) throw new Error('STORYBOOK_SANDBOX_START_DEADLINE');
  const source = await fs.readFile(new URL('../src/storybook-mcp.js', import.meta.url), 'utf8');
  const runner =
    source +
    `
const safe = value => String(value ?? '')
  .replace(/Bearer\\s+\\S+/gi, 'Bearer <REDACTED>').slice(0, 500);
try { console.log('STORYBOOK_PROBE=' + JSON.stringify(await probeStorybookMcp())); }
catch (error) {
  const dns = await import('node:dns/promises');
  const addresses = await dns.lookup('storybook.ekim-evgeny.ru', {all:true}).catch(()=>[]);
  const unauthenticated = await fetch('https://storybook.ekim-evgeny.ru/mcp', { method:'GET', redirect:'manual',
    headers:{Accept:'application/json, text/event-stream'}, signal:AbortSignal.timeout(10000) }).then(async response=>{
      let location;try{const url=new URL(response.headers.get('location'),'https://storybook.ekim-evgeny.ru/mcp');location=url.origin+url.pathname}catch{};
      await response.body?.cancel();return {status:response.status,location};
    }).catch(()=>({failed:true}));
  console.log('STORYBOOK_PROBE=' + JSON.stringify({ passed:false, addresses, unauthenticated,
  code:/^STORYBOOK_[A-Z0-9_]+$/.test(error.message)?error.message:'STORYBOOK_CONNECTION_FAILED',
  name:error.name, phase:error.phase, redirectLocation:safe(error.redirectLocation), sameTarget:error.sameTarget,
  queryKeys:error.queryKeys, server:safe(error.server), message:safe(error.message), cause:safe(error.cause?.message),
  causes:(error.cause?.errors??[]).map(e=>({code:safe(e.code),message:safe(e.message)})).slice(0,4) })); process.exitCode=1; }
`;
  await gateway.request('PUT', `${base}/files?path=%2Frun%2Finput%2Fstorybook-probe.mjs`, {
    body: Buffer.from(runner),
  });
  evidence.state = 'session_reserved';
  await save();
  const session = await gateway.request('POST', `${base}/sessions`, {
    body: {
      argv: ['node', '/run/input/storybook-probe.mjs'],
      cwd: '/run/input',
      env: {},
    },
  });
  evidence.sessionId = session.id;
  await save();
  let completed;
  const sessionDeadline = Date.now() + 70000;
  while (Date.now() < sessionDeadline) {
    const state = await gateway.request('GET', `${base}/sessions/${session.id}`);
    if (!state.running) {
      completed = state;
      break;
    }
    await delay(1000);
  }
  if (!completed) throw new Error('STORYBOOK_PROBE_DEADLINE');
  const log = await gateway.request(
    'GET',
    `${base}/sessions/${session.id}/logs?stream=stdout&offset=0`,
    { raw: true, maxBytes: 64000 },
  );
  const line = log
    .toString()
    .split('\n')
    .find((line) => line.startsWith('STORYBOOK_PROBE='));
  evidence.gateway = JSON.parse(line?.slice('STORYBOOK_PROBE='.length) ?? '{}');
  if (completed.exit_code !== 0 || evidence.gateway.passed !== true)
    throw new Error(evidence.gateway.code ?? 'STORYBOOK_PROBE_FAILED');
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.code = /^STORYBOOK_|^GATEWAY_/.test(error.message)
    ? error.message
    : 'STORYBOOK_PROBE_FAILED';
  evidence.phase = error.phase;
  process.exitCode = 1;
} finally {
  if (sandbox) {
    try {
      await gateway.request('DELETE', `/sandboxes/${sandbox}`);
      evidence.cleanup = 'delete_acknowledged';
    } catch {
      evidence.cleanup = 'stop_unknown';
    }
  }
  await save();
  console.log(JSON.stringify({ ...evidence, evidenceDirectory: out }));
}
