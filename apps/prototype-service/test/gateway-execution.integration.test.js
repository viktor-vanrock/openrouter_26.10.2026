import assert from 'node:assert/strict';
import test from 'node:test';
import mongoose from 'mongoose';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { randomUUID } from 'node:crypto';
import { createPrototypeStoreModels } from '@librechat/data-schemas';
import { GatewayExecutionRepository } from '../src/gateway-execution-repository.js';
import { GatewayPipelineClient } from '../src/gateway-pipeline-client.js';
import { REACT_BUILD_PROFILE, digest, pipelineIdentity } from '../src/pipeline-contract.js';

const enabled = process.env.PROTOTYPE_MONGO_INTEGRATION === '1';
test(
  'Mongo ledger preserves ambiguous POSTs and a verified snapshot on S3 failure',
  { skip: !enabled },
  async () => {
    const scope = new mongoose.Mongoose();
    const suffix = randomUUID().replaceAll('-', '');
    const uri = new URL(process.env.PROTOTYPE_MONGO_URI);
    uri.pathname = `/gateway_ledger_smoke_${suffix}`;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-ledger-'));
    try {
      await scope.connect(uri.toString(), { serverSelectionTimeoutMS: 2000 });
      const models = createPrototypeStoreModels(scope);
      await models.PrototypeGatewayExecution.init();
      const repository = new GatewayExecutionRepository({
        model: models.PrototypeGatewayExecution,
        jobs: models.PrototypeJob,
      });
      const image = `registry.test/build@sha256:${'a'.repeat(64)}`;
      const baseCommand = {
        jobId: `job_${suffix}`,
        turnId: 'turn_1',
        commandId: 'command_1',
        tenantId: '__default__',
        userId: new mongoose.Types.ObjectId().toString(),
        modelId: 'selected/model',
        expectedRevision: 4,
        attemptId: 'attempt_1',
        executionId: 'execution_1',
        stage: 'build_qa',
        pipelineStep: 4,
        fenceToken: 5,
      };
      const { deterministicLeaseId } = await import('../src/stage-supervisor.js');
      const activeJob = (command) => ({
        jobId: command.jobId,
        tenantId: command.tenantId,
        userId: new mongoose.Types.ObjectId(command.userId),
        revision: command.expectedRevision,
        activeTurnId: command.turnId,
        activeCommandId: command.commandId,
        activeAttemptId: command.attemptId,
        activeExecutionId: command.executionId,
        activeStage: command.stage,
        fenceToken: command.fenceToken,
        activeLeaseId: deterministicLeaseId(command),
        status: 'running',
      });
      await scope.connection.db.collection('prototypejobs').insertOne(activeJob(baseCommand));
      const input = {
        executionId: baseCommand.commandId,
        profile: REACT_BUILD_PROFILE,
        format: 'react',
        source: 'export default function App() { return <h1>Fixture</h1>; }',
      };
      let posts = 0;
      const ambiguous = new GatewayPipelineClient({
        repository,
        image,
        directory,
        persist: async () => [],
        gateway: {
          request: async () => {
            posts++;
            throw new Error('GATEWAY_REQUEST_TIMEOUT');
          },
        },
      });
      await assert.rejects(ambiguous.run(input, { command: baseCommand }), /TIMEOUT/);
      await assert.rejects(ambiguous.run(input, { command: baseCommand }), /RECOVERY_REQUIRED/);
      assert.equal(posts, 1);
      const unknown = await models.PrototypeGatewayExecution.findOne({
        commandId: baseCommand.commandId,
      }).lean();
      assert.equal(unknown.phase, 'failed_or_unknown');
      assert.equal(unknown.sandboxId, null);
      assert.equal(unknown.stopEvidence, 'stop_unknown');
      // Lost session response must not authorize a second POST, even though create succeeded.
      const sessionCommand = {
        ...baseCommand,
        commandId: 'command_session_lost',
        executionId: 'execution_session_lost',
        expectedRevision: 5,
        fenceToken: 6,
      };
      await scope.connection.db
        .collection('prototypejobs')
        .updateOne({ jobId: sessionCommand.jobId }, { $set: activeJob(sessionCommand) });
      let creates = 0,
        sessions = 0;
      const sessionLost = new GatewayPipelineClient({
        repository,
        image,
        directory,
        persist: async () => [],
        gateway: {
          request: async (method, url) => {
            if (method === 'POST' && url === '/sandboxes') {
              creates++;
              return { id: 'own-session-lost' };
            }
            if (method === 'POST' && url.endsWith('/sessions')) {
              sessions++;
              throw new Error('GATEWAY_REQUEST_TIMEOUT');
            }
            return { state: 'ready' };
          },
        },
      });
      const sessionInput = { ...input, executionId: sessionCommand.commandId };
      await assert.rejects(sessionLost.run(sessionInput, { command: sessionCommand }), /TIMEOUT/);
      await assert.rejects(
        sessionLost.run(sessionInput, { command: sessionCommand }),
        /RECOVERY_REQUIRED/,
      );
      assert.equal(creates, 1);
      assert.equal(sessions, 1);
      const lost = await models.PrototypeGatewayExecution.findOne({
        commandId: sessionCommand.commandId,
      }).lean();
      assert.equal(lost.sandboxId, 'own-session-lost');
      assert.equal(lost.sessionId, null);
      assert.equal(lost.stopEvidence, 'stop_unknown');
      const command = {
        ...baseCommand,
        commandId: 'command_2',
        executionId: 'execution_2',
        expectedRevision: 5,
        fenceToken: 6,
      };
      await scope.connection.db
        .collection('prototypejobs')
        .updateOne({ jobId: command.jobId }, { $set: activeJob(command) });
      const input2 = { ...input, executionId: command.commandId };
      const zip = new JSZip();
      zip.file('src/app/App.tsx', input.source);
      const html = Buffer.from('<html><body>Fixture</body></html>');
      const sourcesZip = await zip.generateAsync({ type: 'nodebuffer' });
      const qaEvidence = Buffer.from(
        JSON.stringify({
          passed: true,
          checks: ['type-check', 'lint', 'build'],
          validation: 'build-only',
          browserQaPerformed: false,
          format: 'react',
          executionId: input2.executionId,
          profile: input2.profile,
          htmlDigest: digest(html),
          sourcesDigest: digest(sourcesZip),
          consoleErrors: [],
          networkRequests: [],
        }),
      );
      const manifest = {
        passed: true,
        managedWritersStopped: true,
        executionId: input2.executionId,
        inputDigest: pipelineIdentity(input2).inputDigest,
        digests: {
          html: digest(html),
          sourcesZip: digest(sourcesZip),
          qaEvidence: digest(qaEvidence),
        },
      };
      const requests = [];
      const gateway = {
        request: async (method, url, options = {}) => {
          requests.push([method, url]);
          if (method === 'POST' && url === '/sandboxes') return { id: 'own-sandbox' };
          if (method === 'POST' && url.endsWith('/sessions')) return { id: 'own-session' };
          if (url.includes('/logs?'))
            return new Promise((_, reject) => {
              if (options.signal.aborted) reject(new Error('aborted'));
              else
                options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                  once: true,
                });
            });
          if (url.includes('/files?')) {
            if (method === 'PUT') return null;
            const name = new URL(url, 'https://gateway.test').searchParams.get('path');
            return {
              '/run/output/result.json': Buffer.from(JSON.stringify(manifest)),
              '/run/output/preview.html': html,
              '/run/output/sources.zip': sourcesZip,
              '/run/output/qa.json': qaEvidence,
            }[name];
          }
          if (url.includes('/sessions/')) return { running: false, exit_code: 0 };
          return { state: 'ready' };
        },
      };
      const pipeline = new GatewayPipelineClient({
        repository,
        image,
        directory,
        gateway,
        persist: async () => {
          throw new Error('PROTOTYPE_S3_UNAVAILABLE');
        },
      });
      await assert.rejects(pipeline.run(input2, { command }), /S3_UNAVAILABLE/);
      assert.equal(requests.filter(([method]) => method === 'DELETE').length, 0);
      const failed = await models.PrototypeGatewayExecution.findOne({
        commandId: command.commandId,
      }).lean();
      assert.equal(failed.cleanup, 'publication_pending');
      assert.equal(failed.sandboxId, 'own-sandbox');
      await assert.rejects(pipeline.run(input2, { command }), /RECOVERY_REQUIRED/);
      const conflicted = { ...command, modelId: 'different/model' };
      await assert.rejects(
        repository.begin(conflicted, { inputDigest: failed.inputDigest, image, runId: 'second' }),
        /CONFLICT/,
      );
      await scope.connection.db
        .collection('prototypejobs')
        .updateOne({ jobId: command.jobId }, { $inc: { fenceToken: 1 } });
      await assert.rejects(
        repository.update(command, failed.ledgerRevision, { phase: 'verified' }),
        /STALE/,
      );
    } finally {
      await scope.connection.dropDatabase();
      await scope.disconnect();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
