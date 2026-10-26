import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { createPrototypeStoreModels, createPrototypeMethods } from '@librechat/data-schemas';
import { ReactStages } from '../src/react-stages.js';
import { deterministicLeaseId } from '../src/stage-supervisor.js';
import { verifySourceManifest } from '../src/source-manifest.js';

test(
  'a new review turn atomically pins the newly selected model and retains prior generation/artifact pins',
  { skip: process.env.PROTOTYPE_MONGO_INTEGRATION !== '1' },
  async () => {
    const scope = new mongoose.Mongoose();
    const uri = new URL(process.env.PROTOTYPE_MONGO_URI);
    uri.pathname = `/model_reply_${randomUUID().replaceAll('-', '')}`;
    try {
      await scope.connect(uri.toString());
      const models = createPrototypeStoreModels(scope),
        methods = createPrototypeMethods(scope);
      const generation = {
        schemaVersion: 1,
        engineId: 'direct-react-v1',
        sourceProfile: 'react-source-v1',
        rulesDigest: `sha256:${'a'.repeat(64)}`,
        templateDigest: `sha256:${'b'.repeat(64)}`,
        toolchainDigest: `sha256:${'c'.repeat(64)}`,
      };
      await models.PrototypeJob.collection.insertOne({
        jobId: 'job_reply',
        status: 'review',
        revision: 3,
        fenceToken: 4,
        latestPromptMessageId: 'prompt_reply',
        modelId: 'selected/first',
        generation,
        previewDigest: `sha256:${'d'.repeat(64)}`,
        activeTurnId: 'turn_old',
      });
      const session = await scope.startSession();
      let claimed;
      try {
        await session.withTransaction(async () => {
          claimed = await methods.claimPrototypeReply(
            {
              jobId: 'job_reply',
              expectedRevision: 3,
              replyToPrototypeMessageId: 'prompt_reply',
              attemptId: 'attempt_new',
              executionId: 'exec_new',
              turn: {
                turnId: 'turn_new',
                jobId: 'job_reply',
                ordinal: 1,
                kind: 'user_reply',
                commandId: 'cmd_new',
                modelId: 'selected/current',
                text: 'Change layout',
                status: 'pending',
              },
            },
            session,
          );
        });
      } finally {
        await session.endSession();
      }
      assert.equal(claimed.job.modelId, 'selected/current');
      assert.equal(claimed.turn.modelId, 'selected/current');
      assert.equal(claimed.job.activeTurnId, 'turn_new');
      assert.deepEqual(claimed.job.generation, generation);
      assert.equal(claimed.job.previewDigest, `sha256:${'d'.repeat(64)}`);
      assert.equal(claimed.job.revision, 4);
      assert.equal(claimed.job.fenceToken, 5);
    } finally {
      if (scope.connection.readyState === 1) await scope.connection.dropDatabase();
      await scope.disconnect();
    }
  },
);

test(
  'actual generation stage pins its selected model/engine and archives a verified baseline manifest without another model call',
  { skip: process.env.PROTOTYPE_MONGO_INTEGRATION !== '1' },
  async () => {
    const scope = new mongoose.Mongoose();
    const uri = new URL(process.env.PROTOTYPE_MONGO_URI);
    uri.pathname = `/generation_binding_smoke_${randomUUID().replaceAll('-', '')}`;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-generation-binding-'));
    try {
      await scope.connect(uri.toString(), { serverSelectionTimeoutMS: 2000 });
      const models = createPrototypeStoreModels(scope),
        methods = createPrototypeMethods(scope);
      const command = {
        jobId: 'job_binding',
        turnId: 'turn_binding',
        commandId: 'command_binding',
        attemptId: 'attempt_binding',
        executionId: 'execution_binding',
        userId: new mongoose.Types.ObjectId().toString(),
        tenantId: '__default__',
        modelId: 'chosen/model',
        expectedRevision: 2,
        fenceToken: 3,
        stage: 'generation',
        pipelineStep: 0,
      };
      await scope.connection.db.collection('prototypejobs').insertOne({
        jobId: command.jobId,
        userId: new mongoose.Types.ObjectId(command.userId),
        tenantId: command.tenantId,
        modelId: command.modelId,
        revision: command.expectedRevision,
        fenceToken: command.fenceToken,
        status: 'running',
        activeTurnId: command.turnId,
        activeCommandId: command.commandId,
        activeAttemptId: command.attemptId,
        activeExecutionId: command.executionId,
        activeLeaseId: deterministicLeaseId(command),
        activeStage: command.stage,
        pipelineStep: 0,
      });
      await models.PrototypeTurn.create({
        turnId: command.turnId,
        jobId: command.jobId,
        modelId: command.modelId,
        ordinal: 0,
        kind: 'initial',
        commandId: command.commandId,
        text: 'Approved fixture',
        status: 'running',
      });
      const generation = {
        schemaVersion: 1,
        engineId: 'direct-react-v1',
        sourceProfile: 'react-source-v1',
        rulesDigest: `sha256:${'a'.repeat(64)}`,
        templateDigest: `sha256:${'b'.repeat(64)}`,
        toolchainDigest: `sha256:${'c'.repeat(64)}`,
      };
      const turnRoot = path.join(directory, 'turns', command.turnId);
      await fs.mkdir(turnRoot, { recursive: true });
      const source = await fs.readFile(
        new URL('./fixtures/react-design.tsx', import.meta.url),
        'utf8',
      );
      await fs.writeFile(path.join(turnRoot, 'App.tsx'), source);
      let modelCalls = 0;
      const stages = new ReactStages({
        checkContent: async () => {}, // This integration isolates immutable generation pins.
        mongoose: scope,
        models,
        methods,
        directory,
        generationBinding: generation,
        createModel: () => {
          modelCalls++;
          throw new Error('Cached source retry must not call a provider');
        },
        log: () => {},
      });
      const result = await stages.execute(command);
      assert.equal(result.succeeded, true);
      assert.equal(modelCalls, 0);
      const materialized = await fs.readFile(
        path.join(turnRoot, 'checkpoint-source/src/app/App.tsx'),
        'utf8',
      );
      const manifest = JSON.parse(
        await fs.readFile(path.join(turnRoot, 'checkpoint-source/source-manifest.json'), 'utf8'),
      );
      verifySourceManifest(manifest, { 'src/app/App.tsx': materialized });
      assert.equal(manifest.engineId, generation.engineId);
      assert.equal(manifest.modelId, command.modelId);
      assert.deepEqual(
        (await models.PrototypeJob.findOne({ jobId: command.jobId }).lean()).generation,
        generation,
      );
      assert.deepEqual(
        (await models.PrototypeTurn.findOne({ turnId: command.turnId }).lean()).generation,
        generation,
      );
      await assert.rejects(
        stages.execute({ ...command, modelId: 'silently-switched/model' }),
        /no longer active/,
      );
      const rejected = await new ReactStages({
        mongoose: scope,
        models,
        methods,
        directory,
        generationBinding: { ...generation, rulesDigest: `sha256:${'d'.repeat(64)}` },
      }).execute(command);
      assert.equal(rejected.succeeded, false);
      assert.equal(rejected.writersStopped, true);
      const failure = JSON.parse(
        await fs.readFile(path.join(rejected.outputRoot, 'failure.json'), 'utf8'),
      );
      assert.equal(failure.code, 'PROTOTYPE_EXECUTION_FAILED');
      assert.deepEqual(failure.diagnostics, ['PROTOTYPE_GENERATION_BINDING_CONFLICT']);
    } finally {
      if (scope.connection.readyState === 1) await scope.connection.dropDatabase();
      await scope.disconnect();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
