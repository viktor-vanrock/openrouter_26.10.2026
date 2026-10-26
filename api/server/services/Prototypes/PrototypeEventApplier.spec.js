const { PrototypeEventApplier } = require('./PrototypeEventApplier');

const base = {
  eventId: 'event_1', jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1',
  expectedRevision: 2, attemptId: 'attempt_1', executionId: 'execution_1',
  stage: 'generation', fenceToken: 3, leaseId: 'lease_1',
};

function harness() {
  const deps = { updateExecution: jest.fn(), finishExecution: jest.fn() };
  return { applier: new PrototypeEventApplier(deps), deps };
}

describe('PrototypeEventApplier', () => {
  it('applies progress, checkpoint, and known usage without advancing command identity', async () => {
    const { applier, deps } = harness();
    const session = {};
    await applier.apply({ ...base, payload: { type: 'progress', phase: 'Generating' } }, session);
    await applier.apply({
      ...base,
      payload: {
        type: 'checkpoint_ready',
        checkpoint: { revision: 3, digest: `sha256:${'a'.repeat(64)}` },
        artifact: {},
      },
    }, session);
    await applier.apply({
      ...base,
      payload: { type: 'usage', costUsd: 0.25, inputTokens: 1, outputTokens: 1 },
    }, session);
    expect(deps.updateExecution.mock.calls).toEqual([
      [expect.objectContaining({ jobId: 'job_1', phase: 'Generating', session })],
      [expect.objectContaining({ checkpointRevision: 3, checkpointDigest: `sha256:${'a'.repeat(64)}` })],
      [expect.objectContaining({ actualCostDelta: 0.25 })],
    ]);
  });

  it('routes stage completion through the atomic pipeline adapter', async () => {
    const deps = { updateExecution: jest.fn(), finishExecution: jest.fn(), advanceStage: jest.fn() };
    const applier = new PrototypeEventApplier(deps);
    const event = { ...base, pipelineStep: 0, payload: {
      type: 'stage_completed', outputKind: 'checkpoint', outputDigest: `sha256:${'a'.repeat(64)}`,
    } };
    const session = {};
    await applier.apply(event, session);
    expect(deps.advanceStage).toHaveBeenCalledWith({ event, session });
  });

  it('persists waiting and safe failure terminal states', async () => {
    const { applier, deps } = harness();
    await applier.apply({
      ...base,
      payload: {
        type: 'waiting', reason: 'clarification', prompt: 'Which theme?',
        checkpoint: { revision: 4, digest: `sha256:${'b'.repeat(64)}` },
      },
    });
    await applier.apply({
      ...base,
      payload: {
        type: 'failed', code: 'PROTOTYPE_EXECUTION_FAILED', message: 'Execution failed', retryable: false,
      },
    });
    expect(deps.finishExecution).toHaveBeenNthCalledWith(1, expect.objectContaining({
      to: 'waiting_for_input', waitingReason: 'clarification', latestPromptMessageId: 'event_1',
      checkpointRevision: 4,
    }));
    expect(deps.finishExecution).toHaveBeenNthCalledWith(2, expect.objectContaining({
      to: 'failed', failure: { code: 'PROTOTYPE_EXECUTION_FAILED', message: 'Execution failed' },
    }));
  });

  it('routes retryable build failures through bounded durable repair before terminal failure', async () => {
    const repairStage = jest.fn(async () => ({ repaired: true }));
    const finishExecution = jest.fn();
    const applier = new PrototypeEventApplier({
      updateExecution: jest.fn(), finishExecution, repairStage,
    });
    const event = {
      ...base,
      stage: 'build_qa',
      pipelineStep: 4,
      payload: {
        type: 'failed', code: 'PROTOTYPE_BUILD_FAILED', message: 'Build failed',
        retryable: true, diagnostics: ['src/app.tsx: type mismatch'],
      },
    };
    const session = {};
    await expect(applier.apply(event, session)).resolves.toEqual({ repaired: true });
    expect(repairStage).toHaveBeenCalledWith({ event, session });
    expect(finishExecution).not.toHaveBeenCalled();

    repairStage.mockResolvedValueOnce({ repaired: false });
    await applier.apply(event, session);
    expect(finishExecution).toHaveBeenCalledWith(expect.objectContaining({
      to: 'failed', failure: { code: 'PROTOTYPE_BUILD_FAILED', message: 'Build failed' },
    }));
  });

  it('fails closed to waiting_for_funds when usage cost is unknown', async () => {
    const { applier, deps } = harness();
    await applier.apply({ ...base, payload: { type: 'usage', costUsd: null } });
    expect(deps.finishExecution).toHaveBeenCalledWith(expect.objectContaining({
      to: 'waiting_for_funds', jobId: 'job_1', leaseId: 'lease_1',
    }));
  });

  it('does not invoke source repair for browser infrastructure failure even if marked retryable', async () => {
    const repairStage = jest.fn();
    const finishExecution = jest.fn();
    const applier = new PrototypeEventApplier({ updateExecution: jest.fn(), finishExecution, repairStage });
    await applier.apply({ ...base, stage: 'build_qa', pipelineStep: 4, payload: {
      type: 'failed', code: 'PROTOTYPE_QA_INFRASTRUCTURE_FAILED', message: 'Browser unavailable',
      retryable: true, diagnostics: ['Chromium launch unavailable'],
    } }, {});
    expect(repairStage).not.toHaveBeenCalled();
    expect(finishExecution).toHaveBeenCalledWith(expect.objectContaining({ to: 'failed',
      failure: { code: 'PROTOTYPE_QA_INFRASTRUCTURE_FAILED', message: 'Browser unavailable' } }));
  });

  it('routes credential/funds pauses through the same full-tuple finish CAS', async () => {
    const { applier, deps } = harness();
    const event = {
      ...base,
      payload: {
        type: 'credentials_required',
        checkpoint: { revision: 5, digest: `sha256:${'c'.repeat(64)}` },
      },
    };
    await applier.pause({ event, status: 'waiting_for_credentials', checkpointRevision: 5 }, {});
    expect(deps.finishExecution).toHaveBeenCalledWith(expect.objectContaining({
      to: 'waiting_for_credentials', checkpointRevision: 5,
      checkpointDigest: `sha256:${'c'.repeat(64)}`,
    }));
  });

  it('does not accept publication without the artifact transaction adapter', async () => {
    const { applier } = harness();
    await expect(applier.apply({ ...base, payload: { type: 'review_ready' } }))
      .rejects.toThrow('artifact transaction adapter');
  });

  it('verifies artifact metadata before the full-tuple publication CAS', async () => {
    const digest = (letter) => `sha256:${letter.repeat(64)}`;
    const artifacts = [
      { artifactId: 'checkpoint', kind: 'checkpoint', jobId: 'job_1', executionId: 'execution_1', revision: 2, digest: digest('f'), templateDigest: digest('d'), toolchainDigest: digest('e') },
      { artifactId: 'html', kind: 'html', jobId: 'job_1', executionId: 'execution_1', revision: 2, digest: digest('a'), templateDigest: digest('d'), toolchainDigest: digest('e') },
      { artifactId: 'zip', kind: 'sources_zip', jobId: 'job_1', executionId: 'execution_1', revision: 2, digest: digest('b'), templateDigest: digest('d'), toolchainDigest: digest('e') },
      { artifactId: 'qa', kind: 'qa_evidence', jobId: 'job_1', executionId: 'execution_1', revision: 2, digest: digest('c'), templateDigest: digest('d'), toolchainDigest: digest('e') },
    ];
    const deps = { updateExecution: jest.fn(), finishExecution: jest.fn(), verifyPublication: jest.fn(async () => artifacts), acceptPublication: jest.fn() };
    const applier = new PrototypeEventApplier(deps);
    await applier.apply({
      ...base,
      stage: 'publish',
      payload: {
        type: 'review_ready', checkpoint: { revision: 2, digest: digest('f') },
        artifacts: artifacts.map(({ artifactId, kind, digest: value, executionId, revision, templateDigest, toolchainDigest }) => ({
          artifactId, kind, digest: value, executionId, revision, templateDigest, toolchainDigest,
        })),
      },
    }, {});
    expect(deps.verifyPublication).toHaveBeenCalled();
    expect(deps.acceptPublication).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job_1', executionId: 'execution_1', fenceToken: 3, leaseId: 'lease_1',
      previewArtifactId: 'html', qaArtifactId: 'qa', to: 'review',
    }));
  });

  it('rejects stale or mismatched publication metadata before CAS', async () => {
    const deps = { updateExecution: jest.fn(), finishExecution: jest.fn(), verifyPublication: jest.fn(async () => [
      { kind: 'html', jobId: 'job_1', executionId: 'stale', revision: 2, digest: 'sha256:x' },
    ]), acceptPublication: jest.fn() };
    const applier = new PrototypeEventApplier(deps);
    await expect(applier.apply({ ...base, payload: { type: 'completed', checkpoint: { revision: 2, digest: 'sha256:x' }, artifacts: [] } })).rejects.toThrow('METADATA_MISMATCH');
    expect(deps.acceptPublication).not.toHaveBeenCalled();
  });
});
