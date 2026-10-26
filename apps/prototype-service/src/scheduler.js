import { createHash } from 'node:crypto';

const SAFE_NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const STAGE_POLICY = {
  generation: { serviceAccountName: 'prototype-generation', networkProfile: 'model-only' },
  dependency_preparation: {
    serviceAccountName: 'prototype-installer',
    networkProfile: 'dependency-only',
  },
  build_qa: { serviceAccountName: 'prototype-offline', networkProfile: 'offline' },
  publish: { serviceAccountName: 'prototype-transfer', networkProfile: 'storage-only' },
  transfer: { serviceAccountName: 'prototype-transfer', networkProfile: 'storage-only' },
};
const PIPELINE_STAGES = [
  'generation',
  'transfer',
  'dependency_preparation',
  'transfer',
  'build_qa',
  'publish',
];

function labelIdentity(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

export function buildExecutionInput(command, config) {
  const profile = config.stageProfiles?.[command.stage];
  const policy = STAGE_POLICY[command.stage];
  if (!profile || !policy)
    throw new SchedulerCapabilityError('Execution stage profile is unavailable');
  return {
    jobId: command.jobId,
    commandId: command.commandId,
    expectedRevision: command.expectedRevision,
    attemptId: command.attemptId,
    executionId: command.executionId,
    stage: command.stage,
    pipelineStep: command.pipelineStep,
    image: profile.image,
    serviceAccountName: policy.serviceAccountName,
    networkProfile: policy.networkProfile,
    activeDeadlineSeconds: profile.activeDeadlineSeconds,
    args: ['execute-stage', command.stage],
    env: [
      { name: 'PROTOTYPE_JOB_ID', value: command.jobId },
      { name: 'PROTOTYPE_TURN_ID', value: command.turnId },
      { name: 'PROTOTYPE_COMMAND_ID', value: command.commandId },
      { name: 'PROTOTYPE_EXPECTED_REVISION', value: String(command.expectedRevision) },
      { name: 'PROTOTYPE_EXECUTION_ID', value: command.executionId },
      { name: 'PROTOTYPE_ATTEMPT_ID', value: command.attemptId },
      { name: 'PROTOTYPE_FENCE_TOKEN', value: String(command.fenceToken) },
      { name: 'PROTOTYPE_PIPELINE_STEP', value: String(command.pipelineStep) },
      { name: 'PROTOTYPE_STAGE', value: command.stage },
    ],
    resources: profile.resources,
  };
}

export function assertStageInputIsolation(input) {
  const forbidden = /(?:secret|credential|authorization|signedUrl|transcript|source|modelToken)/i;
  if (
    input.stage === 'dependency_preparation' &&
    Object.keys(input).some((key) => forbidden.test(key))
  ) {
    throw new SchedulerCapabilityError('Installer input contains forbidden data');
  }
  if (
    ['generation', 'build_qa'].includes(input.stage) &&
    Object.keys(input).some((key) => /(?:s3|objectKey|storageCredential|signedUrl)/i.test(key))
  ) {
    throw new SchedulerCapabilityError('Untrusted stage received storage authority');
  }
}

export class SchedulerCapabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchedulerCapabilityError';
    this.code = 'PROTOTYPE_SANDBOX_UNAVAILABLE';
  }
}

export function executionJobName({ jobId, attemptId, executionId, stage, pipelineStep }) {
  const digest = createHash('sha256')
    .update(`${jobId}:${attemptId}:${executionId}:${stage}:${pipelineStep}`)
    .digest('hex')
    .slice(0, 20);
  return `prototype-${stage.replaceAll('_', '-')}-${digest}`.slice(0, 63);
}

export function assertSchedulerCapabilities(capabilities, config) {
  const missing = [];
  if (!capabilities?.runtimeClasses?.includes(config.runtimeClass)) missing.push('runtimeClass');
  if (capabilities?.networkPolicyEnforced !== true) missing.push('networkPolicy');
  if (capabilities?.admissionPolicyEnforced !== true) missing.push('admissionPolicy');
  if (capabilities?.pidLimitEnforced !== true) missing.push('pidLimit');
  if (missing.length > 0) {
    throw new SchedulerCapabilityError(
      `Required sandbox capabilities are unavailable: ${missing.join(', ')}`,
    );
  }
}

export function buildExecutionJob(input, config) {
  assertStageInputIsolation(input);
  if (!SAFE_NAME.test(config.namespace) || !SAFE_NAME.test(config.runtimeClass)) {
    throw new SchedulerCapabilityError('Scheduler namespace or RuntimeClass is invalid');
  }
  if (!config.trustedImageDigests.includes(input.image)) {
    throw new SchedulerCapabilityError('Execution image is not digest-pinned and allowlisted');
  }
  const stagePolicy = STAGE_POLICY[input.stage];
  if (!stagePolicy) {
    throw new SchedulerCapabilityError('Execution stage is unsupported');
  }
  if (
    !Number.isSafeInteger(input.pipelineStep) ||
    PIPELINE_STAGES[input.pipelineStep] !== input.stage
  ) {
    throw new SchedulerCapabilityError('Execution pipeline step does not match its stage');
  }
  if (
    input.serviceAccountName !== stagePolicy.serviceAccountName ||
    input.networkProfile !== stagePolicy.networkProfile
  )
    throw new SchedulerCapabilityError('Execution stage identity or network profile is invalid');
  const name = executionJobName(input);
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name,
      namespace: config.namespace,
      labels: {
        'app.kubernetes.io/name': 'prototype-sandbox',
        'prototype.chatrouter/stage': input.stage,
        'prototype.chatrouter/pipeline-step': String(input.pipelineStep),
        'prototype.chatrouter/execution': labelIdentity(input.executionId),
        'prototype.chatrouter/attempt': labelIdentity(input.attemptId),
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: input.activeDeadlineSeconds,
      ttlSecondsAfterFinished: config.ttlSecondsAfterFinished,
      template: {
        metadata: { labels: { 'prototype.chatrouter/network-profile': input.networkProfile } },
        spec: {
          runtimeClassName: config.runtimeClass,
          serviceAccountName: input.serviceAccountName,
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          terminationGracePeriodSeconds: config.terminationGracePeriodSeconds,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
          },
          containers: [
            {
              name: 'stage',
              image: input.image,
              imagePullPolicy: 'IfNotPresent',
              args: input.args,
              env: input.env,
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 10001,
                runAsGroup: 10001,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                privileged: false,
                capabilities: { drop: ['ALL'] },
                seccompProfile: { type: 'RuntimeDefault' },
              },
              resources: { requests: input.resources, limits: input.resources },
              volumeMounts: [
                { name: 'workspace', mountPath: '/workspace' },
                { name: 'tmp', mountPath: '/tmp' },
                ...(input.stage === 'build_qa'
                  ? [{ name: 'dependencies', mountPath: '/workspace/node_modules', readOnly: true }]
                  : []),
              ],
            },
          ],
          volumes: [
            { name: 'workspace', emptyDir: { sizeLimit: input.resources['ephemeral-storage'] } },
            { name: 'tmp', emptyDir: { sizeLimit: config.tmpSizeLimit } },
            ...(input.stage === 'build_qa'
              ? [
                  {
                    name: 'dependencies',
                    emptyDir: { sizeLimit: input.resources['ephemeral-storage'] },
                  },
                ]
              : []),
          ],
        },
      },
    },
  };
}

export class KubernetesScheduler {
  constructor({
    api,
    config,
    capabilities,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    assertSchedulerCapabilities(capabilities, config);
    this.api = api;
    this.config = config;
    this.now = now;
    this.sleep = sleep;
  }

  matchesExecution(job, desired) {
    const desiredContainer = desired.spec.template.spec.containers[0];
    const existingContainer = job?.spec?.template?.spec?.containers?.[0];
    return (
      job?.metadata?.name === desired.metadata.name &&
      job?.metadata?.namespace === desired.metadata.namespace &&
      job?.metadata?.labels?.['prototype.chatrouter/execution'] ===
        desired.metadata.labels['prototype.chatrouter/execution'] &&
      job?.metadata?.labels?.['prototype.chatrouter/attempt'] ===
        desired.metadata.labels['prototype.chatrouter/attempt'] &&
      job?.metadata?.labels?.['prototype.chatrouter/stage'] ===
        desired.metadata.labels['prototype.chatrouter/stage'] &&
      job?.metadata?.labels?.['prototype.chatrouter/pipeline-step'] ===
        desired.metadata.labels['prototype.chatrouter/pipeline-step'] &&
      job?.spec?.template?.spec?.runtimeClassName === desired.spec.template.spec.runtimeClassName &&
      job?.spec?.template?.spec?.serviceAccountName ===
        desired.spec.template.spec.serviceAccountName &&
      existingContainer?.image === desiredContainer.image &&
      JSON.stringify(existingContainer?.args) === JSON.stringify(desiredContainer.args)
    );
  }

  async createExecution(input) {
    const desired = buildExecutionJob(input, this.config);
    try {
      return await this.api.createJob(desired);
    } catch (error) {
      if (error?.statusCode !== 409 || typeof this.api.getJob !== 'function') throw error;
      const existing = await this.api.getJob(desired.metadata.name);
      if (!this.matchesExecution(existing, desired)) {
        throw new SchedulerCapabilityError(
          'Existing Kubernetes Job conflicts with execution identity',
        );
      }
      return existing;
    }
  }

  async waitForExecution(
    input,
    {
      signal,
      pollIntervalMs = 1_000,
      maxWaitMs = (input.activeDeadlineSeconds + this.config.terminationGracePeriodSeconds + 30) *
        1_000,
    } = {},
  ) {
    if (
      typeof this.api.getJob !== 'function' ||
      !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs < 1 ||
      !Number.isSafeInteger(maxWaitMs) ||
      maxWaitMs < 1
    ) {
      throw new SchedulerCapabilityError('Execution watch configuration is invalid');
    }
    const desired = buildExecutionJob(input, this.config);
    const deadline = this.now() + maxWaitMs;
    while (!signal?.aborted && this.now() < deadline) {
      const job = await this.api.getJob(desired.metadata.name);
      if (!this.matchesExecution(job, desired)) {
        throw new SchedulerCapabilityError(
          'Observed Kubernetes Job conflicts with execution identity',
        );
      }
      const conditions = Array.isArray(job?.status?.conditions) ? job.status.conditions : [];
      const complete = conditions.some(
        (condition) => condition.type === 'Complete' && condition.status === 'True',
      );
      const failed = conditions.some(
        (condition) => condition.type === 'Failed' && condition.status === 'True',
      );
      const writersStopped = Number(job?.status?.active ?? 0) === 0;
      if ((complete || failed) && writersStopped) {
        return {
          succeeded: complete && !failed,
          writersStopped: true,
          jobName: desired.metadata.name,
        };
      }
      await this.sleep(pollIntervalMs);
    }
    throw new SchedulerCapabilityError(
      signal?.aborted ? 'Execution watch was aborted' : 'Execution watch timed out',
    );
  }

  async cancelExecution(name, gracePeriodSeconds = 5) {
    if (!SAFE_NAME.test(name)) throw new SchedulerCapabilityError('Execution job name is invalid');
    return this.api.deleteJob({
      namespace: this.config.namespace,
      name,
      propagationPolicy: 'Foreground',
      gracePeriodSeconds,
    });
  }
}
