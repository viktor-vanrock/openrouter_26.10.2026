import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createPrototypeStoreModels } from '@librechat/data-schemas';
import { LocalReactStages } from '../src/local-react-stages.js';
const skip = process.env.PROTOTYPE_MONGO_INTEGRATION !== '1';
test(
  'repair uses the same model and budget, persists response before source replacement, replay never recalls provider',
  { skip },
  async () => {
    const scope = new mongoose.Mongoose();
    const uri = new URL(process.env.PROTOTYPE_MONGO_URI);
    uri.pathname = `/browser_repair_${randomUUID().replaceAll('-', '')}`;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-browser-repair-'));
    let calls = 0;
    try {
      await scope.connect(uri.toString());
      const models = createPrototypeStoreModels(scope);
      const command = {
        jobId: 'job_repair',
        turnId: 'turn_repair',
        commandId: 'cmd_repair',
        executionId: 'exec_repair',
        attemptId: 'attempt_repair',
        stage: 'generation',
        pipelineStep: 0,
        expectedRevision: 2,
        fenceToken: 3,
        userId: new mongoose.Types.ObjectId().toString(),
        tenantId: '__default__',
        modelId: 'selected/model',
        repair: { ordinal: 1, diagnostics: ['Runtime ReferenceError: value is undefined'] },
      };
      await models.PrototypeJob.collection.insertOne({
        jobId: command.jobId,
        status: 'running',
        modelId: command.modelId,
        userId: new mongoose.Types.ObjectId(command.userId),
        tenantId: command.tenantId,
        revision: 2,
        fenceToken: 3,
        activeCommandId: command.commandId,
        activeTurnId: command.turnId,
        activeExecutionId: command.executionId,
        activeStage: 'generation',
        activeAttemptId: command.attemptId,
        accessRevokedAt: null,
      });
      await models.PrototypeTurn.create({
        jobId: command.jobId,
        turnId: command.turnId,
        modelId: command.modelId,
        ordinal: 0,
        kind: 'initial',
        commandId: 'initial',
        text: 'Approved prototype requirements',
        status: 'running',
      });
      const root = path.join(directory, 'turns', command.turnId);
      await fs.mkdir(root, { recursive: true });
      const broken =
        "import {Button} from '@ai-sber/uikit';export function App(){return <Button>{JSON.parse('runtime-failure')}</Button>}";
      const fixed =
        'import {Button} from \'@ai-sber/uikit\';export function App(){return <><section aria-label="Варианты дизайна"><Button>A</Button><Button>B</Button></section><section data-prototype-variant="A"><Button>Ready</Button></section></>}';
      await fs.writeFile(path.join(root, 'App.tsx'), broken);
      const stages = new LocalReactStages({
        mongoose: scope,
        models,
        directory,
        gatewayUrl: 'https://provider.example/v1',
        methods: { getUserKeyValues: async () => ({ apiKey: 'private-fixture-key' }) },
        log: () => {},
        createModel: (options) => {
          assert.equal(options.model, command.modelId);
          return {
            generateReact: async (prompt, callbacks) => {
              calls++;
              assert.match(prompt, /Runtime ReferenceError/);
              assert.match(prompt, /Approved prototype requirements/);
              await callbacks.authorizeQuote(0.1, { maxOutputTokens: 4096 });
              await callbacks.onUsage({ cost: 0.01, prompt_tokens: 20, completion_tokens: 30 });
              return { source: fixed };
            },
          };
        },
      });
      assert.equal((await stages.execute(command)).succeeded, true);
      assert.equal(calls, 1);
      assert.equal(await fs.readFile(path.join(root, 'App.tsx'), 'utf8'), fixed);
      assert.equal(
        (
          await scope.connection.db
            .collection('prototypecoderepairs')
            .findOne({ _id: command.commandId })
        ).source,
        fixed,
      );
      assert.equal(
        await scope.connection.db.collection('prototypemodelreservations').countDocuments(),
        1,
      );
      assert.equal((await stages.execute(command)).succeeded, true);
      assert.equal(calls, 1);
      await assert.rejects(
        stages.repairSource({ ...command, userId: new mongoose.Types.ObjectId().toString() }, root),
        /AUTHORITY_REVOKED/,
      );
      await assert.rejects(
        stages.repairSource({ ...command, expectedRevision: 3 }, root),
        /AUTHORITY_REVOKED/,
      );
      // Lose only the cached stage output; durable response permits recovery without provider recall.
      await fs.rm(path.join(directory, 'outputs', command.commandId), { recursive: true });
      assert.equal((await stages.execute(command)).succeeded, true);
      assert.equal(calls, 1);
      await assert.rejects(
        stages.repairSource({ ...command, repair: { ...command.repair, ordinal: 3 } }, root),
        /REPAIR_LIMIT/,
      );
      await models.PrototypeJob.collection.updateOne(
        { jobId: command.jobId },
        { $set: { status: 'canceled' }, $inc: { fenceToken: 1 } },
      );
      await assert.rejects(stages.repairSource(command, root), /AUTHORITY_REVOKED/);
      stages.stop();
    } finally {
      if (scope.connection.readyState === 1) await scope.connection.dropDatabase();
      await scope.disconnect();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
