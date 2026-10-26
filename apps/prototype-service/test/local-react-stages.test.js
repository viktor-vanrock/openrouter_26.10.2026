import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalReactStages } from '../src/local-react-stages.js';
import { readVerifiedStageFailure } from '../src/stage-supervisor.js';
import { readVerifiedStageResult } from '../src/stage-supervisor.js';

const command = {
  jobId: 'job_test',
  turnId: 'turn_test',
  commandId: 'command_test',
  executionId: 'execution_test',
  attemptId: 'attempt_test',
  stage: 'build_qa',
  pipelineStep: 4,
  expectedRevision: 4,
  fenceToken: 1,
  userId: 'user_test',
  tenantId: 'tenant_test',
};
const source =
  "import { Button } from '@ai-sber/uikit'; export function App() { return <Button>Добавить</Button>; }";

test('rejected model text stays in an owner-only private file and never enters logs or failure artifacts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-rejected-response-'));
  const events = [];
  const text = 'Пожалуйста, подтвердите план. private-diagnostic-content';
  const stages = new LocalReactStages({
    directory,
    log: (event, fields) => events.push({ event, ...fields }),
    models: {
      PrototypeJob: {
        findOne: () => ({
          lean: async () => ({
            status: 'running',
            activeTurnId: command.turnId,
            activeCommandId: command.commandId,
            activeExecutionId: command.executionId,
          }),
        }),
      },
    },
  });
  stages.run = async () => {
    throw Object.assign(new Error('LIVE_MODEL_REACT_INVALID'), {
      code: 'LIVE_MODEL_REACT_INVALID',
      rawSource: text,
    });
  };
  const generation = { ...command, stage: 'generation', pipelineStep: 0 };
  try {
    const output = await stages.execute(generation);
    const file = path.join(
      stages.turnDirectory(generation),
      `rejected-model-${command.commandId}.txt`,
    );
    assert.equal(await fs.readFile(file, 'utf8'), text);
    assert.equal((await fs.stat(file)).mode & 0o077, 0);
    const receipt = await fs.readFile(path.join(output.outputRoot, 'failure.json'), 'utf8');
    assert.doesNotMatch(receipt + JSON.stringify(events), /private-diagnostic-content/);
    assert.ok(
      events.some(
        (entry) => entry.event === 'model.response_saved' && entry.commandId === command.commandId,
      ),
    );
  } finally {
    stages.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('invalid cached React reaches stage failure with exact rule, identities and durable diagnostic', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-validation-log-'));
  const events = [];
  const active = {
    status: 'running',
    activeTurnId: command.turnId,
    activeCommandId: command.commandId,
    activeExecutionId: command.executionId,
  };
  const stages = new LocalReactStages({
    directory,
    log: (event, fields) => events.push({ event, ...fields }),
    models: { PrototypeJob: { findOne: () => ({ lean: async () => active }) } },
    createModel: () => assert.fail('invalid cached source must not recall the model'),
  });
  const generation = { ...command, stage: 'generation', pipelineStep: 0 };
  try {
    const root = stages.turnDirectory(generation);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, 'App.tsx'),
      'export function App() { return <button>private-title</button>; }',
    );
    const output = await stages.execute(generation);
    assert.equal(output.succeeded, false);
    const failure = events.find((entry) => entry.event === 'stage.failed');
    assert.equal(failure.code, 'LIVE_MODEL_REACT_INVALID');
    assert.equal(failure.reason, 'uikit_component_not_rendered');
    assert.equal(failure.executionId, generation.executionId);
    assert.equal(failure.commandId, generation.commandId);
    const receipt = await readVerifiedStageFailure(generation, output.outputRoot);
    assert.match(receipt.diagnostics[0], /uikit_component_not_rendered/);
    assert.doesNotMatch(JSON.stringify(events), /private-title/);
  } finally {
    stages.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retry repairs a cached UI Kit icon conflict without invoking the model and preserves the original source', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-cached-repair-'));
  const root = path.join(directory, 'turns/turn_test');
  await fs.mkdir(root, { recursive: true });
  const broken =
    "import { Button } from '@ai-sber/uikit'; import { Plus, Pencil } from 'lucide-react';export function App(){return <Button leftIcon={<Plus/>} rightIcon={<Pencil/>}>Go</Button>}";
  await fs.writeFile(path.join(root, 'App.tsx'), broken);
  const stages = new LocalReactStages({
    directory,
    createModel: () => {
      throw new Error('Retry must reuse source');
    },
  });
  const retry = { ...command, stage: 'generation', pipelineStep: 0 };
  try {
    const output = await stages.execute(retry);
    assert.equal((await readVerifiedStageResult(retry, output.outputRoot)).type, 'code_done');
    assert.doesNotMatch(await fs.readFile(path.join(root, 'App.tsx'), 'utf8'), /leftIcon|Plus/);
    assert.equal(await fs.readFile(path.join(root, 'App.before-kit-repair.tsx'), 'utf8'), broken);
    assert.match(
      await fs.readFile(path.join(directory, 'service.log'), 'utf8'),
      /SOURCE_STATIC_REPAIR/,
    );
  } finally {
    stages.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('retry repairs cached TS6133 bindings before a new checkpoint without recalling the provider', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-unused-repair-'));
  const root = path.join(directory, 'turns/turn_test');
  await fs.mkdir(root, { recursive: true });
  const broken =
    "import { Button } from '@ai-sber/uikit';import { useState } from 'react';export function App(){const [isOpen,setIsOpen]=useState(false);const employee={id:'1',status:'active'};const {id,status}=employee;return <Button onClick={()=>setIsOpen(true)}>{id}</Button>}";
  await fs.writeFile(path.join(root, 'App.tsx'), broken);
  const stages = new LocalReactStages({
    directory,
    createModel: () => {
      throw new Error('No provider recall');
    },
  });
  const retry = { ...command, stage: 'generation', pipelineStep: 0, commandId: 'retry_unused' };
  try {
    const output = await stages.execute(retry);
    assert.equal((await readVerifiedStageResult(retry, output.outputRoot)).type, 'code_done');
    const repaired = await fs.readFile(path.join(root, 'App.tsx'), 'utf8');
    assert.match(repaired, /\[,setIsOpen\]=useState/);
    assert.match(repaired, /const \{id\}=employee/);
    assert.equal(await fs.readFile(path.join(root, 'App.before-kit-repair.tsx'), 'utf8'), broken);
  } finally {
    stages.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a failed isolated compilation is returned as a durable failure without publication or another model call', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-stage-'));
  await fs.mkdir(path.join(directory, 'turns/turn_test'), { recursive: true });
  await fs.writeFile(path.join(directory, 'turns/turn_test/App.tsx'), source);
  let calls = 0;
  const stages = new LocalReactStages({
    directory,
    gatewayUrl: 'https://example.test/v1',
    models: {
      PrototypeJob: {
        findOne: () => ({
          lean: async () => ({
            status: 'running',
            activeTurnId: command.turnId,
            activeCommandId: command.commandId,
            activeExecutionId: command.executionId,
          }),
        }),
      },
    },
    pipeline: {
      run: async () => {
        calls++;
        throw Object.assign(new Error('PIPELINE_EXECUTION_FAILED'), {
          writersStopped: true,
          diagnostics: [
            'type-check: src/app/App.tsx(296,10): error TS2322: rightIcon is incompatible',
          ],
        });
      },
    },
  });
  try {
    const output = await stages.execute(command);
    assert.equal(output.succeeded, false);
    const failure = await readVerifiedStageFailure(command, output.outputRoot);
    assert.equal(failure.code, 'PROTOTYPE_BUILD_FAILED');
    assert.equal(failure.retryable, false);
    assert.equal(
      failure.message,
      'Не удалось подготовить прототип к просмотру. Результат не опубликован.',
    );
    assert.doesNotMatch(failure.message, /TS2322|rightIcon|React|App\.tsx/);
    assert.match(failure.diagnostics[0], /rightIcon/);
    assert.match(await fs.readFile(path.join(directory, 'service.log'), 'utf8'), /TS2322/);
    assert.equal((await stages.execute(command)).succeeded, false);
    assert.equal(calls, 1, 'Persisted failure must not repeat the sandbox execution');
    await assert.rejects(fs.access(path.join(directory, 'turns/turn_test/snapshot.json')));
  } finally {
    stages.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an uncertain sandbox shutdown cannot be represented as a completed durable failure', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-stage-'));
  await fs.mkdir(path.join(directory, 'turns/turn_test'), { recursive: true });
  await fs.writeFile(path.join(directory, 'turns/turn_test/App.tsx'), source);
  const stages = new LocalReactStages({
    directory,
    gatewayUrl: 'https://example.test/v1',
    models: {
      PrototypeJob: {
        findOne: () => ({
          lean: async () => ({
            status: 'running',
            activeTurnId: command.turnId,
            activeCommandId: command.commandId,
            activeExecutionId: command.executionId,
          }),
        }),
      },
    },
    pipeline: {
      run: async () => {
        throw new Error('PIPELINE_CANCEL_UNCONFIRMED');
      },
    },
  });
  try {
    await assert.rejects(stages.execute(command), /CANCEL_UNCONFIRMED/);
    await assert.rejects(fs.access(path.join(directory, 'outputs/command_test/failure.json')));
  } finally {
    stages.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('runtime QA failure requests a bounded repair; browser infrastructure failure does not request model work', async () => {
  for (const [failureCode, retryable] of [
    ['PROTOTYPE_QA_FAILED', true],
    ['PROTOTYPE_QA_INFRASTRUCTURE_FAILED', false],
  ]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-qa-failure-'));
    await fs.mkdir(path.join(directory, 'turns/turn_test'), { recursive: true });
    await fs.writeFile(path.join(directory, 'turns/turn_test/App.tsx'), source);
    const stages = new LocalReactStages({
      directory,
      log: () => {},
      models: {
        PrototypeJob: {
          findOne: () => ({
            lean: async () => ({
              status: 'running',
              activeTurnId: command.turnId,
              activeCommandId: command.commandId,
              activeExecutionId: command.executionId,
            }),
          }),
        },
      },
      pipeline: {
        run: async () => {
          throw Object.assign(new Error(failureCode), {
            failureCode,
            writersStopped: true,
            diagnostics: ['Preview startup fixture failed'],
          });
        },
      },
    });
    try {
      const output = await stages.execute(command);
      const failure = await readVerifiedStageFailure(command, output.outputRoot);
      assert.equal(failure.retryable, retryable);
      assert.equal(failure.code, failureCode);
      await assert.rejects(fs.access(path.join(directory, 'turns/turn_test/snapshot.json')));
    } finally {
      stages.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});
