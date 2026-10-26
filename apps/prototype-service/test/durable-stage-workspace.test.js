import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DurableStageWorkspace } from '../src/durable-stage-workspace.js';
import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { createPrototypeStoreModels } from '@librechat/data-schemas';
const pin = `sha256:${'a'.repeat(64)}`;
const c = {
  tenantId: '__default__',
  userId: 'b'.repeat(24),
  jobId: 'job_recovery',
  turnId: 'turn_recovery',
  commandId: 'command_recovery',
  attemptId: 'attempt_recovery',
  executionId: 'execution_recovery',
  stage: 'generation',
  expectedRevision: 2,
  fenceToken: 1,
  modelId: '~selected/model',
};
test(
  'real Mongo receipt restores exact output and prior turn after scratch loss; foreign owner/stale fence denied',
  { skip: process.env.PROTOTYPE_MONGO_INTEGRATION !== '1' },
  async () => {
    dotenv.config({ quiet: true });
    const uri = new URL(process.env.PROTOTYPE_MONGO_URI);
    assert.ok(
      uri.protocol === 'mongodb:' &&
        ['localhost', '127.0.0.1'].includes(uri.hostname) &&
        uri.searchParams.has('replicaSet'),
    );
    uri.pathname = `/workspace_recovery_${randomBytes(12).toString('hex')}`;
    const scope = new mongoose.Mongoose(),
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-recovery-'));
    const objects = new Map(),
      storage = {
        async putObject({ key, body, metadata, ifNoneMatch }) {
          if (ifNoneMatch && objects.has(key)) throw new Error('immutable');
          objects.set(key, { body: Buffer.from(body), metadata });
        },
        async headObject({ key }) {
          const value = objects.get(key);
          return value ? { size: value.body.length, metadata: value.metadata } : null;
        },
        async getObject({ key }) {
          return objects.get(key).body;
        },
        async deleteObject({ key }) {
          objects.delete(key);
        },
      };
    try {
      await scope.connect(uri.toString(), { serverSelectionTimeoutMS: 2000 });
      const models = createPrototypeStoreModels(scope);
      await models.PrototypeJob.init();
      await models.PrototypeJob.collection.insertOne({
        jobId: c.jobId,
        userId: new mongoose.Types.ObjectId(c.userId),
        tenantId: c.tenantId,
        modelId: c.modelId,
        revision: 2,
        fenceToken: 1,
        activeTurnId: c.turnId,
        activeCommandId: c.commandId,
        activeAttemptId: c.attemptId,
        activeExecutionId: c.executionId,
        activeStage: c.stage,
        accessRevokedAt: null,
        status: 'running',
      });
      const workspace = new DurableStageWorkspace({
        mongoose: scope,
        jobs: models.PrototypeJob,
        storage,
        bucket: 'fixture-files',
        directory,
        pins: { templateDigest: pin, toolchainDigest: pin },
      });
      const root = path.join(directory, 'turns', c.turnId),
        output = path.join(directory, 'outputs', c.commandId);
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(root, 'plan.json'), '{"reason":"plan_approval"}');
      await fs.writeFile(path.join(output, 'result.json'), '{"type":"waiting"}');
      await workspace.save(c, root, output, true);
      await fs.rm(root, { recursive: true });
      await fs.rm(output, { recursive: true });
      const restored = await workspace.restore(c);
      assert.equal(restored.succeeded, true);
      assert.equal(
        await fs.readFile(path.join(output, 'result.json'), 'utf8'),
        '{"type":"waiting"}',
      );
      const receipt = await workspace.receipts.findOne({ _id: c.commandId });
      await assert.rejects(
        workspace.materialize(receipt, root, output, { userId: 'foreign' }),
        /OWNERSHIP_MISMATCH/,
      );
      await fs.rm(root, { recursive: true });
      await fs.rm(output, { recursive: true });
      const next = {
        ...c,
        commandId: 'command_approve',
        expectedRevision: 3,
        executionId: 'execution_approve',
      };
      await models.PrototypeJob.collection.updateOne(
        { jobId: c.jobId },
        {
          $set: {
            revision: 3,
            activeCommandId: next.commandId,
            activeExecutionId: next.executionId,
          },
        },
      );
      assert.equal(await workspace.restore(next), null);
      assert.equal(
        await fs.readFile(path.join(root, 'plan.json'), 'utf8'),
        '{"reason":"plan_approval"}',
      );
      await assert.rejects(workspace.restore(c), /AUTHORITY_REVOKED/);
      await models.PrototypeJob.collection.updateOne(
        { jobId: c.jobId },
        { $inc: { fenceToken: 1 }, $set: { status: 'canceled' } },
      );
      await assert.rejects(workspace.save(next, root, output, true), /AUTHORITY_REVOKED/);
      assert.equal(await workspace.receipts.countDocuments(), 1);
    } finally {
      if (scope.connection.readyState === 1) await scope.connection.dropDatabase();
      await scope.disconnect();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
