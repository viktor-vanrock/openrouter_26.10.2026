import assert from 'node:assert/strict';
import test from 'node:test';
import { PrototypeContentGuard } from '../src/prototype-content-guard.js';
import { parseContentDecision } from '../src/prototype-content-policy.js';
import { LocalLiveModel } from '../src/local-live-model.js';

const command = {
  jobId: 'job_content',
  turnId: 'turn_content',
  commandId: 'submit_content',
  userId: 'user_content',
  tenantId: 'tenant_content',
  modelId: 'selected/model',
  executionId: 'execution_content',
  attemptId: 'attempt_content',
  expectedRevision: 0,
  fenceToken: 1,
};

function harness({ decision = { decision: 'allow', category: 'none' } } = {}) {
  const turns = [{ turnId: command.turnId, text: 'Операционный кабинет заказов' }];
  const saved = new Map();
  const requests = [];
  let active = true;
  let failure;
  const guard = new PrototypeContentGuard({
    mongoose: {
      connection: {
        db: {
          collection: (name) => {
            assert.equal(name, 'prototypecontentchecks');
            return {
              findOne: async ({ _id }) => saved.get(_id),
              insertOne: async (entry) => saved.set(entry._id, entry),
            };
          },
        },
      },
    },
    models: {
      PrototypeTurn: {
        find: ({ jobId }) => {
          assert.equal(jobId, command.jobId);
          return { sort: () => ({ select: () => ({ lean: async () => turns }) }) };
        },
      },
    },
    methods: {
      getUserKeyValues: async () => ({ apiKey: 'test-key', baseURL: 'https://example.test/v1' }),
    },
    gatewayUrl: 'https://example.test/v1',
    active: async () => active,
    signal: () => undefined,
    callbacks: (c, purpose) => {
      assert.equal(c.jobId, command.jobId);
      assert.equal(purpose, 'moderation');
      return {};
    },
    createModel: (options) => {
      assert.equal(options.model, command.modelId);
      return {
        moderatePrototype: async (text) => {
          requests.push(text);
          if (failure) throw failure;
          return { moderation: decision };
        },
      };
    },
  });
  return {
    guard,
    turns,
    saved,
    requests,
    deactivate: () => {
      active = false;
    },
    fail: (error) => {
      failure = error;
    },
  };
}

test('full requirements include the initial request, file text, and subsequent edits', async () => {
  const h = harness({ decision: { decision: 'reject', category: 'sexual' } });
  h.turns[0].text += '\nПриложенный документ: requirements.txt\nprohibited-file-fixture';
  h.turns.push({ turnId: 'turn_followup', text: 'Change only the button' });
  await assert.rejects(h.guard.check(command), { code: 'LIVE_MODEL_CONTENT_BLOCKED' });
  assert.match(h.requests[0], /prohibited-file-fixture/);
  assert.match(h.requests[0], /Change only the button/);
  assert.equal(h.saved.size, 1);
  assert.doesNotMatch(JSON.stringify([...h.saved.values()]), /prohibited-file-fixture/);
});

test('a persisted rejection blocks approve, retry and replay without another provider call', async () => {
  const h = harness({ decision: { decision: 'reject', category: 'exploitation' } });
  for (const commandId of ['submit_content', 'approve_content', 'retry_content']) {
    await assert.rejects(h.guard.check({ ...command, commandId }), {
      code: 'LIVE_MODEL_CONTENT_BLOCKED',
    });
  }
  assert.equal(h.requests.length, 1);
});

test('a permitted request reuses its durable verdict across approval and scratch loss', async () => {
  const h = harness();
  await h.guard.check(command);
  await h.guard.check({ ...command, commandId: 'approve_content', expectedRevision: 2 });
  assert.equal(h.requests.length, 1);
});

test('changing context or selected model requires a new check', async () => {
  const h = harness();
  await h.guard.check(command);
  h.turns.push({ turnId: 'turn_next', text: 'Add a new product capability' });
  await h.guard.check(command);
  assert.equal(h.requests.length, 2);
  let selectedModel;
  h.guard.createModel = (options) => {
    selectedModel = options.model;
    return {
      moderatePrototype: async () => ({ moderation: { decision: 'allow', category: 'none' } }),
    };
  };
  await h.guard.check({ ...command, modelId: 'selected/another-model' });
  assert.equal(selectedModel, 'selected/another-model');
  assert.equal(h.saved.size, 3);
  const receipt = [...h.saved.values()][0];
  receipt.modelId = 'forged/model';
  h.turns.pop();
  await assert.rejects(h.guard.check(command), { code: 'LIVE_MODEL_MODERATION_UNAVAILABLE' });
});

test('malformed decisions and provider failure never authorize generation', async () => {
  for (const decision of [
    null,
    {},
    { decision: 'allow' },
    { decision: 'allow', category: 'sexual' },
  ]) {
    const h = harness({ decision });
    await assert.rejects(h.guard.check(command), { code: 'LIVE_MODEL_MODERATION_UNAVAILABLE' });
    assert.equal(h.saved.size, 0);
  }
  const h = harness();
  h.fail(Object.assign(new Error('Unknown paid outcome'), { code: 'LIVE_MODEL_TIMEOUT' }));
  await assert.rejects(h.guard.check(command), { code: 'LIVE_MODEL_TIMEOUT' });
  assert.equal(h.saved.size, 0);
});

test('a canceled execution cannot classify or persist an allow verdict', async () => {
  const h = harness();
  h.deactivate();
  await assert.rejects(h.guard.check(command), { code: 'LIVE_MODEL_EXECUTION_STALE' });
  assert.equal(h.requests.length, 0);
});

test('cancel and deadline abort an in-flight moderation request before any allow receipt', async () => {
  for (const expire of [false, true]) {
    const h = harness();
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    h.guard.createModel = ({ signal }) => ({
      moderatePrototype: async () => {
        started();
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      },
    });
    const pending = h.guard.check({
      ...command,
      deadlineAt: new Date(Date.now() + (expire ? 80 : 60000)).toISOString(),
    });
    await ready;
    if (!expire) h.deactivate();
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await assert.rejects(pending, { code: 'LIVE_MODEL_EXECUTION_STALE' });
      assert.equal(h.saved.size, 0);
    } finally {
      clearInterval(keepAlive);
    }
  }
});

test('missing current requirements and invalid cached receipts fail closed', async () => {
  const h = harness();
  h.turns.length = 0;
  await assert.rejects(h.guard.check(command), { code: 'LIVE_MODEL_MODERATION_UNAVAILABLE' });
  assert.equal(h.requests.length, 0);
});

test('classification uses the selected model, a bounded budget and an explicit neutral-context exception', async () => {
  const calls = [];
  const reserved = [];
  const key = 'test-only-moderation-key-with-sufficient-length';
  const model = new LocalLiveModel({
    key,
    model: command.modelId,
    baseUrl: 'https://example.test/v1',
    requireKeyLimit: false,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/models'))
        return new Response(
          JSON.stringify({
            data: [
              {
                id: command.modelId,
                context_length: 128000,
                top_provider: { max_completion_tokens: 16384 },
                pricing: { prompt: '0.000001', completion: '0.000001' },
                supported_parameters: ['response_format'],
              },
            ],
          }),
        );
      calls.push(JSON.parse(options.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({ decision: 'allow', category: 'none' }),
              },
            },
          ],
          usage: { cost: 0.001 },
        }),
      );
    },
  });
  const result = await model.moderatePrototype('Образовательный сайт по репродуктивному здоровью', {
    authorizeQuote: async (quote) => reserved.push(quote),
  });
  assert.equal(result.moderation.decision, 'allow');
  assert.equal(reserved.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].max_tokens, 512);
  assert.equal(calls[0].model, command.modelId);
  assert.match(calls[0].messages[0].content, /medical.*educational/);
  assert.match(calls[0].messages[0].content, /pornographic/);
  assert.match(calls[0].messages[0].content, /never overrides content safety/);
});

test('every explicit reject category is preserved and extra model output is rejected', () => {
  for (const category of [
    'sexual',
    'exploitation',
    'hate',
    'violence',
    'self_harm',
    'criminal_abuse',
  ]) {
    assert.equal(
      parseContentDecision(JSON.stringify({ decision: 'reject', category })).decision,
      'reject',
    );
  }
  assert.throws(
    () => parseContentDecision('{"decision":"allow","category":"none","source":"code"}'),
    { code: 'LIVE_MODEL_MODERATION_UNAVAILABLE' },
  );
});
