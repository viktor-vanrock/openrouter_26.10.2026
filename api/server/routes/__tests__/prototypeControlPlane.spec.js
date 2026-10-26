const express = require('express');
const request = require('supertest');
const { createPrototypeControlPlaneRouter } = require('../internal/prototypeControlPlane');

const body = {
  jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', expectedRevision: 2,
  attemptId: 'attempt_1', executionId: 'execution_1', stage: 'generation',
  fenceToken: 3, leaseId: 'lease_1',
};

const completionBody = {
  ...body,
  pipelineStep: 0,
  outputKind: 'checkpoint',
  outputDigest: `sha256:${'a'.repeat(64)}`,
  checkpoint: { revision: 1, digest: `sha256:${'b'.repeat(64)}` },
};

const waitingBody = {
  ...body,
  pipelineStep: 0,
  reason: 'clarification',
  prompt: 'Which audience should this prototype target?',
  checkpoint: { revision: 3, digest: `sha256:${'a'.repeat(64)}` },
};

const publicationBody = {
  ...body,
  stage: 'publish',
  pipelineStep: 5,
  target: 'review_ready',
  checkpoint: { revision: 3, digest: `sha256:${'a'.repeat(64)}` },
  templateDigest: `sha256:${'b'.repeat(64)}`,
  toolchainDigest: `sha256:${'c'.repeat(64)}`,
  artifacts: [
    { kind: 'checkpoint', objectKey: 'tenant/job/checkpoint', digest: `sha256:${'a'.repeat(64)}`, size: 10, contentType: 'application/zstd' },
    { kind: 'html', objectKey: 'tenant/job/preview', digest: `sha256:${'d'.repeat(64)}`, size: 20, contentType: 'text/html' },
    { kind: 'sources_zip', objectKey: 'tenant/job/sources', digest: `sha256:${'e'.repeat(64)}`, size: 30, contentType: 'application/zip' },
    { kind: 'qa_evidence', objectKey: 'tenant/job/qa', digest: `sha256:${'f'.repeat(64)}`, size: 40, contentType: 'application/json' },
  ],
};

const failureBody = {
  ...body,
  stage: 'build_qa',
  pipelineStep: 4,
  code: 'PROTOTYPE_BUILD_FAILED',
  message: 'Offline build failed.',
  retryable: true,
  diagnostics: ['src/app.tsx: type mismatch'],
};

function app(overrides = {}) {
  const deps = {
    authenticateService: jest.fn((req) => req.get('X-Prototype-Service') === 'trusted'),
    registerLease: jest.fn(async (input) => ({
      jobId: input.jobId, revision: input.expectedRevision,
      fenceToken: input.fenceToken, activeLeaseId: input.leaseId,
    })),
    ...overrides,
  };
  const value = express();
  value.use(express.json());
  value.use('/internal/prototype-control/v2', createPrototypeControlPlaneRouter(deps));
  return { app: value, deps };
}

describe('prototype control plane lease endpoint', () => {
  it('registers only an authenticated full execution identity tuple', async () => {
    const harness = app();
    const response = await request(harness.app)
      .post('/internal/prototype-control/v2/leases')
      .set('X-Prototype-Service', 'trusted')
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ jobId: 'job_1', revision: 2, fenceToken: 3, leaseId: 'lease_1' });
    expect(harness.deps.registerLease).toHaveBeenCalledWith(body);
  });

  it('rejects browser identity, missing tuple fields, and stale CAS without details', async () => {
    const harness = app({
      registerLease: jest.fn(async () => {
        const error = new Error('private database detail');
        error.code = 'PROTOTYPE_STALE_REVISION';
        throw error;
      }),
    });
    expect((await request(harness.app).post('/internal/prototype-control/v2/leases').send(body)).status)
      .toBe(401);
    expect((await request(harness.app).post('/internal/prototype-control/v2/leases')
      .set('X-Prototype-Service', 'trusted').send({ ...body, attemptId: undefined })).status).toBe(422);
    const stale = await request(harness.app).post('/internal/prototype-control/v2/leases')
      .set('X-Prototype-Service', 'trusted').send(body);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: { code: 'PROTOTYPE_STALE_REVISION' } });
    expect(JSON.stringify(stale.body)).not.toContain('private');
  });
});

describe('prototype control plane stage completion endpoint', () => {
  it('publishes only an authenticated digest-bound completion event', async () => {
    const completeStage = jest.fn(async () => undefined);
    const harness = app({ completeStage });
    const response = await request(harness.app)
      .post('/internal/prototype-control/v2/stage-completions')
      .set('X-Prototype-Service', 'trusted')
      .send(completionBody);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      eventId: expect.stringMatching(/^event_[a-f0-9]{24}$/),
      accepted: true,
    });
    expect(completeStage).toHaveBeenCalledTimes(1);
    expect(completeStage).toHaveBeenCalledWith({
      schemaVersion: 2,
      eventId: response.body.eventId,
      jobId: 'job_1',
      turnId: 'turn_1',
      commandId: 'command_1',
      expectedRevision: 2,
      attemptId: 'attempt_1',
      executionId: 'execution_1',
      stage: 'generation',
      pipelineStep: 0,
      fenceToken: 3,
      leaseId: 'lease_1',
      payload: {
        type: 'stage_completed',
        outputKind: 'checkpoint',
        outputDigest: `sha256:${'a'.repeat(64)}`,
        artifacts: [],
        checkpoint: { revision: 1, digest: `sha256:${'b'.repeat(64)}` },
      },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(JSON.stringify(completeStage.mock.calls[0][0])).not.toMatch(
      /credential|secret|signedUrl|objectKey|workspacePath/i,
    );
  });

  it('uses a deterministic event id for an idempotent execution step', async () => {
    const completeStage = jest.fn(async () => undefined);
    const harness = app({ completeStage });
    const first = await request(harness.app)
      .post('/internal/prototype-control/v2/stage-completions')
      .set('X-Prototype-Service', 'trusted')
      .send(completionBody);
    const second = await request(harness.app)
      .post('/internal/prototype-control/v2/stage-completions')
      .set('X-Prototype-Service', 'trusted')
      .send(completionBody);

    expect(second.body.eventId).toBe(first.body.eventId);
  });

  it('rejects unauthorized, incomplete, malformed, and extra sensitive fields', async () => {
    const completeStage = jest.fn(async () => undefined);
    const harness = app({ completeStage });
    const post = (value) => request(harness.app)
      .post('/internal/prototype-control/v2/stage-completions')
      .set('X-Prototype-Service', 'trusted')
      .send(value);

    expect((await request(harness.app)
      .post('/internal/prototype-control/v2/stage-completions')
      .send(completionBody)).status).toBe(401);
    expect((await post({ ...completionBody, pipelineStep: undefined })).status).toBe(422);
    expect((await post({ ...completionBody, outputDigest: 'not-a-digest' })).status).toBe(422);
    expect((await post({ ...completionBody, stage: 'build_qa' })).status).toBe(422);
    expect((await post({ ...completionBody, outputKind: 'verified_snapshot' })).status).toBe(422);
    expect((await post({ ...completionBody, checkpoint: undefined })).status).toBe(422);
    expect((await post({
      ...completionBody,
      stage: 'transfer',
      pipelineStep: 1,
      outputKind: 'checkpoint_restored',
    })).status).toBe(422);
    expect((await post({ ...completionBody, objectKey: 'private/key' })).status).toBe(422);
    expect((await post({ ...completionBody, checkpoint: { ...completionBody.checkpoint, path: '/tmp/x' } })).status)
      .toBe(422);
    expect(completeStage).not.toHaveBeenCalled();
  });

  it('sanitizes stale and internal publication errors', async () => {
    const staleError = new Error('private database detail');
    staleError.code = 'PROTOTYPE_STALE_REVISION';
    const staleHarness = app({ completeStage: jest.fn(async () => { throw staleError; }) });
    const stale = await request(staleHarness.app)
      .post('/internal/prototype-control/v2/stage-completions')
      .set('X-Prototype-Service', 'trusted')
      .send(completionBody);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: { code: 'PROTOTYPE_STALE_REVISION' } });
    expect(JSON.stringify(stale.body)).not.toContain('private');

    const failedHarness = app({
      completeStage: jest.fn(async () => { throw new Error('broker credentials leaked'); }),
    });
    const failed = await request(failedHarness.app)
      .post('/internal/prototype-control/v2/stage-completions')
      .set('X-Prototype-Service', 'trusted')
      .send(completionBody);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
    expect(JSON.stringify(failed.body)).not.toContain('credentials');
  });

  it('fails closed when no completion publisher is configured', async () => {
    const harness = app();
    const response = await request(harness.app)
      .post('/internal/prototype-control/v2/stage-completions')
      .set('X-Prototype-Service', 'trusted')
      .send(completionBody);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
  });
});

describe('prototype control plane publication endpoint', () => {
  it('accepts an authenticated immutable publication manifest', async () => {
    const completePublication = jest.fn(async () => ({ eventId: 'event_publication_1' }));
    const harness = app({ completePublication });
    const response = await request(harness.app)
      .post('/internal/prototype-control/v2/publications')
      .set('X-Prototype-Service', 'trusted')
      .send(publicationBody);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ eventId: 'event_publication_1', accepted: true });
    expect(completePublication).toHaveBeenCalledWith(publicationBody);
  });

  it('rejects incomplete, conflicting, or path-like publication metadata', async () => {
    const completePublication = jest.fn();
    const harness = app({ completePublication });
    const post = (value) => request(harness.app)
      .post('/internal/prototype-control/v2/publications')
      .set('X-Prototype-Service', 'trusted')
      .send(value);
    expect((await post({ ...publicationBody, pipelineStep: 4 })).status).toBe(422);
    expect((await post({ ...publicationBody, stage: 'build_qa' })).status).toBe(422);
    expect((await post({ ...publicationBody, objectKey: 'forbidden' })).status).toBe(422);
    expect((await post({ ...publicationBody, artifacts: publicationBody.artifacts.slice(1) })).status).toBe(422);
    expect((await post({
      ...publicationBody,
      artifacts: publicationBody.artifacts.map((artifact, index) =>
        index === 0 ? { ...artifact, digest: `sha256:${'9'.repeat(64)}` } : artifact),
    })).status).toBe(422);
    expect((await post({
      ...publicationBody,
      artifacts: publicationBody.artifacts.map((artifact, index) =>
        index === 1 ? { ...artifact, objectKey: '../private' } : artifact),
    })).status).toBe(422);
    expect(completePublication).not.toHaveBeenCalled();
  });

  it('requires service identity and sanitizes publication failures', async () => {
    const error = new Error('private object key');
    error.code = 'PROTOTYPE_STALE_REVISION';
    const harness = app({ completePublication: jest.fn(async () => { throw error; }) });
    expect((await request(harness.app)
      .post('/internal/prototype-control/v2/publications')
      .send(publicationBody)).status).toBe(401);
    const stale = await request(harness.app)
      .post('/internal/prototype-control/v2/publications')
      .set('X-Prototype-Service', 'trusted')
      .send(publicationBody);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: { code: 'PROTOTYPE_STALE_REVISION' } });
    expect(JSON.stringify(stale.body)).not.toContain('private');
  });
});

describe('prototype control plane waiting endpoint', () => {
  it('publishes a deterministic safe waiting event from a generation result', async () => {
    const completeWaiting = jest.fn(async () => undefined);
    const harness = app({ completeWaiting });
    const first = await request(harness.app)
      .post('/internal/prototype-control/v2/waiting')
      .set('X-Prototype-Service', 'trusted')
      .send(waitingBody);
    const second = await request(harness.app)
      .post('/internal/prototype-control/v2/waiting')
      .set('X-Prototype-Service', 'trusted')
      .send(waitingBody);
    expect(first.status).toBe(202);
    expect(second.body.eventId).toBe(first.body.eventId);
    expect(completeWaiting).toHaveBeenCalledWith(expect.objectContaining({
      eventId: first.body.eventId,
      pipelineStep: 0,
      payload: {
        type: 'waiting',
        reason: 'clarification',
        prompt: 'Which audience should this prototype target?',
        checkpoint: waitingBody.checkpoint,
      },
    }));
  });

  it('rejects unauthorized, invalid, extra, and sensitive waiting output', async () => {
    const completeWaiting = jest.fn();
    const harness = app({ completeWaiting });
    const post = (value) => request(harness.app)
      .post('/internal/prototype-control/v2/waiting')
      .set('X-Prototype-Service', 'trusted')
      .send(value);
    expect((await request(harness.app).post('/internal/prototype-control/v2/waiting')
      .send(waitingBody)).status).toBe(401);
    expect((await post({ ...waitingBody, reason: 'other' })).status).toBe(422);
    expect((await post({ ...waitingBody, stage: 'build_qa' })).status).toBe(422);
    expect((await post({ ...waitingBody, pipelineStep: 1 })).status).toBe(422);
    expect((await post({ ...waitingBody, objectKey: 'private/key' })).status).toBe(422);
    expect((await post({ ...waitingBody, prompt: 'Read /private/workspace/secret' })).status).toBe(422);
    expect(completeWaiting).not.toHaveBeenCalled();
  });
});

describe('prototype control plane stage failure endpoint', () => {
  it('publishes an authenticated deterministic safe failure event', async () => {
    const completeStage = jest.fn(async () => undefined);
    const harness = app({ completeStage });
    const first = await request(harness.app)
      .post('/internal/prototype-control/v2/stage-failures')
      .set('X-Prototype-Service', 'trusted')
      .send(failureBody);
    const second = await request(harness.app)
      .post('/internal/prototype-control/v2/stage-failures')
      .set('X-Prototype-Service', 'trusted')
      .send(failureBody);
    expect(first.status).toBe(202);
    expect(second.body.eventId).toBe(first.body.eventId);
    expect(completeStage).toHaveBeenCalledWith(expect.objectContaining({
      eventId: first.body.eventId,
      pipelineStep: 4,
      payload: {
        type: 'failed', code: 'PROTOTYPE_BUILD_FAILED', message: 'Offline build failed.',
        retryable: true, diagnostics: ['src/app.tsx: type mismatch'],
      },
    }));
  });

  it('rejects unsafe or invalid retryable failure shapes', async () => {
    const completeStage = jest.fn();
    const harness = app({ completeStage });
    const post = (value) => request(harness.app)
      .post('/internal/prototype-control/v2/stage-failures')
      .set('X-Prototype-Service', 'trusted')
      .send(value);
    expect((await post({ ...failureBody, pipelineStep: 3 })).status).toBe(422);
    expect((await post({ ...failureBody, code: 'PRIVATE_ERROR' })).status).toBe(422);
    expect((await post({ ...failureBody, workspacePath: '/private/workspace' })).status).toBe(422);
    expect((await post({ ...failureBody, diagnostics: [] })).status).toBe(422);
    expect((await post({ ...failureBody, diagnostics: ['/private/workspace/src/app.tsx'] })).status).toBe(422);
    expect((await post({ ...failureBody, stage: 'generation', pipelineStep: 0 })).status).toBe(422);
    expect(completeStage).not.toHaveBeenCalled();
  });
});
