import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildStageCompletion,
  buildStageWaiting,
  createControlPlaneStageSupervisor,
  createKubernetesStageSupervisor,
  deterministicLeaseId,
  OrchestratedStageSupervisor,
  readVerifiedPublicationResult,
  readVerifiedStageFailure,
  readVerifiedStageResult,
  TrustedStageSupervisor,
} from '../src/stage-supervisor.js';

const digest = (value) => `sha256:${value.repeat(64)}`;
const command = {
  schemaVersion: 2,
  commandId: 'command_1',
  jobId: 'job_1',
  turnId: 'turn_1',
  expectedRevision: 2,
  attemptId: 'attempt_1',
  executionId: 'execution_1',
  stage: 'generation',
  pipelineStep: 0,
  fenceToken: 3,
  sourceDigest: null,
};
const identity = {
  jobId: 'job_1',
  turnId: 'turn_1',
  commandId: 'command_1',
  expectedRevision: 2,
  attemptId: 'attempt_1',
  executionId: 'execution_1',
  stage: 'generation',
  fenceToken: 3,
  pipelineStep: 0,
};

test('turns a verified generation result into a minimal digest-bound completion', () => {
  const completion = buildStageCompletion({
    command,
    leaseId: 'lease_1',
    checkpointRevision: 7,
    result: {
      ...identity,
      type: 'code_done',
      checkpointDigest: digest('a'),
      checkpointSize: 123,
      summary: 'This model text must not cross the control boundary.',
    },
  });
  assert.deepEqual(completion, {
    jobId: 'job_1',
    turnId: 'turn_1',
    commandId: 'command_1',
    expectedRevision: 2,
    attemptId: 'attempt_1',
    executionId: 'execution_1',
    stage: 'generation',
    fenceToken: 3,
    leaseId: 'lease_1',
    pipelineStep: 0,
    outputKind: 'checkpoint',
    outputDigest: digest('a'),
    checkpoint: { revision: 7, digest: digest('a') },
  });
  assert.doesNotMatch(JSON.stringify(completion), /model text|summary|path|objectKey/i);
});

test('turns a verified generation waiting result into a bounded control-plane request', () => {
  const leaseId = deterministicLeaseId(command);
  const waiting = buildStageWaiting({
    command,
    leaseId,
    checkpointRevision: 3,
    result: {
      ...identity,
      type: 'waiting',
      reason: 'clarification',
      prompt: 'Which audience should this prototype target?',
      checkpointDigest: digest('a'),
    },
  });
  assert.deepEqual(waiting, {
    jobId: 'job_1',
    turnId: 'turn_1',
    commandId: 'command_1',
    expectedRevision: 2,
    attemptId: 'attempt_1',
    executionId: 'execution_1',
    stage: 'generation',
    fenceToken: 3,
    leaseId,
    pipelineStep: 0,
    reason: 'clarification',
    prompt: 'Which audience should this prototype target?',
    checkpoint: { revision: 3, digest: digest('a') },
  });
});

test('maps both transfer positions without trusting a new digest from the result', () => {
  for (const [pipelineStep, outputKind] of [
    [1, 'checkpoint_restored'],
    [3, 'dependencies_restored'],
  ]) {
    const sourceDigest = digest(String(pipelineStep));
    const completion = buildStageCompletion({
      command: { ...command, stage: 'transfer', pipelineStep, sourceDigest },
      leaseId: `lease_${pipelineStep}`,
      result: {
        ...identity,
        stage: 'transfer',
        pipelineStep,
        kind: 'restored_workspace',
        restoredDigest: sourceDigest,
      },
    });
    assert.equal(completion.outputKind, outputKind);
    assert.equal(completion.outputDigest, sourceDigest);
  }
});

test('maps dependency and build outputs to their verified aggregate digests', () => {
  const cases = [
    [2, 'dependency_preparation', 'dependency_bundle', 'bundleDigest', 'dependency_bundle'],
    [4, 'build_qa', 'verified_snapshot', 'snapshotDigest', 'verified_snapshot'],
  ];
  for (const [pipelineStep, stage, kind, digestField, outputKind] of cases) {
    const completion = buildStageCompletion({
      command: { ...command, stage, pipelineStep, sourceDigest: digest('f') },
      leaseId: `lease_${pipelineStep}`,
      result: {
        ...identity,
        stage,
        pipelineStep,
        kind,
        [digestField]: digest(String(pipelineStep)),
      },
    });
    assert.equal(completion.outputKind, outputKind);
    assert.equal(completion.outputDigest, digest(String(pipelineStep)));
  }
});

test('rejects waiting generation, stale identity, wrong transition, and digest substitution', () => {
  assert.throws(
    () =>
      buildStageCompletion({
        command,
        leaseId: 'lease_1',
        checkpointRevision: 1,
        result: { ...identity, type: 'waiting', checkpointDigest: digest('a') },
      }),
    /NOT_COMPLETABLE/,
  );
  assert.throws(
    () =>
      buildStageCompletion({
        command,
        leaseId: 'lease_1',
        checkpointRevision: 1,
        result: {
          ...identity,
          executionId: 'execution_stale',
          type: 'code_done',
          checkpointDigest: digest('a'),
        },
      }),
    /IDENTITY_INVALID/,
  );
  assert.throws(
    () =>
      buildStageCompletion({
        command: { ...command, pipelineStep: 2 },
        leaseId: 'lease_1',
        result: { ...identity, pipelineStep: 2, type: 'code_done', checkpointDigest: digest('a') },
      }),
    /TRANSITION_INVALID/,
  );
  assert.throws(
    () =>
      buildStageCompletion({
        command: { ...command, stage: 'transfer', pipelineStep: 1, sourceDigest: digest('a') },
        leaseId: 'lease_1',
        result: {
          ...identity,
          stage: 'transfer',
          pipelineStep: 1,
          kind: 'restored_workspace',
          restoredDigest: digest('b'),
        },
      }),
    /DIGEST_INVALID/,
  );
});

test('checks writer quiescence before reading or publishing completion', async () => {
  const order = [];
  const supervisor = new TrustedStageSupervisor({
    writersStopped: async () => {
      order.push('quiesced');
      return true;
    },
    readResult: async () => {
      order.push('read');
      return { ...identity, type: 'code_done', checkpointDigest: digest('a') };
    },
    completeStage: async () => order.push('publish'),
  });
  await supervisor.complete({ command, leaseId: 'lease_1', checkpointRevision: 1 });
  assert.deepEqual(order, ['quiesced', 'read', 'publish']);

  const blocked = [];
  const blockedSupervisor = new TrustedStageSupervisor({
    writersStopped: async () => false,
    readResult: async () => blocked.push('read'),
    completeStage: async () => blocked.push('publish'),
  });
  await assert.rejects(
    () => blockedSupervisor.complete({ command, leaseId: 'lease_1', checkpointRevision: 1 }),
    /WRITERS_NOT_QUIESCED/,
  );
  assert.deepEqual(blocked, []);
});

test('recomputes generation and dependency digests from bounded regular output files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-supervisor-'));
  try {
    const checkpoint = Buffer.from('checkpoint');
    const checkpointResult = {
      ...identity,
      type: 'code_done',
      checkpointDigest: digestBytes(checkpoint),
      checkpointSize: checkpoint.length,
    };
    await fs.writeFile(path.join(root, 'checkpoint.tar.zst'), checkpoint);
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(checkpointResult));
    assert.deepEqual(await readVerifiedStageResult(command, root), checkpointResult);

    const bundle = Buffer.from('dependency bundle');
    const dependencyCommand = {
      ...command,
      stage: 'dependency_preparation',
      pipelineStep: 2,
      sourceDigest: digest('f'),
    };
    const dependencyResult = {
      ...identity,
      stage: 'dependency_preparation',
      pipelineStep: 2,
      kind: 'dependency_bundle',
      size: bundle.length,
      bundleDigest: digestBytes(bundle),
    };
    await fs.writeFile(path.join(root, 'dependencies.zip'), bundle);
    await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(dependencyResult));
    assert.deepEqual(await readVerifiedStageResult(dependencyCommand, root), dependencyResult);

    await fs.writeFile(path.join(root, 'dependencies.zip'), 'tampered');
    await assert.rejects(() => readVerifiedStageResult(dependencyCommand, root), /DIGEST_INVALID/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('recomputes every build artifact and its aggregate snapshot digest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-supervisor-'));
  try {
    const html = Buffer.from('<main>verified</main>');
    const sourcesZip = Buffer.from('sources');
    const qaEvidence = Buffer.from('{"passed":true}');
    const digests = {
      html: digestBytes(html),
      sourcesZip: digestBytes(sourcesZip),
      qaEvidence: digestBytes(qaEvidence),
    };
    const result = {
      ...identity,
      stage: 'build_qa',
      pipelineStep: 4,
      kind: 'verified_snapshot',
      digests,
      snapshotDigest: digestBytes(Buffer.from(JSON.stringify(digests))),
    };
    await Promise.all([
      fs.writeFile(path.join(root, 'preview.html'), html),
      fs.writeFile(path.join(root, 'sources.zip'), sourcesZip),
      fs.writeFile(path.join(root, 'qa.json'), qaEvidence),
      fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result)),
    ]);
    const buildCommand = {
      ...command,
      stage: 'build_qa',
      pipelineStep: 4,
      sourceDigest: digest('f'),
    };
    assert.deepEqual(await readVerifiedStageResult(buildCommand, root), result);

    await fs.writeFile(path.join(root, 'preview.html'), '<main>changed</main>');
    await assert.rejects(() => readVerifiedStageResult(buildCommand, root), /DIGEST_INVALID/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rejects symlinked and oversized supervisor outputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-supervisor-'));
  const outside = path.join(root, 'outside.json');
  try {
    await fs.writeFile(outside, '{}');
    await fs.symlink(outside, path.join(root, 'result.json'));
    await assert.rejects(() => readVerifiedStageResult(command, root), /ELOOP|OUTPUT_INVALID/);
    await fs.rm(path.join(root, 'result.json'));
    await fs.writeFile(path.join(root, 'result.json'), '{}'.repeat(100));
    await assert.rejects(
      () => readVerifiedStageResult(command, root, { resultBytes: 8 }),
      /OUTPUT_INVALID/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('orchestrated supervisor registers a deterministic lease and completes after Job quiescence', async () => {
  const calls = [];
  const supervisor = new OrchestratedStageSupervisor({
    registerLease: async (input) => calls.push(['lease', input]),
    waitForCompletion: async () => ({
      succeeded: true,
      writersStopped: true,
      outputRoot: '/projected/output',
    }),
    readResult: async (value, outputRoot) => {
      calls.push(['read', value, outputRoot]);
      return { ...identity, type: 'code_done', checkpointDigest: digest('a') };
    },
    completeStage: async (input) => calls.push(['complete', input]),
  });
  const leaseId = deterministicLeaseId(command);
  assert.equal(await supervisor.prepare(command), leaseId);
  const completion = await supervisor.complete(command);
  assert.equal(calls[0][0], 'lease');
  assert.deepEqual(calls[0][1], {
    jobId: 'job_1',
    turnId: 'turn_1',
    commandId: 'command_1',
    expectedRevision: 2,
    attemptId: 'attempt_1',
    executionId: 'execution_1',
    stage: 'generation',
    fenceToken: 3,
    leaseId,
  });
  assert.equal(calls[1][2], '/projected/output');
  assert.equal(completion.checkpoint.revision, 3);
  assert.equal(completion.leaseId, leaseId);
  assert.deepEqual(calls[2], ['complete', completion]);
});

test('orchestrated supervisor reports a verified generation wait instead of rejecting it', async () => {
  const calls = [];
  const supervisor = new OrchestratedStageSupervisor({
    registerLease: async () => {},
    waitForCompletion: async () => ({
      succeeded: true,
      writersStopped: true,
      outputRoot: '/projected/output',
    }),
    readResult: async () => ({
      ...identity,
      type: 'waiting',
      reason: 'plan_approval',
      prompt: 'Approve the implementation plan?',
      checkpointDigest: digest('a'),
    }),
    completeStage: async () => {
      throw new Error('stage completion should not run');
    },
    completeWaiting: async (input) => calls.push(input),
  });
  const result = await supervisor.complete(command);
  assert.equal(result.reason, 'plan_approval');
  assert.equal(result.checkpoint.revision, 3);
  assert.deepEqual(calls, [result]);
});

test('orchestrated supervisor fails closed before reading output from a failed or live Job', async () => {
  for (const outcome of [
    { succeeded: false, writersStopped: true, outputRoot: '/projected/output' },
    { succeeded: true, writersStopped: false, outputRoot: '/projected/output' },
  ]) {
    const calls = [];
    const supervisor = new OrchestratedStageSupervisor({
      registerLease: async () => {},
      waitForCompletion: async () => outcome,
      readResult: async () => calls.push('read'),
      completeStage: async () => calls.push('complete'),
    });
    await assert.rejects(
      () => supervisor.complete(command),
      /EXECUTION_FAILED|WRITERS_NOT_QUIESCED/,
    );
    assert.deepEqual(calls, []);
  }
});

test('composes the supervisor with the bounded control-plane client seam', async () => {
  const calls = [];
  const supervisor = createControlPlaneStageSupervisor({
    client: {
      registerLease: async (input) => calls.push(['lease', input]),
      completeStage: async (input) => calls.push(['complete', input]),
      completeWaiting: async (input) => calls.push(['waiting', input]),
      completePublication: async (input) => calls.push(['publication', input]),
      failStage: async (input) => calls.push(['failure', input]),
    },
    waitForCompletion: async () => ({
      succeeded: true,
      writersStopped: true,
      outputRoot: '/projected/output',
    }),
    readResult: async () => ({ ...identity, type: 'code_done', checkpointDigest: digest('a') }),
  });
  await supervisor.prepare(command);
  await supervisor.complete(command);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['lease', 'complete'],
  );
});

test('joins exact Kubernetes Job observation to the projected output provider', async () => {
  const calls = [];
  const supervisor = createKubernetesStageSupervisor({
    client: {
      registerLease: async () => calls.push('lease'),
      completeStage: async () => calls.push('complete'),
      completeWaiting: async () => calls.push('waiting'),
      completePublication: async () => calls.push('publication'),
      failStage: async () => calls.push('failure'),
    },
    scheduler: {
      waitForExecution: async (input, options) => {
        calls.push(['wait', input, options.signal]);
        return { succeeded: true, writersStopped: true, jobName: 'prototype-generation-abc' };
      },
    },
    buildJobInput: (value) => ({ executionId: value.executionId, activeDeadlineSeconds: 30 }),
    outputRootFor: async (value, outcome) => {
      calls.push(['output', value.commandId, outcome.jobName]);
      return '/projected/output/execution_1';
    },
    signal: AbortSignal.timeout(1_000),
    readResult: async (_value, root) => {
      calls.push(['read', root]);
      return { ...identity, type: 'code_done', checkpointDigest: digest('a') };
    },
  });
  await supervisor.prepare(command);
  await supervisor.complete(command);
  assert.equal(calls[0], 'lease');
  assert.equal(calls[1][0], 'wait');
  assert.deepEqual(calls[1][1], { executionId: 'execution_1', activeDeadlineSeconds: 30 });
  assert.deepEqual(calls[2], ['output', 'command_1', 'prototype-generation-abc']);
  assert.deepEqual(calls[3], ['read', '/projected/output/execution_1']);
  assert.equal(calls[4], 'complete');
});

test('verifies a publish manifest and sends only bounded metadata to the control plane', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-publication-'));
  const publishCommand = {
    ...command,
    tenantId: 'tenant_1',
    stage: 'publish',
    pipelineStep: 5,
    expectedRevision: 7,
  };
  const publishIdentity = {
    ...identity,
    stage: 'publish',
    pipelineStep: 5,
    expectedRevision: 7,
  };
  const templateDigest = digest('b');
  const toolchainDigest = digest('c');
  const checkpointDigest = digest('a');
  const references = [
    ['checkpoint', checkpointDigest, 'application/zstd'],
    ['html', digest('d'), 'text/html'],
    ['sources_zip', digest('e'), 'application/zip'],
    ['qa_evidence', digest('f'), 'application/json'],
  ].map(([kind, value, contentType], index) => ({
    kind,
    digest: value,
    contentType,
    size: index + 10,
    objectKey: `tenant/job/${kind}`,
    tenantId: 'tenant_1',
    jobId: 'job_1',
    executionId: 'execution_1',
    revision: 7,
    templateDigest,
    toolchainDigest,
  }));
  try {
    await fs.writeFile(
      path.join(root, 'publication.json'),
      JSON.stringify({
        ...publishIdentity,
        target: 'review_ready',
        checkpoint: { revision: 3, digest: checkpointDigest },
        templateDigest,
        toolchainDigest,
        references,
      }),
    );
    const value = await readVerifiedPublicationResult(publishCommand, root);
    assert.equal(value.target, 'review_ready');
    assert.equal(value.leaseId, deterministicLeaseId(publishCommand));
    assert.equal(value.artifacts.length, 4);
    assert.equal(value.artifacts[0].objectKey, 'tenant/job/checkpoint');
    assert.equal(JSON.stringify(value).includes('sha256'), true);

    const completePublication = [];
    const supervisor = new OrchestratedStageSupervisor({
      registerLease: async () => {},
      waitForCompletion: async () => ({ succeeded: true, writersStopped: true, outputRoot: root }),
      completeStage: async () => {
        throw new Error('stage completion should not run');
      },
      completePublication: async (input) => completePublication.push(input),
    });
    await supervisor.complete(publishCommand);
    assert.deepEqual(completePublication, [value]);

    references[1].objectKey = '../private';
    await fs.writeFile(
      path.join(root, 'publication.json'),
      JSON.stringify({
        ...publishIdentity,
        target: 'review_ready',
        checkpoint: { revision: 3, digest: checkpointDigest },
        templateDigest,
        toolchainDigest,
        references,
      }),
    );
    await assert.rejects(
      () => readVerifiedPublicationResult(publishCommand, root),
      /PUBLICATION_RESULT_INVALID/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reads a failed build result and publishes a safe retryable failure event', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-failure-'));
  const buildCommand = {
    ...command,
    stage: 'build_qa',
    pipelineStep: 4,
    sourceDigest: digest('d'),
    dependencyDigest: digest('e'),
  };
  const failureFile = {
    ...identity,
    stage: 'build_qa',
    pipelineStep: 4,
    type: 'failed',
    code: 'PROTOTYPE_BUILD_FAILED',
    message: 'Offline build failed.',
    retryable: true,
    diagnostics: ['type-check: src/app.tsx mismatch'],
  };
  try {
    await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify(failureFile));
    const failure = await readVerifiedStageFailure(buildCommand, root);
    assert.equal(failure.leaseId, deterministicLeaseId(buildCommand));
    assert.deepEqual(failure.diagnostics, ['type-check: src/app.tsx mismatch']);
    const calls = [];
    const supervisor = new OrchestratedStageSupervisor({
      registerLease: async () => {},
      waitForCompletion: async () => ({ succeeded: false, writersStopped: true, outputRoot: root }),
      completeStage: async () => calls.push('complete'),
      failStage: async (input) => calls.push(input),
    });
    assert.deepEqual(await supervisor.complete(buildCommand), failure);
    assert.deepEqual(calls, [failure]);

    failureFile.retryable = true;
    failureFile.stage = 'generation';
    failureFile.pipelineStep = 0;
    await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify(failureFile));
    await assert.rejects(() => readVerifiedStageFailure(command, root), /STAGE_FAILURE_INVALID/);
    failureFile.stage = 'build_qa';
    failureFile.pipelineStep = 4;
    failureFile.diagnostics = ['/private/workspace/src/app.tsx failed'];
    await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify(failureFile));
    await assert.rejects(
      () => readVerifiedStageFailure(buildCommand, root),
      /STAGE_FAILURE_INVALID/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
