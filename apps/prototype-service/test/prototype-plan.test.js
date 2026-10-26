import test from 'node:test';
import assert from 'node:assert/strict';
import { reactPrototypeInstructions } from '../src/react-prototype.js';
import { LocalReactStages } from '../src/local-react-stages.js';
import { readVerifiedStageResult } from '../src/stage-supervisor.js';
import { selectedPrototypeVariant } from '../src/prototype-dialogue.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('analysis can ask a question, resume into a plan, then generate code only after approval', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-planning-'));
  let current = {
    jobId: 'job_test',
    turnId: 'turn_first',
    commandId: 'submit_first',
    executionId: 'exec_test',
    attemptId: 'attempt_test',
    stage: 'generation',
    pipelineStep: 0,
    expectedRevision: 0,
    fenceToken: 1,
  };
  const turns = [{ text: 'Нужен экран заявок', turnId: 'turn_first' }];
  let plans = 0,
    code = 0;
  const stages = new LocalReactStages({
    directory,
    gatewayUrl: 'https://example.test/v1',
    methods: { getUserKeyValues: async () => ({ apiKey: 'test-only' }) },
    models: {
      PrototypeTurn: {
        find: () => ({ sort: () => ({ select: () => ({ lean: async () => turns }) }) }),
      },
      PrototypeJob: {
        findOne: () => ({
          lean: async () => ({
            status: 'running',
            activeTurnId: current.turnId,
            activeCommandId: current.commandId,
            activeExecutionId: current.executionId,
          }),
        }),
      },
    },
    createModel: () => ({
      planPrototype: async (prompt) => {
        plans++;
        if (plans === 1)
          return { plan: { reason: 'clarification', prompt: 'Какие статусы нужны для заявки?' } };
        assert.match(prompt, /Какие статусы/);
        assert.match(prompt, /Новая, в работе, закрыта/);
        return {
          plan: {
            reason: 'plan_approval',
            prompt:
              '## План прототипа\nЗаявки со статусами, созданием и редактированием.\nВарианты дизайна: A — список; B — доска.',
          },
        };
      },
      generateReact: async (prompt) => {
        code++;
        assert.match(prompt, /Утверждённый план/);
        return {
          source: await fs.readFile(
            new URL('./fixtures/react-design.tsx', import.meta.url),
            'utf8',
          ),
        };
      },
    }),
    pipeline: {
      run: () => {
        throw new Error('Dialogue must not build');
      },
    },
  });
  try {
    const waiting = await stages.execute(current);
    assert.equal(
      (await readVerifiedStageResult(current, waiting.outputRoot)).reason,
      'clarification',
    );
    assert.equal(code, 0);
    await stages.execute(current);
    assert.equal(plans, 1, 'Replay must reuse the paid planning result');
    turns.push({ text: 'Новая, в работе, закрыта', turnId: 'turn_reply' });
    current = { ...current, commandId: 'reply_first', turnId: 'turn_reply', expectedRevision: 2 };
    const planned = await stages.execute(current);
    assert.equal(
      (await readVerifiedStageResult(current, planned.outputRoot)).reason,
      'plan_approval',
    );
    assert.equal(code, 0);
    current = { ...current, commandId: 'approve_first', expectedRevision: 4 };
    const generated = await stages.execute(current);
    assert.equal((await readVerifiedStageResult(current, generated.outputRoot)).type, 'code_done');
    assert.equal(code, 1);
  } finally {
    stages.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('default prompt requires React/forms/designs; final mode removes the switcher', async () => {
  const prompt = await reactPrototypeInstructions();
  assert.match(prompt, /mandatory DEFAULT/);
  assert.match(prompt, /editing must prefill/);
  assert.match(prompt, /form="/);
  assert.match(prompt, /data-prototype-variant/);
  assert.match(prompt, /same complete data actions/);
  assert.match(prompt, /laptops and phones/);
  assert.match(prompt, /in memory only/);
  assert.match(prompt, /Never override Button text color/);
  const final = await reactPrototypeInstructions({ finalVariant: 'B' });
  assert.match(final, /explicitly selected design B/);
  assert.doesNotMatch(final, /Implement two genuinely different layouts/);
});

test('finalization requires explicit selection, not a mention of a design in requirements', () => {
  assert.equal(selectedPrototypeVariant('Выбираю вариант B. Финализируй прототип.'), 'B');
  assert.equal(selectedPrototypeVariant('Беру вариант A — таблица'), null);
  assert.equal(selectedPrototypeVariant('Выбираю вариант B, добавь сортировку'), null);
  assert.equal(selectedPrototypeVariant('Выбираю вариант B, не завершай: добавь сортировку'), null);
  assert.equal(selectedPrototypeVariant('Добавь вариант B, потом сравним'), null);
});
