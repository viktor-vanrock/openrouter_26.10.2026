import {
  adaptPrototypeCommandV1,
  parsePrototypeCommandV2,
  parsePrototypeWorkerEventV2,
  prototypeGenerationBindingSchema,
} from './contracts.v2';

const budget = {
  currency: 'USD', maxCostUsd: 1, maxRequests: 8, maxInputTokens: 20_000, maxOutputTokens: 8_000,
} as const;
const command = {
  schemaVersion: 2, commandId: 'command_1', kind: 'execute_stage', jobId: 'job_1', turnId: 'turn_1',
  tenantId: 'tenant_1', userId: 'user_1', modelId: 'openai/gpt-5', expectedRevision: 3, attemptId: 'attempt_1',
  executionId: 'execution_1', stage: 'generation', fenceToken: 4, checkpoint: null, sourceDigest: null,
  budget, createdAt: '2026-09-24T10:00:00.000Z', deadlineAt: '2026-09-24T10:10:00.000Z',
};
const eventIdentity = {
  schemaVersion: 2, eventId: 'event_1', commandId: 'command_1', jobId: 'job_1', turnId: 'turn_1',
  expectedRevision: 3, attemptId: 'attempt_1', executionId: 'execution_1', stage: 'generation',
  fenceToken: 4, leaseId: 'lease_1', createdAt: '2026-09-24T10:01:00.000Z',
};

describe('prototype v2 contracts', () => {
  it('keeps generation pins additive and rejects mismatched profiles or extra authority', () => {
    const generation = { schemaVersion: 1, engineId: 'direct-react-v1', sourceProfile: 'react-source-v1',
      rulesDigest: `sha256:${'a'.repeat(64)}`, templateDigest: `sha256:${'b'.repeat(64)}`, toolchainDigest: `sha256:${'c'.repeat(64)}` };
    expect(parsePrototypeCommandV2({ ...command, generation }).generation).toEqual(generation);
    expect(() => prototypeGenerationBindingSchema.parse({ ...generation, sourceProfile: 'react-fsd-source-v1' })).toThrow();
    expect(() => prototypeGenerationBindingSchema.parse({ ...generation, providerKey: 'denied' })).toThrow();
  });
  it('binds a command to the full durable and ephemeral identity tuple', () => {
    expect(parsePrototypeCommandV2(command)).toEqual(command);
  });

  it.each([
    { ...command, attemptId: '' },
    { ...command, fenceToken: 0 },
    { ...command, deadlineAt: command.createdAt },
    { ...command, budget: { ...budget, maxRequests: 0 } },
    { ...command, stage: 'build_qa', sourceDigest: null, dependencyDigest: null },
    { ...command, credential: 'secret' },
  ])('rejects an incomplete or unsafe command', (value) => {
    expect(() => parsePrototypeCommandV2(value)).toThrow();
  });

  it('rejects sensitive event payload fields while allowing token counts', () => {
    expect(() => parsePrototypeWorkerEventV2({
      ...eventIdentity,
      payload: {
        type: 'usage', reservationId: 'reservation_1', requestCount: 1,
        inputTokens: 1, outputTokens: 2, costUsd: 0, final: true,
        apiToken: 'secret',
      },
    })).toThrow();
  });

  it.each([
    { type: 'credentials_required', checkpoint: null },
    { type: 'funds_required', checkpoint: null },
    {
      type: 'usage', reservationId: 'reservation_1', requestCount: 1,
      inputTokens: null, outputTokens: null, costUsd: null, final: false,
    },
  ])('accepts gateway/budget payload %j', (payload) => {
    expect(parsePrototypeWorkerEventV2({ ...eventIdentity, payload })).toMatchObject({ payload });
  });

  it('requires digest-bound artifact references before review', () => {
    const payload = {
      type: 'review_ready',
      checkpoint: { revision: 4, digest: `sha256:${'a'.repeat(64)}` },
      artifacts: [
        { artifactId: '64f000000000000000000000', kind: 'checkpoint', digest: `sha256:${'a'.repeat(64)}`, size: 40, contentType: 'application/zstd', executionId: 'execution_1', revision: 2, templateDigest: `sha256:${'d'.repeat(64)}`, toolchainDigest: `sha256:${'e'.repeat(64)}` },
        { artifactId: '64f000000000000000000001', kind: 'html', digest: `sha256:${'b'.repeat(64)}`, size: 10, contentType: 'text/html', executionId: 'execution_1', revision: 2, templateDigest: `sha256:${'d'.repeat(64)}`, toolchainDigest: `sha256:${'e'.repeat(64)}` },
        { artifactId: '64f000000000000000000002', kind: 'sources_zip', digest: `sha256:${'c'.repeat(64)}`, size: 20, contentType: 'application/zip', executionId: 'execution_1', revision: 2, templateDigest: `sha256:${'d'.repeat(64)}`, toolchainDigest: `sha256:${'e'.repeat(64)}` },
        { artifactId: '64f000000000000000000003', kind: 'qa_evidence', digest: `sha256:${'f'.repeat(64)}`, size: 30, contentType: 'application/json', executionId: 'execution_1', revision: 2, templateDigest: `sha256:${'d'.repeat(64)}`, toolchainDigest: `sha256:${'e'.repeat(64)}` },
      ],
    };
    expect(parsePrototypeWorkerEventV2({ ...eventIdentity, payload })).toMatchObject({ payload });
    expect(() => parsePrototypeWorkerEventV2({ ...eventIdentity, payload: { ...payload, artifacts: payload.artifacts.slice(0, 1) } })).toThrow();
  });

  it('requires a pipeline step on durable stage completion events', () => {
    const payload = {
      type: 'stage_completed', outputKind: 'dependency_bundle',
      outputDigest: `sha256:${'a'.repeat(64)}`, artifacts: [],
    };
    expect(parsePrototypeWorkerEventV2({ ...eventIdentity, pipelineStep: 2, stage: 'dependency_preparation', payload }))
      .toMatchObject({ pipelineStep: 2, payload });
    expect(() => parsePrototypeWorkerEventV2({ ...eventIdentity, stage: 'dependency_preparation', payload })).toThrow();
  });

  it('allows bounded repair metadata across its checkpoint-backed pipeline', () => {
    const repair = { ordinal: 1, diagnostics: ['Type-check failed in src/app.tsx'] };
    const value = {
      ...command,
      pipelineStep: 0,
      checkpoint: { revision: 3, digest: `sha256:${'a'.repeat(64)}` },
      sourceDigest: `sha256:${'a'.repeat(64)}`,
      repair,
    };
    expect(parsePrototypeCommandV2(value)).toMatchObject({ repair });
    expect(() => parsePrototypeCommandV2({ ...value, stage: 'build_qa' })).toThrow();
    expect(parsePrototypeCommandV2({
      ...value,
      commandId: 'command_2',
      executionId: 'execution_2',
      stage: 'transfer',
      pipelineStep: 1,
      sourceDigest: value.checkpoint.digest,
    })).toMatchObject({ repair, stage: 'transfer', pipelineStep: 1 });
    expect(parsePrototypeCommandV2({
      ...value,
      commandId: 'command_3',
      executionId: 'execution_3',
      stage: 'build_qa',
      pipelineStep: 4,
      sourceDigest: `sha256:${'b'.repeat(64)}`,
      dependencyDigest: `sha256:${'b'.repeat(64)}`,
    })).toMatchObject({ repair, stage: 'build_qa', pipelineStep: 4 });
    expect(() => parsePrototypeCommandV2({ ...value, repair: { ...repair, ordinal: 3 } })).toThrow();
    expect(() => parsePrototypeCommandV2({ ...value, repair: { ...repair, diagnostics: [] } })).toThrow();
  });

  it('accepts bounded safe diagnostics on a retryable build failure', () => {
    const payload = {
      type: 'failed', code: 'PROTOTYPE_BUILD_FAILED', message: 'Build failed', retryable: true,
      diagnostics: ['src/app.tsx: type mismatch'],
    };
    expect(parsePrototypeWorkerEventV2({
      ...eventIdentity, stage: 'build_qa', pipelineStep: 4, payload,
    })).toMatchObject({ payload });
    expect(() => parsePrototypeWorkerEventV2({
      ...eventIdentity,
      stage: 'build_qa',
      pipelineStep: 4,
      payload: { ...payload, diagnostics: Array.from({ length: 21 }, () => 'error') },
    })).toThrow();
  });

  it('adapts v1 only when trusted control-plane values are supplied', () => {
    const adapted = adaptPrototypeCommandV1({
      schemaVersion: 1, commandId: 'command_1', kind: 'start_turn', jobId: 'job_1', turnId: 'turn_1',
      tenantId: 'tenant_1', modelId: 'openai/gpt-5', expectedRevision: 3, executionId: 'execution_1',
      checkpointRevision: null, attachmentManifest: [], createdAt: command.createdAt,
    }, {
      attemptId: 'attempt_1', fenceToken: 4, stage: 'generation', checkpoint: null, userId: 'user_1',
      sourceDigest: null, budget, deadlineAt: command.deadlineAt,
    });
    expect(adapted).toMatchObject({ schemaVersion: 2, attemptId: 'attempt_1', fenceToken: 4 });
  });
});
