import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const binary = path.join(repositoryRoot, 'node_modules/opencode-darwin-arm64/bin/opencode');
const canary = 'synthetic-opencode-auth-canary';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(args, env, cwd = repositoryRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        return reject(new Error(
          `OpenCode ${args[0]} exited ${code}: ${(stderr || stdout).slice(0, 2_000)}`,
        ));
      }
      resolve({ stdout, stderr });
    });
  });
}

function cleanEnvironment(base, config) {
  return {
    PATH: process.env.PATH,
    HOME: path.join(base, 'home'),
    XDG_CACHE_HOME: path.join(base, 'cache'),
    XDG_CONFIG_HOME: path.join(base, 'config'),
    XDG_DATA_HOME: path.join(base, 'data'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  };
}

function completion(res, body) {
  const serialized = JSON.stringify(body.messages ?? []);
  const text = serialized.includes('CONTINUE_AFTER_IMPORT') && serialized.includes('PROCESS_A_OK')
    ? 'CONTINUITY_OK REQUIREMENT_ALPHA'
    : 'PROCESS_A_OK REQUIREMENT_ALPHA';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({
    id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id: 'chatcmpl-fake', object: 'chat.completion.chunk', created: 1, model: 'fake-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function main() {
  await fs.access(binary);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-opencode-continuity-'));
  const processA = path.join(root, 'process-a');
  const processB = path.join(root, 'process-b');
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  await Promise.all([processA, processB, workspaceA, workspaceB].map((directory) => fs.mkdir(directory, { recursive: true })));
  const source = 'export const requirement = "REQUIREMENT_ALPHA";\n';
  await fs.writeFile(path.join(workspaceA, 'prototype.ts'), source);
  await fs.mkdir(path.join(processA, 'config'), { recursive: true });
  await fs.mkdir(path.join(processA, 'cache'), { recursive: true });
  await fs.writeFile(path.join(processA, 'config', 'auth-canary'), canary);
  await fs.writeFile(path.join(processA, 'cache', 'cache-canary'), canary);

  const requestTrace = [];
  let stage = 'server-start';
  const server = http.createServer(async (req, res) => {
    requestTrace.push({ method: req.method, url: req.url });
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'fake-model', object: 'model' }] }));
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requestTrace.at(-1).stream = body.stream;
    requestTrace.at(-1).keys = Object.keys(body).sort();
    requestTrace.at(-1).messages = (body.messages ?? []).map((message) => ({
      role: message.role,
      text: JSON.stringify(message.content).slice(0, 300),
    }));
    completion(res, body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    const config = {
      plugin: [],
      provider: { openrouter: { options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'synthetic' } } },
      permission: { bash: 'deny', webfetch: 'deny', external_directory: 'deny' },
    };
    const envA = cleanEnvironment(processA, config);
    stage = 'process-a-run';
    const first = await run([
      'run', '--pure', '--format', 'json', '--model', 'openrouter/openai/gpt-4o-mini', '--dir', workspaceA,
      'Remember REQUIREMENT_ALPHA and answer with PROCESS_A_OK.',
    ], envA);
    if (!first.stdout.includes('PROCESS_A_OK')) throw new Error('Process A did not complete the fake-model turn');
    stage = 'process-a-session-list';
    const sessionsAResult = await run(['session', 'list', '--pure', '--format', 'json'], envA, workspaceA);
    const sessionsA = JSON.parse(sessionsAResult.stdout);
    const sessionId = sessionsA[0]?.id;
    if (typeof sessionId !== 'string') throw new Error('Process A session id is unavailable');
    stage = 'process-a-export';
    const exported = (await run(['export', '--pure', sessionId], envA)).stdout;
    if (exported.includes(canary)) throw new Error('Export contains global auth/config/cache data');
    const exportFile = path.join(root, 'session.json');
    await fs.writeFile(exportFile, exported);

    await fs.writeFile(path.join(workspaceB, 'prototype.ts'), source);
    const envB = cleanEnvironment(processB, config);
    stage = 'process-b-import';
    await run(['import', '--pure', exportFile], envB, workspaceB);
    stage = 'process-b-session-list';
    const sessionsB = JSON.parse((await run(['session', 'list', '--pure', '--format', 'json'], envB, workspaceB)).stdout);
    const importedId = sessionsB[0]?.id;
    if (typeof importedId !== 'string') throw new Error('Imported session id is unavailable');
    stage = 'process-b-run';
    const continued = await run([
      'run', '--pure', '--format', 'json', '--model', 'openrouter/openai/gpt-4o-mini', '--session', importedId,
      '--dir', workspaceB, 'CONTINUE_AFTER_IMPORT: what requirement did process A retain?',
    ], envB);
    if (!continued.stdout.includes('CONTINUITY_OK REQUIREMENT_ALPHA')) {
      throw new Error('Imported process did not retain the exported transcript');
    }
    const copiedSource = await fs.readFile(path.join(workspaceB, 'prototype.ts'), 'utf8');
    const treeB = JSON.stringify(await fs.readdir(processB, { recursive: true }));
    if (treeB.includes('auth-canary') || treeB.includes('cache-canary')) {
      throw new Error('Process B received forbidden global files');
    }
    process.stdout.write(`${JSON.stringify({
      status: 'PASS', opencodeVersion: '1.18.16', continuity: 'export-import',
      sourceDigest: `sha256:${sha256(copiedSource)}`, isolatedHomes: true,
    })}\n`);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; stage=${stage}; requestTrace=${JSON.stringify(requestTrace)}; root=${root}`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
