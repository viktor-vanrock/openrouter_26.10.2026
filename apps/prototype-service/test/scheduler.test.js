import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSchedulerCapabilities,
  buildExecutionInput,
  buildExecutionJob,
  executionJobName,
  KubernetesScheduler,
} from '../src/scheduler.js';

const image = `registry.internal/prototype@sha256:${'a'.repeat(64)}`;
const config = {
  namespace: 'prototype-sandbox',
  runtimeClass: 'gvisor',
  trustedImageDigests: [image],
  ttlSecondsAfterFinished: 600,
  terminationGracePeriodSeconds: 10,
  tmpSizeLimit: '256Mi',
};
const input = {
  jobId: 'job_1',
  attemptId: 'attempt_1',
  executionId: 'execution_1',
  pipelineStep: 0,
  stage: 'generation',
  image,
  serviceAccountName: 'prototype-generation',
  networkProfile: 'model-only',
  activeDeadlineSeconds: 900,
  args: ['generation'],
  env: [],
  resources: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '2Gi' },
};

test('job identity changes with attempt and stage', () => {
  assert.notEqual(executionJobName(input), executionJobName({ ...input, attemptId: 'attempt_2' }));
  assert.notEqual(executionJobName(input), executionJobName({ ...input, stage: 'build-qa' }));
  assert.notEqual(
    executionJobName(input),
    executionJobName({ ...input, executionId: 'execution_2' }),
  );
  assert.notEqual(
    executionJobName({ ...input, stage: 'transfer', pipelineStep: 1 }),
    executionJobName({ ...input, stage: 'transfer', pipelineStep: 3 }),
  );
});

test('maps a durable command to the configured stage profile without accepting caller policy', () => {
  const command = {
    jobId: 'job_1',
    turnId: 'turn_1',
    commandId: 'command_1',
    expectedRevision: 2,
    attemptId: 'attempt_1',
    executionId: 'execution_1',
    fenceToken: 4,
    pipelineStep: 4,
    stage: 'build_qa',
  };
  const result = buildExecutionInput(command, {
    stageProfiles: {
      build_qa: { image, activeDeadlineSeconds: 300, resources: input.resources },
    },
  });
  assert.equal(result.image, image);
  assert.equal(result.serviceAccountName, 'prototype-offline');
  assert.equal(result.networkProfile, 'offline');
  assert.deepEqual(result.args, ['execute-stage', 'build_qa']);
  assert.deepEqual(
    result.env.filter((entry) =>
      ['PROTOTYPE_COMMAND_ID', 'PROTOTYPE_EXPECTED_REVISION', 'PROTOTYPE_PIPELINE_STEP'].includes(
        entry.name,
      ),
    ),
    [
      { name: 'PROTOTYPE_COMMAND_ID', value: 'command_1' },
      { name: 'PROTOTYPE_EXPECTED_REVISION', value: '2' },
      { name: 'PROTOTYPE_PIPELINE_STEP', value: '4' },
    ],
  );
});

test('builds a bounded non-root gVisor job without credentials or host surfaces', () => {
  const job = buildExecutionJob(input, config);
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.template.spec.runtimeClassName, 'gvisor');
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(job.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(job.spec.template.spec.containers[0].securityContext.capabilities.drop, ['ALL']);
  assert.equal(
    job.spec.template.spec.volumes.some((volume) => volume.hostPath),
    false,
  );
});

test('offline build gets a read-only dependency mount and untrusted stages cannot receive storage credentials', () => {
  const build = buildExecutionJob(
    {
      ...input,
      stage: 'build_qa',
      pipelineStep: 4,
      serviceAccountName: 'prototype-offline',
      networkProfile: 'offline',
    },
    config,
  );
  assert.equal(
    build.spec.template.spec.containers[0].volumeMounts.find(
      (mount) => mount.name === 'dependencies',
    ).readOnly,
    true,
  );
  assert.throws(
    () => buildExecutionJob({ ...input, s3Secret: 'forbidden' }, config),
    /storage authority/,
  );
  assert.throws(
    () => buildExecutionJob({ ...input, stage: 'transfer', pipelineStep: 2 }, config),
    /pipeline step/,
  );
});

test('fails closed without every required cluster capability', () => {
  assert.throws(
    () =>
      assertSchedulerCapabilities(
        {
          runtimeClasses: ['gvisor'],
          networkPolicyEnforced: true,
          admissionPolicyEnforced: false,
          pidLimitEnforced: true,
        },
        config,
      ),
    /admissionPolicy/,
  );
});

test('uses injected Kubernetes API and foreground cancellation', async () => {
  const calls = [];
  const scheduler = new KubernetesScheduler({
    config,
    capabilities: {
      runtimeClasses: ['gvisor'],
      networkPolicyEnforced: true,
      admissionPolicyEnforced: true,
      pidLimitEnforced: true,
    },
    api: {
      createJob: async (job) => calls.push(['create', job]),
      deleteJob: async (request) => calls.push(['delete', request]),
    },
  });
  await scheduler.createExecution(input);
  await scheduler.cancelExecution(executionJobName(input));
  assert.equal(calls[0][0], 'create');
  assert.deepEqual(calls[1][1], {
    namespace: 'prototype-sandbox',
    name: executionJobName(input),
    propagationPolicy: 'Foreground',
    gracePeriodSeconds: 5,
  });
});

test('recovers an ambiguous create only when the existing Job has the exact identity', async () => {
  const conflict = Object.assign(new Error('already exists'), { statusCode: 409 });
  const desired = buildExecutionJob(input, config);
  const scheduler = new KubernetesScheduler({
    config,
    capabilities: {
      runtimeClasses: ['gvisor'],
      networkPolicyEnforced: true,
      admissionPolicyEnforced: true,
      pidLimitEnforced: true,
    },
    api: {
      createJob: async () => {
        throw conflict;
      },
      getJob: async () => desired,
    },
  });
  await assert.doesNotReject(() => scheduler.createExecution(input));
  scheduler.api.getJob = async () => ({
    ...desired,
    metadata: {
      ...desired.metadata,
      labels: {
        ...desired.metadata.labels,
        'prototype.chatrouter/execution': 'attacker',
      },
    },
  });
  await assert.rejects(() => scheduler.createExecution(input), /conflicts with execution identity/);
});

test('waits for the exact Job identity to become terminal and quiesced', async () => {
  const desired = buildExecutionJob(input, config);
  let now = 0;
  const jobs = [
    { ...desired, status: { active: 1, conditions: [] } },
    { ...desired, status: { active: 0, conditions: [{ type: 'Complete', status: 'True' }] } },
  ];
  const scheduler = new KubernetesScheduler({
    config,
    capabilities: {
      runtimeClasses: ['gvisor'],
      networkPolicyEnforced: true,
      admissionPolicyEnforced: true,
      pidLimitEnforced: true,
    },
    api: { getJob: async () => jobs.shift() },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  await assert.doesNotReject(async () => {
    assert.deepEqual(
      await scheduler.waitForExecution(input, { pollIntervalMs: 10, maxWaitMs: 100 }),
      {
        succeeded: true,
        writersStopped: true,
        jobName: desired.metadata.name,
      },
    );
  });
});

test('fails a Job watch on identity conflict, failure, timeout, or cancellation', async () => {
  const desired = buildExecutionJob(input, config);
  const capabilities = {
    runtimeClasses: ['gvisor'],
    networkPolicyEnforced: true,
    admissionPolicyEnforced: true,
    pidLimitEnforced: true,
  };
  const failedScheduler = new KubernetesScheduler({
    config,
    capabilities,
    api: {
      getJob: async () => ({
        ...desired,
        status: { active: 0, conditions: [{ type: 'Failed', status: 'True' }] },
      }),
    },
  });
  assert.deepEqual(await failedScheduler.waitForExecution(input), {
    succeeded: false,
    writersStopped: true,
    jobName: desired.metadata.name,
  });

  const conflictScheduler = new KubernetesScheduler({
    config,
    capabilities,
    api: {
      getJob: async () => ({
        ...desired,
        metadata: {
          ...desired.metadata,
          labels: {
            ...desired.metadata.labels,
            'prototype.chatrouter/pipeline-step': '3',
          },
        },
      }),
    },
  });
  await assert.rejects(
    () => conflictScheduler.waitForExecution(input),
    /conflicts with execution identity/,
  );

  let now = 0;
  const pendingScheduler = new KubernetesScheduler({
    config,
    capabilities,
    api: { getJob: async () => ({ ...desired, status: { active: 1 } }) },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  await assert.rejects(
    () => pendingScheduler.waitForExecution(input, { pollIntervalMs: 10, maxWaitMs: 20 }),
    /timed out/,
  );
  await assert.rejects(
    () => pendingScheduler.waitForExecution(input, { signal: AbortSignal.abort(), maxWaitMs: 20 }),
    /aborted/,
  );
});
