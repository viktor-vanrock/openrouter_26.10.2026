/** Uploaded fixed runner: only scoped credential, fixed source, zero redirects/retries. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const digest = (body) =>
  `sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
export function firstBody(model) {
  return {
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: 'Call read_fixture with src/fixture.ts, then briefly explain its exported value.',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_fixture',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', enum: ['src/fixture.ts'] } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: 'required',
  };
}
export async function parseSse(response) {
  if (
    response.status !== 200 ||
    !/^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')
  )
    throw new Error('ACCEPTANCE_SSE_STATUS');
  const reader = response.body.getReader(),
    decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '',
    bytes = 0,
    frames = 0,
    done = false,
    text = '',
    usage = null;
  const tools = new Map();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('ACCEPTANCE_SSE_LIMIT');
      pending += decoder.decode(chunk.value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        if (Buffer.byteLength(frame) > 256 * 1024) throw new Error('ACCEPTANCE_SSE_LIMIT');
        const data = frame
          .split(/\r?\n/)
          .filter((v) => v.startsWith('data:'))
          .map((v) => v.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        if (done) throw new Error('ACCEPTANCE_SSE_INVALID');
        frames++;
        if (data === '[DONE]') {
          done = true;
          continue;
        }
        const value = JSON.parse(data);
        if (value.error) throw new Error('ACCEPTANCE_SSE_INVALID');
        if (value.usage) usage = value.usage;
        for (const choice of value.choices ?? []) {
          if (choice.index != null && choice.index !== 0) throw new Error('ACCEPTANCE_SSE_INVALID');
          text += choice.delta?.content ?? '';
          for (const call of choice.delta?.tool_calls ?? []) {
            if (!Number.isSafeInteger(call.index) || call.index < 0 || call.index > 1)
              throw new Error('ACCEPTANCE_TOOL_INVALID');
            const old = tools.get(call.index) ?? {
              id: '',
              type: 'function',
              function: { name: '', arguments: '' },
            };
            old.id += call.id ?? '';
            old.function.name += call.function?.name ?? '';
            old.function.arguments += call.function?.arguments ?? '';
            tools.set(call.index, old);
          }
        }
      }
      if (Buffer.byteLength(pending) > 256 * 1024) throw new Error('ACCEPTANCE_SSE_LIMIT');
    }
    pending += decoder.decode();
    if (
      !done ||
      pending.trim() ||
      !usage ||
      ![usage.prompt_tokens, usage.completion_tokens].every(
        (v) => Number.isSafeInteger(v) && v >= 0,
      ) ||
      !Number.isFinite(usage.cost) ||
      usage.cost < 0
    )
      throw new Error('ACCEPTANCE_USAGE_OR_DONE_MISSING');
    return { text, tools: [...tools.values()], usage, frames, bytes };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function runSandbox({ input, credential, save, readFixture, fetchImpl = fetch }) {
  const url = new URL(input.baseUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/api/prototype-model/v1'
  )
    throw new Error('ACCEPTANCE_TARGET_DENIED');
  let token = credential;
  const http = (suffix, options = {}) =>
    fetchImpl(`${url}${suffix}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(35000),
    });
  const response = await http('/models');
  if (response.status !== 200) throw new Error('ACCEPTANCE_DISCOVERY_FAILED');
  const catalog = await response.json();
  if (catalog.data?.length !== 1 || catalog.data[0].id !== input.model)
    throw new Error('ACCEPTANCE_MODEL_MISMATCH');
  const result = { discovery: 200, model: input.model, providerPostAttempts: 0, requests: [] };
  await save(result);
  if (input.mode === 'gateway-discovery') return result;
  if (
    input.mode !== 'live' ||
    !Number.isFinite(input.quoteUsd) ||
    input.quoteUsd < 0 ||
    input.quoteUsd > 0.1 ||
    input.requestIds?.length !== 2 ||
    input.requestIds[0] === input.requestIds[1] ||
    !input.requestIds.every((id) => /^[a-zA-Z0-9_.:-]{1,100}$/.test(id))
  )
    throw new Error('ACCEPTANCE_COST_REQUIRED');
  async function post(body, index) {
    if (
      Buffer.byteLength(JSON.stringify(body)) > 16000 ||
      body.model !== input.model ||
      body.max_tokens !== 1024
    )
      throw new Error('ACCEPTANCE_REQUEST_LIMIT');
    // Persist stable ID/body digest BEFORE dispatch. No code path repeats an attempt.
    const entry = {
      requestId: input.requestIds[index],
      requestDigest: digest(body),
      outcome: 'dispatch_intent',
    };
    result.requests.push(entry);
    result.providerPostAttempts++;
    await save(result);
    const start = Date.now();
    try {
      const reply = await http('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Prototype-Request-Id': entry.requestId },
        body: JSON.stringify(body),
      });
      const stream = await parseSse(reply);
      Object.assign(entry, {
        outcome: 'response_received',
        usage: stream.usage,
        frames: stream.frames,
        bytes: stream.bytes,
        elapsedMs: Date.now() - start,
      });
      await save(result);
      return stream;
    } catch {
      entry.outcome = 'unknown';
      await save(result);
      throw new Error('ACCEPTANCE_MODEL_OUTCOME_UNKNOWN');
    }
  }
  const first = firstBody(input.model);
  const call = await post(first, 0);
  if (call.usage.cost > input.quoteUsd || call.usage.cost > 0.1)
    throw new Error('ACCEPTANCE_COST_OVERRUN');
  if (
    call.tools.length !== 1 ||
    call.tools[0].function.name !== 'read_fixture' ||
    !call.tools[0].id
  )
    throw new Error('ACCEPTANCE_TOOL_REQUIRED');
  const args = JSON.parse(call.tools[0].function.arguments);
  if (Object.keys(args).length !== 1 || args.path !== 'src/fixture.ts')
    throw new Error('ACCEPTANCE_TOOL_PATH_DENIED');
  const source = await readFixture();
  result.tool = { name: 'read_fixture', path: args.path, executed: true };
  // Trusted runner refreshes the short credential via an ephemeral channel. Never a service token.
  token = await input.renewCredential();
  const second = {
    model: input.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 1024,
    messages: [
      ...first.messages,
      { role: 'assistant', content: call.text || null, tool_calls: call.tools },
      { role: 'tool', tool_call_id: call.tools[0].id, content: source },
    ],
  };
  const final = await post(second, 1);
  if (!final.text.trim() || final.tools.length)
    throw new Error('ACCEPTANCE_USABLE_RESULT_REQUIRED');
  result.usableResult = true;
  result.actualCostUsd = result.requests.reduce((sum, item) => sum + item.usage.cost, 0);
  if (result.actualCostUsd > 0.1) throw new Error('ACCEPTANCE_COST_OVERRUN');
  // Each rejection is expected before a new provider reservation. Count actual billing via trusted journal.
  result.negatives = {};
  for (const [name, body, requestId, expected] of [
    ['replay', second, input.requestIds[1], 409],
    [
      'changedBody',
      { ...second, messages: [{ role: 'user', content: 'changed' }] },
      input.requestIds[1],
      409,
    ],
    [
      'modelMismatch',
      { ...second, model: `${input.model}-mismatch` },
      `${input.requestIds[1]}_mismatch`,
      422,
    ],
  ]) {
    const reply = await http('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Prototype-Request-Id': requestId },
      body: JSON.stringify(body),
    });
    result.negatives[name] = { status: reply.status, expected };
    await reply.body?.cancel();
    await save(result);
    if (reply.status !== expected) throw new Error('ACCEPTANCE_NEGATIVE_FAILED');
  }
  await save(result);
  return result;
}
if (process.argv[1]?.endsWith('/gateway-adapter-sandbox.mjs')) {
  const file = '/run/input/adapter-input.json',
    receipt = '/run/input/adapter-result.json';
  const input = JSON.parse(await fs.readFile(file));
  const credential = process.env.PROTOTYPE_SCOPED_TOKEN;
  delete process.env.PROTOTYPE_SCOPED_TOKEN;
  const save = (value) => fs.writeFile(receipt, JSON.stringify(value), { mode: 0o600 });
  input.renewCredential = async () => {
    // Create the channel private before trusted upload; no source/archive contains this token.
    await fs.writeFile('/run/input/scoped-renewal.json', '', { mode: 0o600, flag: 'wx' });
    await fs.writeFile('/run/input/renew-needed', '1', { mode: 0o600 });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        await fs.chmod('/run/input/scoped-renewal.json', 0o600);
        const value = JSON.parse(await fs.readFile('/run/input/scoped-renewal.json'));
        await fs.rm('/run/input/scoped-renewal.json');
        if (typeof value.token !== 'string' || Date.parse(value.expiresAt) <= Date.now())
          throw new Error();
        return value.token;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error('ACCEPTANCE_RENEWAL_DEADLINE');
  };
  try {
    await fs.mkdir('/run/input/src', { recursive: true, mode: 0o700 });
    await fs.writeFile('/run/input/src/fixture.ts', 'export const fixtureValue = 42;\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await runSandbox({
      input,
      credential,
      save,
      readFixture: () => fs.readFile('/run/input/src/fixture.ts', 'utf8'),
    });
  } catch (error) {
    process.exitCode = 1; /* No raw provider/transport errors or token output. */
  }
}
