import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrototypeMethods } from '@librechat/data-schemas';
import { ReactStages } from '../src/react-stages.js';
import {
  createControlPlaneStageSupervisor,
  readVerifiedStageFailure,
} from '../src/stage-supervisor.js';
import { PrototypeOrchestratorRuntime } from '../src/orchestrator-runtime.js';

const binding = {
  schemaVersion: 1,
  engineId: 'direct-react-v1',
  sourceProfile: 'react-source-v1',
  rulesDigest: `sha256:${'a'.repeat(64)}`,
  templateDigest: `sha256:${'b'.repeat(64)}`,
  toolchainDigest: `sha256:${'c'.repeat(64)}`,
};
const command = {
  schemaVersion: 2,
  jobId: 'job_retry',
  turnId: 'turn_retry',
  commandId: 'retry_1',
  executionId: 'execution_retry',
  attemptId: 'attempt_retry',
  userId: 'owner_1',
  tenantId: '__default__',
  modelId: '~openai/gpt-luna-latest',
  stage: 'generation',
  pipelineStep: 0,
  expectedRevision: 4,
  fenceToken: 3,
};

test('content rejection stops a generation before a restored result, model or build can bypass it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-content-preflight-'));
  let restored = 0;
  let checked = 0;
  const stages = new ReactStages({
    directory,
    mongoose: {
      startSession: async () => ({
        withTransaction: (fn) => fn(),
        endSession: async () => {},
      }),
    },
    methods: { pinPrototypeGeneration: async () => {} },
    generationBinding: binding,
    checkContent: async () => {
      checked++;
      throw Object.assign(new Error('Content rejected'), { code: 'LIVE_MODEL_CONTENT_BLOCKED' });
    },
    workspace: {
      restore: async () => {
        restored++;
        return { succeeded: true };
      },
      save: async () => assert.fail('Rejected content must not save a successful result'),
    },
    log: () => {},
  });
  stages.run = async () => assert.fail('Rejected content must not reach generation/build');
  try {
    const output = await stages.execute(command);
    assert.equal(output.succeeded, false);
    assert.equal(checked, 1);
    assert.equal(restored, 0);
    const failure = JSON.parse(
      await fs.readFile(path.join(output.outputRoot, 'failure.json'), 'utf8'),
    );
    assert.equal(failure.retryable, false);
    assert.deepEqual(failure.diagnostics, ['LIVE_MODEL_CONTENT_BLOCKED']);
    assert.match(failure.message, /содержани|правил/);
    assert.equal(
      (await readVerifiedStageFailure(command, output.outputRoot)).code,
      'PROTOTYPE_EXECUTION_FAILED',
    );
  } finally {
    stages.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the default worker guard rejects historical file requirements on approve and cached source retry', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-real-content-guard-'));
  let requests = 0;
  const receipts = new Map();
  const stages = new ReactStages({
    directory,
    gatewayUrl: 'https://example.test/v1',
    mongoose: {
      startSession: async () => ({ withTransaction: (fn) => fn(), endSession: async () => {} }),
      connection: {
        db: {
          collection: () => ({
            findOne: async ({ _id }) => receipts.get(_id),
            insertOne: async (entry) => receipts.set(entry._id, entry),
          }),
        },
      },
    },
    models: {
      PrototypeJob: {
        findOne: () => ({
          lean: async () => ({
            status: 'running',
            activeTurnId: command.turnId,
            activeCommandId: stages.currentCommand.commandId,
            activeExecutionId: command.executionId,
          }),
        }),
      },
      PrototypeTurn: {
        find: () => ({
          sort: () => ({
            select: () => ({
              lean: async () => [
                {
                  turnId: command.turnId,
                  text: 'Приложенный документ: requirements.txt\nblocked-document-fixture',
                },
              ],
            }),
          }),
        }),
      },
    },
    methods: {
      pinPrototypeGeneration: async () => {},
      getUserKeyValues: async () => ({ apiKey: 'fixture-only' }),
    },
    generationBinding: binding,
    createModel: () => ({
      moderatePrototype: async (text) => {
        requests++;
        assert.match(text, /blocked-document-fixture/);
        return { moderation: { decision: 'reject', category: 'sexual' } };
      },
    }),
    workspace: {
      restore: async () => assert.fail('Rejected requirements cannot restore old code'),
    },
    log: () => {},
  });
  stages.run = async () => assert.fail('Rejected requirements cannot reach code or sandbox');
  try {
    for (const commandId of ['approve_legacy', 'retry_legacy']) {
      stages.currentCommand = { ...command, commandId };
      const output = await stages.execute(stages.currentCommand);
      assert.equal(output.succeeded, false);
      const failure = await readVerifiedStageFailure(stages.currentCommand, output.outputRoot);
      assert.deepEqual(failure.diagnostics, ['LIVE_MODEL_CONTENT_BLOCKED']);
    }
    assert.equal(requests, 1, 'The retry reuses the persisted rejection');
  } finally {
    stages.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function harness({ stale = false, turnConflict = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-preflight-'));
  const job = { generation: binding };
  const mongoose = {
    models: {
      PrototypeJob: {
        findOne: () => ({ lean: async () => (stale ? null : job) }),
        updateOne: async () => assert.fail('pins must not be overwritten'),
      },
      PrototypeTurn: {
        findOne: () => ({
          lean: async () => ({
            generation: { ...binding, rulesDigest: `sha256:${'d'.repeat(64)}` },
          }),
        }),
        updateOne: async () => assert.fail('turn pins must not be overwritten'),
      },
    },
    startSession: async () => ({
      inTransaction: () => true,
      withTransaction: (fn) => fn(),
      endSession: async () => {},
    }),
  };
  const stages = new ReactStages({
    directory,
    mongoose,
    methods: createPrototypeMethods(mongoose),
    workspace: {
      restore: async () => null,
      save: async () => assert.fail('conflicting generation must not save workspace'),
    },
    generationBinding: turnConflict
      ? binding
      : { ...binding, rulesDigest: `sha256:${'d'.repeat(64)}` },
    log: () => {},
  });
  stages.run = async () => assert.fail('conflicting pins must not call model or sandbox');
  return {
    directory,
    job,
    stages,
    cleanup: async () => {
      stages.stop();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test('retry after worker rules change reports a fenced failure to API and acknowledges instead of leaving UI running', async () => {
  const h = await harness();
  const card = { status: 'running', failure: null };
  const acknowledged = [];
  let released = 0;
  const supervisor = createControlPlaneStageSupervisor({
    waitForCompletion: (input) => h.stages.execute(input),
    client: {
      registerLease: async () => {},
      completeStage: async () => assert.fail('must not complete'),
      completeWaiting: async () => assert.fail('must not wait'),
      completePublication: async () => assert.fail('must not publish'),
      failStage: async (failure) => {
        card.status = 'failed';
        card.failure = failure;
      },
    },
  });
  const runtime = new PrototypeOrchestratorRuntime({
    executionMode: 'supervised',
    supervisor,
    source: { acknowledge: async (id) => acknowledged.push(id) },
    registry: { claim: async () => ({ accepted: true }) },
    quota: {
      claim: async () => ({ accepted: true }),
      release: async () => {
        released++;
      },
    },
  });
  try {
    await runtime.handle({ streamId: '1-0', command });
    assert.equal(card.status, 'failed');
    assert.equal(card.failure.code, 'PROTOTYPE_EXECUTION_FAILED');
    assert.match(card.failure.message, /обновлён|обновлен/);
    assert.match(card.failure.message, /новый прототип/);
    assert.equal(card.failure.commandId, command.commandId);
    assert.equal(card.failure.expectedRevision, 4);
    assert.equal(card.failure.fenceToken, 3);
    assert.match(card.failure.leaseId, /^lease_/);
    assert.deepEqual(acknowledged, ['1-0']);
    assert.equal(released, 1);
    assert.deepEqual(h.job.generation, binding);
  } finally {
    await h.cleanup();
  }
});

test('conflicting turn binding is reported as failure without executing or overwriting generation pins', async () => {
  const h = await harness({ turnConflict: true });
  try {
    const output = await h.stages.execute(command);
    assert.equal(output.succeeded, false);
    assert.equal(output.writersStopped, true);
  } finally {
    await h.cleanup();
  }
});

test('a stale generation execution stays rejected and cannot fail another active execution', async () => {
  const h = await harness({ stale: true });
  try {
    await assert.rejects(h.stages.execute(command), { code: 'PROTOTYPE_STALE_REVISION' });
  } finally {
    await h.cleanup();
  }
});
