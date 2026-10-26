const { generateKeyPairSync } = require('crypto');
const { Readable } = require('stream');
const { PrototypeJobTokenService } = require('./PrototypeJobTokenService');
const { PrototypeModelProxy } = require('./PrototypeModelProxy');

const CANARY = 'sk-synthetic-prototype-canary-only';

describe('Prototype credential isolation', () => {
  it('keeps the plaintext user key exclusively at the fake upstream boundary', async () => {
    const now = 2_000_000_000_000;
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const job = {
      jobId: 'job_1',
      userId: 'user_1',
      tenantId: 'tenant_1',
      modelId: 'fixed/model',
      activeTurnId: 'turn_1',
      activeCommandId: 'command_1',
      activeAttemptId: 'attempt_1',
      revision: 4,
      activeExecutionId: 'execution_1',
      activeStage: 'generation',
      fenceToken: 2,
      checkpointRevision: 3,
      estimatedCost: null,
    };
    const lease = {
      jobId: 'job_1',
      userId: job.userId, tenantId: job.tenantId, modelId: job.modelId,
      turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
      executionId: 'execution_1',
      stage: 'generation', fenceToken: 2,
      revision: 4,
      leaseId: 'lease_1',
      leaseExpiresAt: new Date(now + 30_000),
    };
    const tokenService = new PrototypeJobTokenService({
      issuer: 'librechat-prototype-control',
      privateKey,
      publicKeys: [publicKey],
      now: () => now,
      activeLease: jest.fn(async () => lease),
    });
    const token = await tokenService.issue({
      ...job,
      turnId: job.activeTurnId,
      commandId: job.activeCommandId,
      attemptId: job.activeAttemptId,
      executionId: lease.executionId,
      stage: job.activeStage,
      fenceToken: job.fenceToken,
      leaseId: lease.leaseId,
      leaseExpiresAt: lease.leaseExpiresAt,
    });
    const upstreamCapture = [];
    const logs = [];
    const events = [];
    const proxy = new PrototypeModelProxy({
      verifyToken: (value) => tokenService.verify(value),
      getUserKeyValues: jest.fn(async () => ({ apiKey: CANARY })),
      baseUrl: 'https://synthetic-gateway.invalid/v1',
      publishControlEvent: jest.fn(async (event) => events.push(event)),
      requestUpstream: jest.fn(async (request) => {
        upstreamCapture.push(request);
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: Readable.from(['data: {"choices":[]}\n\n', 'data: [DONE]\n\n']),
        };
      }),
    });
    const workerCommand = {
      schemaVersion: 1,
      commandId: 'command_1',
      kind: 'start_turn',
      jobId: job.jobId,
      tenantId: job.tenantId,
      modelId: job.modelId,
      expectedRevision: job.revision,
      executionId: job.activeExecutionId,
      checkpointRevision: job.checkpointRevision,
      attachmentManifest: [],
    };
    const queuePayloads = [workerCommand, ...events];
    const mongoShapedDocuments = [job, { jobId: job.jobId, publicPayload: { status: 'running' } }];

    const response = await proxy.chatCompletions({
      token,
      body: { model: 'caller/override', messages: [{ role: 'user', content: 'synthetic prompt' }] },
      signal: new AbortController().signal,
    });
    let responseBody = '';
    for await (const chunk of response.body) responseBody += String(chunk);

    expect(upstreamCapture).toHaveLength(1);
    expect(upstreamCapture[0].headers.Authorization).toBe(`Bearer ${CANARY}`);
    expect(upstreamCapture[0].body.model).toBe('fixed/model');
    const claims = await tokenService.verify(token);
    for (const value of [
      claims,
      workerCommand,
      mongoShapedDocuments,
      queuePayloads,
      logs,
      responseBody,
    ]) {
      expect(JSON.stringify(value)).not.toContain(CANARY);
    }
  });
});
