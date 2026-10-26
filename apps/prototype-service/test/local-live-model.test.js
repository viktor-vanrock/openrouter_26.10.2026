import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  LocalLiveModel,
  quoteLocalLiveRequest,
  readLocalLiveKey,
} from '../src/local-live-model.js';

// Price/budget fixtures explicitly use a one-dollar ceiling; production defaults may differ.
const previousTurnLimit = process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD;
process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD = '1';
test.after(() => {
  if (previousTurnLimit === undefined) delete process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD;
  else process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD = previousTurnLimit;
});

const key = 'sk-or-v1-test-key-with-a-one-dollar-limit';
const model = 'openai/gpt-4o';
const metadata = {
  id: model,
  context_length: 128_000,
  top_provider: { max_completion_tokens: 16_384 },
  pricing: { prompt: '0.0000025', completion: '0.00001' },
};
const html =
  '<!doctype html><html><head><title>Personal prototype</title></head><body><button id="go">Go</button><script>document.getElementById("go").onclick=()=>document.body.dataset.clicked="yes"</script></body></html>';

test('provider refusal and content filtering stop plan/code without parsing or automatic retries', async () => {
  for (const choice of [
    { finish_reason: 'content_filter', message: { content: '' } },
    { finish_reason: 'stop', message: { content: null, refusal: 'Rejected by policy' } },
    { finish_reason: 'stop', message: { content: '{"reason":"refusal","prompt":"Cannot help"}' } },
  ]) {
    let calls = 0,
      usage = 0;
    const live = new LocalLiveModel({
      key,
      model,
      requireKeyLimit: false,
      fetchImpl: async (url) => {
        if (url.endsWith('/models')) return response({ data: [metadata] });
        calls++;
        return response({ choices: [choice], usage: { cost: 0.001 } });
      },
    });
    await assert.rejects(
      live.planPrototype('blocked fixture', {
        authorizeQuote: async () => {},
        onUsage: async () => {
          usage++;
        },
      }),
      { code: 'LIVE_MODEL_CONTENT_BLOCKED' },
    );
    assert.equal(calls, 1);
    assert.equal(usage, 1);
  }
});

test('requires the selected chat model and never silently substitutes a default', () => {
  assert.throws(() => new LocalLiveModel({ key }), { code: 'LIVE_MODEL_CONFIG_INVALID' });
  assert.equal(
    new LocalLiveModel({ key, model: '~anthropic/selected-model' }).model,
    '~anthropic/selected-model',
  );
});

test('the local context ceiling accepts one MiB and rejects larger input before a provider request', async () => {
  const largeModel = {
    ...metadata,
    context_length: 2_000_000,
    pricing: { prompt: '0.000000001', completion: '0.000000001' },
  };
  assert.ok(quoteLocalLiveRequest({ model, metadata: largeModel, promptBytes: 1024 * 1024 }) < 1);
  assert.throws(
    () => quoteLocalLiveRequest({ model, metadata: largeModel, promptBytes: 1024 * 1024 + 1 }),
    { code: 'LIVE_MODEL_BOUNDS_UNAVAILABLE' },
  );
  let requests = 0;
  const live = new LocalLiveModel({
    key,
    model,
    requireKeyLimit: false,
    fetchImpl: async () => {
      requests++;
      throw new Error('Oversized input must not reach the provider');
    },
  });
  await assert.rejects(
    live.generateReact('x'.repeat(1024 * 1024), { authorizeQuote: async () => undefined }),
    { code: 'LIVE_MODEL_PROMPT_TOO_LARGE' },
  );
  assert.equal(requests, 0);
  assert.throws(
    () => quoteLocalLiveRequest({ model, metadata, promptBytes: 1024 * 1024 }),
    { code: 'LIVE_MODEL_BOUNDS_UNAVAILABLE' },
    'The model context ceiling still applies',
  );
});

test('a normal follow-up with a 22 KB source and kit reference fits the selected model context', async () => {
  const source = await fs.readFile(new URL('./fixtures/react-design.tsx', import.meta.url), 'utf8');
  let calls = 0;
  const live = new LocalLiveModel({
    key,
    model,
    requireKeyLimit: false,
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return response({ data: [metadata] });
      calls++;
      return response({ choices: [{ finish_reason: 'stop', message: { content: source } }] });
    },
  });
  const result = await live.generateReact(
    'Исправь текст кнопки\n' + source + '\n/*' + 'x'.repeat(22000) + '*/',
    { authorizeQuote: async () => undefined },
  );
  assert.equal(calls, 1);
  assert.equal(result.source, source.trim());
});

test('planning returns bounded questions/plans from the selected model, without code', async () => {
  for (const reason of ['clarification', 'plan_approval']) {
    let sent;
    const live = new LocalLiveModel({
      key,
      model,
      requireKeyLimit: false,
      fetchImpl: async (url, options) => {
        if (url.endsWith('/models')) return response({ data: [metadata] });
        sent = JSON.parse(options.body);
        return response({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({ reason, prompt: 'План или вопрос для конкретного ТЗ' }),
              },
            },
          ],
        });
      },
    });
    const result = await live.planPrototype('Нужен лендинг продукта', {
      authorizeQuote: async () => undefined,
    });
    assert.equal(result.plan.reason, reason);
    assert.equal(sent.max_tokens, 4096);
    assert.match(sent.messages[0].content, /код писать нельзя/);
    assert.equal(sent.model, model);
    assert.match(sent.messages[0].content, /В поле prompt запрещены технические детали/);
    assert.match(sent.messages[0].content, /компонентов Button\/Input\/Modal\/Table/);
    assert.match(sent.messages[0].content, /План назови "План прототипа"/);
  }
});

test('invalid planning output is not accepted as a plan', async () => {
  const live = new LocalLiveModel({
    key,
    model,
    requireKeyLimit: false,
    fetchImpl: async (url) =>
      url.endsWith('/models')
        ? response({ data: [metadata] })
        : response({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({ reason: 'unsupported_reason', prompt: 'Visible plan' }),
                },
              },
            ],
          }),
  });
  await assert.rejects(live.planPrototype('CRM', { authorizeQuote: async () => undefined }), {
    code: 'LIVE_MODEL_PLAN_INVALID',
  });
});

test('cost quote does not invent a duration from the output token ceiling', () => {
  const live = new LocalLiveModel({ key, model, requireKeyLimit: false });
  const estimate = live.estimateRequest([{ role: 'user', content: 'CRM' }], {
    outputTokens: 8192,
    quotedUpperUsd: 0.5,
  });
  assert.equal(estimate.durationLowSeconds, null);
  assert.equal(estimate.durationHighSeconds, null);
  assert.equal(estimate.durationBasis, null);
});

test('React generation sends the approved UI Kit reference and reserves once before returning TSX', async () => {
  const trace = [];
  const source = `import { Button } from '@ai-sber/uikit'; export function App() { return <main><section aria-label="Варианты дизайна"><Button>A</Button><Button>B</Button></section><section data-prototype-variant="A"><Button>Добавить</Button></section></main>; }`;
  let sent;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return response({ data: [metadata] });
    trace.push('paid');
    sent = JSON.parse(options.body);
    return response({
      choices: [{ finish_reason: 'stop', message: { content: `\`\`\`tsx\n${source}\n\`\`\`` } }],
    });
  };
  const result = await new LocalLiveModel({
    key,
    model,
    fetchImpl,
    requireKeyLimit: false,
  }).generateReact('Сделай CRM', { authorizeQuote: async () => trace.push('reserved') });
  assert.equal(result.source, source);
  assert.equal(result.format, 'react');
  assert.equal(result.html, undefined);
  assert.deepEqual(trace, ['reserved', 'paid']);
  assert.match(sent.messages[0].content, /@ai-sber\/uikit/);
  assert.match(sent.messages[0].content, /`loading`, не `isLoading`/);
});

test('React generation rejects plain HTML and source without the real UI Kit', async () => {
  for (const content of [html, 'export function App() { return <button>Fake kit</button>; }']) {
    const fetchImpl = async (url) =>
      url.endsWith('/models')
        ? response({ data: [metadata] })
        : response({ choices: [{ finish_reason: 'stop', message: { content } }] });
    await assert.rejects(
      () =>
        new LocalLiveModel({ key, model, fetchImpl, requireKeyLimit: false }).generateReact(
          'Build CRM',
          { authorizeQuote: async () => undefined },
        ),
      /LIVE_MODEL_REACT_INVALID/,
    );
  }
});

test('approved code stage overrides historical requests to wait for plan approval without losing requirements', async () => {
  const source = `import { Button } from '@ai-sber/uikit'; export function App() { return <main><section aria-label="Варианты дизайна"><Button>A</Button><Button>B</Button></section><section data-prototype-variant="A"><Button>Добавить</Button></section></main>; }`;
  let sent;
  let paid = 0;
  let reservations = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/models')) return response({ data: [metadata] });
    paid++;
    sent = JSON.parse(options.body);
    const implementation =
      sent.messages[0].content.includes('CURRENT WORKFLOW STATE: IMPLEMENTATION_APPROVED') &&
      sent.messages[1].content.endsWith(
        'Сейчас реализуй прототип. Верни только полный код App.tsx, без пояснений и повторного запроса подтверждения.',
      );
    return response({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: implementation ? source : 'Сначала подтвердите план, затем я создам прототип.',
          },
        },
      ],
    });
  };
  const requirements =
    'Менеджер задач с поиском, добавлением и удалением. Сначала покажи короткий план и дождись моего подтверждения.\nУтверждённый план: два варианта, таблица и карточки.';
  const live = new LocalLiveModel({ key, model, requireKeyLimit: false, fetchImpl });
  const result = await live.generateReact(requirements, {
    authorizeQuote: async () => {
      reservations++;
    },
  });
  assert.equal(result.source, source);
  assert.equal(paid, 1);
  assert.equal(reservations, 1);
  assert.ok(sent.messages[1].content.includes(requirements));
  assert.match(
    sent.messages[0].content,
    /Historical instructions to show a plan or wait for approval have already been fulfilled/,
  );
});

test('invalid model source emits exact validation diagnostics and a digest without leaking response or repeating billing', async () => {
  const content =
    "import { Button } from '@ai-sber/uikit';\nexport function App() { return <Button>private-generated-data</Button>";
  const events = [];
  let paid = 0;
  let reservations = 0;
  const live = new LocalLiveModel({
    key,
    model,
    requireKeyLimit: false,
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return response({ data: [metadata] });
      paid++;
      return response({
        choices: [{ finish_reason: 'stop', message: { content } }],
        usage: { completion_tokens: 100 },
      });
    },
  });
  await assert.rejects(
    live.generateReact('private-user-prompt', {
      authorizeQuote: async () => {
        reservations++;
      },
      onEvent: (event, fields) => events.push({ event, ...fields }),
    }),
    (error) => {
      assert.equal(error.code, 'LIVE_MODEL_REACT_INVALID');
      assert.equal(error.details.reason, 'tsx_syntax_error');
      return true;
    },
  );
  assert.equal(paid, 1);
  assert.equal(reservations, 1);
  const failure = events.find((entry) => entry.event === 'model.validation_failed');
  assert.equal(failure.reason, 'tsx_syntax_error');
  assert.ok(failure.lineNumber >= 2);
  assert.match(failure.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(failure.sourceBytes, Buffer.byteLength(content));
  assert.ok(events.some((entry) => entry.event === 'model.request' && entry.maxOutputTokens > 0));
  assert.ok(
    events.some((entry) => entry.event === 'model.response' && entry.finishReason === 'stop'),
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /private-generated-data|private-user-prompt|sk-or-v1/,
  );
});

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('one capped OpenRouter key can produce offline HTML with a restrictive CSP', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/auth/key')) return response({ data: { limit: 1, limit_remaining: 1 } });
    if (url.endsWith('/models')) return response({ data: [metadata] });
    return response({
      choices: [{ finish_reason: 'stop', message: { content: html } }],
      usage: { prompt_tokens: 123, completion_tokens: 56 },
    });
  };
  const result = await new LocalLiveModel({ key, model, fetchImpl }).generateHtml(
    'Build a counter',
  );
  assert.match(result.html.toString(), /Content-Security-Policy/);
  assert.match(result.html.toString(), /connect-src 'none'/);
  assert.match(result.html.toString(), /Personal prototype/);
  assert.ok(result.quotedUpperUsd > 0 && result.quotedUpperUsd < 1);
  assert.equal(requests.filter(({ url }) => url.endsWith('/chat/completions')).length, 1);
  const sent = JSON.parse(requests.at(-1).options.body);
  assert.equal(sent.model, model);
  assert.equal(sent.max_tokens, 16_384);
  assert.equal(sent.stream, false);
  assert.ok(
    requests.every(
      ({ url, options }) =>
        url.startsWith('https://openrouter.ai/api/v1/') && options.redirect === 'error',
    ),
  );
});

test('uses the configured HTTPS gateway and the model selected for this turn', async () => {
  const requests = [];
  const chosen = 'vendor/selected-model';
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/auth/key')) return response({ data: { limit: 1, limit_remaining: 1 } });
    if (url.endsWith('/models')) return response({ data: [{ ...metadata, id: chosen }] });
    return response({ choices: [{ finish_reason: 'stop', message: { content: html } }] });
  };
  const result = await new LocalLiveModel({
    key,
    model: chosen,
    baseUrl: 'https://or.crbrcloud.ru/api/v1',
    fetchImpl,
  }).generateHtml('Build a counter');
  assert.match(result.html.toString(), /Personal prototype/);
  assert.ok(requests.every(({ url }) => url.startsWith('https://or.crbrcloud.ru/api/v1/')));
  assert.equal(requests.filter(({ url }) => url.endsWith('/chat/completions')).length, 1);
  assert.equal(JSON.parse(requests.at(-1).options.body).model, chosen);
});

test('accepts and sends OpenRouter model ids with a leading route prefix', async () => {
  const requests = [];
  const selected = '~anthropic/claude-sonnet-latest';
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/models')) return response({ data: [{ ...metadata, id: selected }] });
    return response({ choices: [{ finish_reason: 'stop', message: { content: html } }] });
  };
  const result = await new LocalLiveModel({
    key,
    model: selected,
    baseUrl: 'https://or.crbrcloud.ru/api/v1',
    fetchImpl,
    requireKeyLimit: false,
  }).generateHtml('Build a counter', { authorizeQuote: async () => undefined });
  assert.match(result.html.toString(), /Personal prototype/);
  assert.equal(JSON.parse(requests.at(-1).options.body).model, selected);
});

test('stored-key mode reserves the quoted cost before the provider request', async () => {
  const trace = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/models')) return response({ data: [metadata] });
    if (url.endsWith('/chat/completions')) {
      trace.push('paid');
      return response({ choices: [{ finish_reason: 'stop', message: { content: html } }] });
    }
    throw new Error('Unexpected provider route');
  };
  const live = new LocalLiveModel({ key, model, fetchImpl, requireKeyLimit: false });
  await live.generateHtml('Build a counter', {
    authorizeQuote: async (amount) => {
      assert.ok(amount > 0 && amount <= 1);
      trace.push('reserved');
    },
  });
  assert.deepEqual(trace, ['reserved', 'paid']);
});

test('stored-key mode rejects a failed or duplicate reservation without billing', async () => {
  let paid = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/models')) return response({ data: [metadata] });
    paid++;
    return response({ choices: [{ finish_reason: 'stop', message: { content: html } }] });
  };
  const live = new LocalLiveModel({ key, model, fetchImpl, requireKeyLimit: false });
  await assert.rejects(
    () =>
      live.generateHtml('Build a counter', {
        authorizeQuote: async () => {
          throw new Error('budget_exceeded');
        },
      }),
    /budget_exceeded/,
  );
  assert.equal(paid, 0);
});

test('preflight rejects an uncapped key before any paid request', async () => {
  let paidRequests = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/key'))
      return response({ data: { limit: null, limit_remaining: null } });
    if (url.endsWith('/models')) return response({ data: [metadata] });
    paidRequests++;
    return response({});
  };
  await assert.rejects(
    () => new LocalLiveModel({ key, model, fetchImpl }).generateHtml('Build a counter'),
    { code: 'LIVE_MODEL_KEY_LIMIT_REQUIRED' },
  );
  assert.equal(paidRequests, 0);
});

test('unknown or higher overridden price fails before any paid request', async () => {
  let paidRequests = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/auth/key')) return response({ data: { limit: 1, limit_remaining: 1 } });
    if (url.endsWith('/models'))
      return response({
        data: [
          {
            ...metadata,
            pricing: {
              ...metadata.pricing,
              overrides: [{ completion: '0.01' }],
            },
          },
        ],
      });
    paidRequests++;
    return response({});
  };
  await assert.rejects(
    () => new LocalLiveModel({ key, model, fetchImpl }).generateHtml('Build a counter'),
    { code: 'LIVE_MODEL_BUDGET_EXCEEDED' },
  );
  assert.equal(paidRequests, 0);
  assert.equal(
    quoteLocalLiveRequest({ model, metadata, promptBytes: 1_000, outputTokens: 4_096 }),
    0.092041,
  );
});

test('quote includes the highest cache-write price when the gateway lists one', () => {
  const cached = {
    ...metadata,
    pricing: {
      prompt: '0.000001',
      completion: '0.000001',
      input_cache_write: '0.0001',
    },
  };
  assert.throws(() => quoteLocalLiveRequest({ model, metadata: cached, promptBytes: 6_000 }), {
    code: 'LIVE_MODEL_BUDGET_EXCEEDED',
  });
});

test('unsafe HTML is rejected after one response without executing or publishing it', async () => {
  for (const unsafe of [
    '<script src="https://evil.invalid/x.js"></script>',
    '<a href="/api/keys">Go</a>',
    '<script>window.location.href="/api/keys"</script>',
  ]) {
    const fetchImpl = async (url) => {
      if (url.endsWith('/auth/key')) return response({ data: { limit: 1, limit_remaining: 1 } });
      if (url.endsWith('/models')) return response({ data: [metadata] });
      return response({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: `<!doctype html><html><head></head><body>${unsafe}</body></html>` },
          },
        ],
      });
    };
    await assert.rejects(
      () => new LocalLiveModel({ key, model, fetchImpl }).generateHtml('Build a counter'),
      { code: 'LIVE_MODEL_HTML_UNSAFE' },
    );
  }
});

test('local key file must be absolute, regular and owner-only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-live-key-'));
  try {
    const filename = path.join(root, 'key');
    await fs.writeFile(filename, `${key}\n`, { mode: 0o600 });
    assert.equal(await readLocalLiveKey(filename), key);
    await fs.chmod(filename, 0o644);
    await assert.rejects(() => readLocalLiveKey(filename), { code: 'LIVE_MODEL_KEY_FILE_INVALID' });
    await assert.rejects(() => readLocalLiveKey('relative-key'), {
      code: 'LIVE_MODEL_KEY_FILE_INVALID',
    });
    await assert.rejects(() => readLocalLiveKey(path.join(process.cwd(), 'key')), {
      code: 'LIVE_MODEL_KEY_FILE_INVALID',
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('text-only generation accepts the selected gateway model with optional web-search pricing', async () => {
  const selected = '~anthropic/claude-sonnet-latest';
  const actualMetadata = {
    id: selected,
    context_length: 1_000_000,
    top_provider: {
      context_length: 1_000_000,
      max_completion_tokens: 128_000,
      is_moderated: false,
    },
    pricing: {
      prompt: '0.000002',
      completion: '0.00001',
      web_search: '0.01',
      input_cache_read: '0.0000002',
      input_cache_write: '0.0000025',
      input_cache_write_1h: '0.000004',
    },
  };
  const requests = [];
  let reserved;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/models')) return response({ data: [actualMetadata] });
    return response({ choices: [{ finish_reason: 'stop', message: { content: html } }] });
  };
  const live = new LocalLiveModel({
    key,
    model: selected,
    baseUrl: 'https://or.crbrcloud.ru/api/v1',
    fetchImpl,
    requireKeyLimit: false,
  });
  const result = await live.generateHtml('Создай прототип учёта сотрудников в CRM', {
    authorizeQuote: async (amount) => {
      reserved = amount;
    },
  });
  assert.match(result.html.toString(), /Personal prototype/);
  assert.ok(reserved > 0 && reserved <= 1);
  const paid = requests.filter(({ url }) => url.endsWith('/chat/completions'));
  assert.equal(paid.length, 1);
  const body = JSON.parse(paid[0].options.body);
  assert.equal(body.model, selected);
  assert.equal(body.tools, undefined);
  assert.equal(body.plugins, undefined);
  assert.equal(body.web_search_options, undefined);
  assert.ok(body.messages.every((message) => typeof message.content === 'string'));
});

test('quote includes hourly cache-write pricing and rejects an over-budget rate before billing', async () => {
  const cached = {
    ...metadata,
    pricing: {
      prompt: '0.000001',
      completion: '0.000001',
      input_cache_write_1h: '0.0001',
    },
  };
  assert.throws(() => quoteLocalLiveRequest({ model, metadata: cached, promptBytes: 6_000 }), {
    code: 'LIVE_MODEL_BUDGET_EXCEEDED',
  });
  let paid = 0;
  const live = new LocalLiveModel({
    key,
    model,
    requireKeyLimit: false,
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return response({ data: [cached] });
      paid++;
      return response({});
    },
  });
  await assert.rejects(
    () =>
      live.generateHtml('Build a counter ' + 'x'.repeat(6000), {
        authorizeQuote: async () => undefined,
      }),
    { code: 'LIVE_MODEL_BUDGET_EXCEEDED' },
  );
  assert.equal(paid, 0);
});

test('full HTML receives a larger priced output budget and optional reasoning is disabled', async () => {
  const meta = { ...metadata, supported_parameters: ['reasoning', 'max_tokens'] };
  let sent;
  const live = new LocalLiveModel({
    key,
    model,
    requireKeyLimit: false,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return response({ data: [meta] });
      sent = JSON.parse(options.body);
      return response({
        choices: [
          {
            finish_reason: sent.max_tokens > 4096 ? 'stop' : 'length',
            message: {
              content: sent.max_tokens > 4096 ? html : '<!doctype html><html><body>Partial',
            },
          },
        ],
      });
    },
  });
  const result = await live.generateHtml('Create an employee CRM', {
    authorizeQuote: async (amount) => {
      assert.ok(amount > 0 && amount <= 1);
    },
  });
  assert.match(result.html.toString(), /Personal prototype/);
  assert.equal(sent.max_tokens, 16384);
  assert.deepEqual(sent.reasoning, { enabled: false });
});

test('output budget adapts to model limits and price without exceeding one dollar', async () => {
  for (const [meta, expected] of [
    [{ ...metadata, top_provider: { max_completion_tokens: 4096 } }, 4096],
    [{ ...metadata, pricing: { prompt: '0.0000025', completion: '0.00005' } }, 8192],
  ]) {
    let requested;
    const live = new LocalLiveModel({
      key,
      model,
      requireKeyLimit: false,
      fetchImpl: async (url, options) => {
        if (url.endsWith('/models')) return response({ data: [meta] });
        requested = JSON.parse(options.body).max_tokens;
        return response({ choices: [{ finish_reason: 'stop', message: { content: html } }] });
      },
    });
    await live.generateHtml('Employee CRM', {
      authorizeQuote: async (amount) => assert.ok(amount <= 1),
    });
    assert.equal(requested, expected);
  }
});

test('truncated output is diagnosed without publication or an automatic second request', async () => {
  let paid = 0;
  const live = new LocalLiveModel({
    key,
    model,
    requireKeyLimit: false,
    fetchImpl: async (url) => {
      if (url.endsWith('/models')) return response({ data: [metadata] });
      paid++;
      return response({
        choices: [
          { finish_reason: 'length', message: { content: '<!doctype html><html><body>Truncated' } },
        ],
        usage: { completion_tokens: 16384 },
      });
    },
  });
  await assert.rejects(
    () => live.generateHtml('Employee CRM', { authorizeQuote: async () => undefined }),
    (error) =>
      error.code === 'LIVE_MODEL_OUTPUT_LIMIT' &&
      error.details.finishReason === 'length' &&
      error.details.completionTokens === 16384,
  );
  assert.equal(paid, 1);
});

test('generated CRM HTML accepts local forms, inline SVG and a complete markdown wrapper', async () => {
  const crm =
    '<!doctype html><html><head><style>.badge{background-image:url(data:image/png;base64,aA==)}</style></head><body><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg><form onsubmit="event.preventDefault();document.querySelector(\'output\').textContent=\'Saved\'"><input placeholder="Employee"><button>Save</button></form><output></output><p>Documentation: https://example.invalid</p></body></html>';
  for (const content of [crm, '```html\n' + crm + '\n```']) {
    const live = new LocalLiveModel({
      key,
      model,
      requireKeyLimit: false,
      fetchImpl: async (url) => {
        if (url.endsWith('/models')) return response({ data: [metadata] });
        return response({ choices: [{ finish_reason: 'stop', message: { content } }] });
      },
    });
    const result = await live.generateHtml('Employee CRM', {
      authorizeQuote: async () => undefined,
    });
    assert.match(result.html.toString(), /<form/);
    assert.match(result.html.toString(), /<svg/);
    assert.match(result.html.toString(), /form-action 'none'/);
  }
});

test('HTML rejects real outbound resource attributes, frame injection and navigation', async () => {
  for (const fragment of [
    '<img src="https://external.invalid/x">',
    '<svg><image href="https://external.invalid/x"/></svg>',
    '<form action="/api/keys"><button>Submit</button></form>',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<style>body{background:url(https://external.invalid/x)}</style>',
    '<meta http-equiv="refresh" content="0;url=/api/keys">',
  ]) {
    const live = new LocalLiveModel({
      key,
      model,
      requireKeyLimit: false,
      fetchImpl: async (url) => {
        if (url.endsWith('/models')) return response({ data: [metadata] });
        return response({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: '<!doctype html><html><head></head><body>' + fragment + '</body></html>',
              },
            },
          ],
        });
      },
    });
    await assert.rejects(
      live.generateHtml('Employee CRM', { authorizeQuote: async () => undefined }),
      (error) =>
        error.code === 'LIVE_MODEL_HTML_UNSAFE' && typeof error.details?.reason === 'string',
    );
  }
});

test('React generation can complete beyond 16k tokens when model bounds and turn budget allow it', async () => {
  const selected = '~anthropic/claude-sonnet-latest';
  const meta = {
    ...metadata,
    id: selected,
    context_length: 200_000,
    top_provider: { max_completion_tokens: 64_000 },
    pricing: { prompt: '0.000001', completion: '0.000005' },
  };
  const source = `import { Button } from '@ai-sber/uikit'; export function App() { return <main><section aria-label="Варианты дизайна"><Button>A</Button><Button>B</Button></section><section data-prototype-variant="A"><Button>Добавить</Button></section></main>; }`;
  let paid = 0,
    requested;
  const live = new LocalLiveModel({
    key,
    model: selected,
    requireKeyLimit: false,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return response({ data: [meta] });
      paid++;
      const body = JSON.parse(options.body);
      requested = body;
      const complete = body.max_tokens > 16_384;
      return response({
        choices: [
          {
            finish_reason: complete ? 'stop' : 'length',
            message: { content: complete ? source : 'export function App() {' },
          },
        ],
        usage: { completion_tokens: complete ? 18_000 : 16_384, cost: 0.18 },
      });
    },
  });
  const result = await live.generateReact('CRM', {
    authorizeQuote: async (amount) => assert.ok(amount > 0 && amount <= 1),
  });
  assert.equal(result.source, source);
  assert.equal(paid, 1);
  assert.equal(requested.model, selected);
  assert.equal(requested.max_tokens, 64_000);
});

test('larger output stays bounded by context, price and local response ceiling; planner stays at 4096', async () => {
  const source = `import { Button } from '@ai-sber/uikit'; export function App() { return <main><section aria-label="Варианты дизайна"><Button>A</Button><Button>B</Button></section><section data-prototype-variant="A"><Button>Добавить</Button></section></main>; }`;
  for (const [patch, expected] of [
    [
      {
        context_length: 200_000,
        top_provider: { max_completion_tokens: 128_000 },
        pricing: { prompt: '0.000001', completion: '0.000001' },
      },
      65_536,
    ],
    [{ context_length: 26_000, top_provider: { max_completion_tokens: 128_000 } }, 'context'],
    [
      {
        context_length: 200_000,
        top_provider: { max_completion_tokens: 64_000 },
        pricing: { prompt: '0.000001', completion: '0.00002' },
      },
      16_384,
    ],
  ]) {
    let paid = 0;
    const meta = { ...metadata, ...patch };
    const live = new LocalLiveModel({
      key,
      model,
      requireKeyLimit: false,
      fetchImpl: async (url, options) => {
        if (url.endsWith('/models')) return response({ data: [meta] });
        paid++;
        const body = JSON.parse(options.body);
        if (expected === 'context')
          assert.equal(
            body.max_tokens,
            meta.context_length - Buffer.byteLength(JSON.stringify(body.messages)) - 1024,
          );
        else assert.equal(body.max_tokens, expected);
        return response({ choices: [{ finish_reason: 'stop', message: { content: source } }] });
      },
    });
    await live.generateReact('CRM', { authorizeQuote: async (value) => assert.ok(value <= 1) });
    assert.equal(paid, 1);
  }
  let sent;
  const planner = new LocalLiveModel({
    key,
    model,
    requireKeyLimit: false,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/models'))
        return response({
          data: [{ ...metadata, top_provider: { max_completion_tokens: 128_000 } }],
        });
      sent = JSON.parse(options.body);
      return response({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({ reason: 'plan_approval', prompt: 'План прототипа A и B' }),
            },
          },
        ],
      });
    },
  });
  await planner.planPrototype('CRM', { authorizeQuote: async () => undefined });
  assert.equal(sent.max_tokens, 4096);
});
