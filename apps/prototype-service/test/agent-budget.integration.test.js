import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { createPrototypeStoreModels } from '@librechat/data-schemas';
import { AgentTurnBudget } from '../src/agent-budget.js';
const hash = `sha256:${'a'.repeat(64)}`;
test(
  'real turn budget admits multiple requests once, retains unknown charges, fences cancel and accounts reported overrun',
  { skip: process.env.PROTOTYPE_MONGO_INTEGRATION !== '1' },
  async () => {
    const scope = new mongoose.Mongoose(),
      uri = new URL(process.env.PROTOTYPE_MONGO_URI);
    uri.pathname = `/agent_budget_smoke_${randomUUID().replaceAll('-', '')}`;
    try {
      await scope.connect(uri.toString(), { serverSelectionTimeoutMS: 2000 });
      const models = createPrototypeStoreModels(scope);
      let now = Date.now();
      const command = {
        jobId: 'job_budget',
        turnId: 'turn_budget',
        commandId: 'command_budget',
        attemptId: 'attempt_budget',
        executionId: 'execution_budget',
        leaseId: 'lease_budget',
        tenantId: '__default__',
        userId: new mongoose.Types.ObjectId().toString(),
        modelId: 'selected/model',
        expectedRevision: 2,
        fenceToken: 3,
      };
      await scope.connection.db.collection('prototypejobs').insertOne({
        jobId: command.jobId,
        modelId: command.modelId,
        tenantId: command.tenantId,
        userId: new mongoose.Types.ObjectId(command.userId),
        revision: 2,
        fenceToken: 3,
        activeTurnId: command.turnId,
        activeCommandId: command.commandId,
        activeAttemptId: command.attemptId,
        activeExecutionId: command.executionId,
        activeLeaseId: command.leaseId,
        activeStage: 'generation',
        status: 'running',
      });
      const budget = new AgentTurnBudget({
        mongoose: scope,
        jobs: models.PrototypeJob,
        now: () => now,
      });
      const limits = { maxCostUsd: 2, maxRequests: 8, activeTimeoutMs: 600000 };
      const reserve = (requestId, upperCostUsd = 0.5, overrides = {}) =>
        budget.reserve({
          command,
          requestId,
          requestDigest: hash,
          upperCostUsd,
          limits,
          ...overrides,
        });
      await reserve('request1');
      await assert.rejects(reserve('request1'), /REQUEST_REPLAY/);
      await assert.rejects(
        reserve('request1', 0.5, { requestDigest: `sha256:${'b'.repeat(64)}` }),
        /REQUEST_CONFLICT/,
      );
      await budget.settle({ command, requestId: 'request1', actualCostUsd: null });
      assert.equal((await budget.turns.findOne({ _id: command.turnId })).reservedMicros, 500000);
      await reserve('request2');
      await budget.settle({
        command,
        requestId: 'request2',
        actualCostUsd: 0.1,
        promptTokens: 10,
        completionTokens: 20,
      });
      await budget.settle({
        command,
        requestId: 'request2',
        actualCostUsd: 0.1,
        promptTokens: 10,
        completionTokens: 20,
      });
      assert.equal((await budget.turns.findOne({ _id: command.turnId })).reservedMicros, 600000);
      await assert.rejects(reserve('too-expensive', 1.5), /BUDGET_EXCEEDED/);
      await scope.connection.db
        .collection('prototypemodelbudgets')
        .updateOne({ _id: command.turnId }, { $set: { reservedMicros: 400000 } }, { upsert: true });
      await assert.rejects(reserve('must-count-planner', 1.1), /BUDGET_EXCEEDED/);
      await scope.connection.db
        .collection('prototypemodelbudgets')
        .deleteOne({ _id: command.turnId });
      assert.equal(await budget.requests.countDocuments(), 2);
      await reserve('request3', 0.1);
      await budget.settle({ command, requestId: 'request3', actualCostUsd: 2.1 });
      assert.equal((await budget.turns.findOne({ _id: command.turnId })).reservedMicros, 2700000);
      await assert.rejects(reserve('after-overrun', 0.01), /BUDGET_EXCEEDED/);
      await scope.connection.db
        .collection('prototypejobs')
        .updateOne(
          { jobId: command.jobId },
          { $inc: { fenceToken: 1 }, $set: { status: 'canceled' } },
        );
      await assert.rejects(reserve('after-cancel'), /AUTHORITY_REVOKED/);
      // Receipt for an already running paid call can settle after revocation, without issuing another request.
      await budget.settle({ command, requestId: 'request1', actualCostUsd: 0.2 });
      assert.equal((await budget.turns.findOne({ _id: command.turnId })).reservedMicros, 2400000);
      now += 600001;
      assert.equal(await budget.requests.countDocuments(), 3);
      // Another explicit turn can use the 8-request ceiling, including parallel requests.
      const next = {
        ...command,
        turnId: 'turn_request_limit',
        commandId: 'command_next',
        executionId: 'execution_next',
        fenceToken: 4,
      };
      await scope.connection.db.collection('prototypejobs').updateOne(
        { jobId: command.jobId },
        {
          $set: {
            status: 'running',
            activeTurnId: next.turnId,
            activeCommandId: next.commandId,
            activeExecutionId: next.executionId,
          },
        },
      );
      const reserveNext = (requestId) =>
        budget.reserve({
          command: next,
          requestId,
          requestDigest: hash,
          upperCostUsd: 0.01,
          limits,
        });
      await Promise.all(Array.from({ length: 8 }, (_, i) => reserveNext(`bounded_${i}`)));
      await assert.rejects(reserveNext('ninth'), /BUDGET_EXCEEDED/);
      now += 600001;
      await assert.rejects(reserveNext('after-deadline'), /BUDGET_EXCEEDED/);
    } finally {
      if (scope.connection.readyState === 1) await scope.connection.dropDatabase();
      await scope.disconnect();
    }
  },
);
