import assert from 'node:assert/strict';
import test from 'node:test';
import { createOrchestratorLifecycle } from '../src/orchestrator-lifecycle.js';

test('orchestrator becomes ready only after Redis and scheduler capability checks', async () => {
  let rejectRead;
  const redis = {
    status: 'ready',
    ping: async () => 'PONG',
    xgroup: async () => 'OK',
    xautoclaim: async () => ['0-0', []],
    xreadgroup: async () =>
      new Promise((_, reject) => {
        rejectRead = reject;
      }),
    disconnect() {
      this.status = 'end';
      rejectRead?.(new Error('closed'));
    },
  };
  const lifecycle = createOrchestratorLifecycle({
    redisFactory: () => redis,
    apiFactory: () => ({
      readCapabilities: async () => ({
        runtimeClasses: ['gvisor'],
        networkPolicyEnforced: true,
        admissionPolicyEnforced: true,
        pidLimitEnforced: true,
      }),
      createJob: async () => {},
      deleteJob: async () => {},
    }),
    onError: () => {},
  });
  const controller = new AbortController();
  const image = `registry.test/prototype@sha256:${'a'.repeat(64)}`;
  await lifecycle.start({
    signal: controller.signal,
    config: {
      redisUrl: 'redis://redis.test',
      schedulerNamespace: 'prototype-sandbox',
      runtimeClass: 'gvisor',
      stageProfiles: {
        generation: {
          image,
          activeDeadlineSeconds: 60,
          resources: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' },
        },
      },
      trustedImageDigests: [image],
      schedulerTtlSeconds: 600,
      terminationGracePeriodSeconds: 10,
      tmpSizeLimit: '256Mi',
      commandConsumer: 'service-a',
      concurrencyLimits: { global: 20, tenant: 5, user: 2 },
    },
  });
  assert.equal(await lifecycle.isReady(), true);
  controller.abort('test');
  await lifecycle.stop();
  assert.equal(await lifecycle.isReady(), false);
});

test('orchestrator lifecycle wires the control-plane supervisor before reporting ready', async () => {
  const captured = [];
  const redis = {
    status: 'ready',
    ping: async () => 'PONG',
    disconnect() {
      this.status = 'end';
    },
  };
  const runtime = {
    prepare: async () => {},
    start: async () => {},
    stop: async () => {},
    isReady: async () => true,
  };
  const client = {
    registerLease: async () => {},
    completeStage: async () => {},
    completeWaiting: async () => {},
    completePublication: async () => {},
    failStage: async () => {},
  };
  const lifecycle = createOrchestratorLifecycle({
    redisFactory: () => redis,
    apiFactory: () => ({
      readCapabilities: async () => ({
        runtimeClasses: ['gvisor'],
        networkPolicyEnforced: true,
        admissionPolicyEnforced: true,
        pidLimitEnforced: true,
      }),
    }),
    controlPlaneClientFactory: (config) => {
      captured.push(['client', config.controlPlaneUrl]);
      return client;
    },
    outputRootFor: ({ command, outcome }) => {
      captured.push(['output', command.executionId, outcome.jobName]);
      return `/projected/${command.executionId}`;
    },
    runtimeFactory: (dependencies) => {
      captured.push(['runtime', dependencies]);
      return runtime;
    },
    onError: () => {},
  });
  const image = `registry.test/prototype@sha256:${'a'.repeat(64)}`;
  await lifecycle.start({
    signal: AbortSignal.timeout(1_000),
    config: {
      environment: 'test',
      controlPlaneUrl: 'http://control.test',
      redisUrl: 'redis://redis.test',
      schedulerNamespace: 'prototype-sandbox',
      runtimeClass: 'gvisor',
      stageProfiles: {
        generation: {
          image,
          activeDeadlineSeconds: 60,
          resources: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' },
        },
      },
      trustedImageDigests: [image],
      schedulerTtlSeconds: 600,
      terminationGracePeriodSeconds: 10,
      tmpSizeLimit: '256Mi',
      commandConsumer: 'service-a',
      concurrencyLimits: { global: 20, tenant: 5, user: 2 },
    },
  });
  assert.deepEqual(captured[0], ['client', 'http://control.test']);
  assert.equal(captured[1][0], 'runtime');
  assert.equal(captured[1][1].supervisor.constructor.name, 'OrchestratedStageSupervisor');
  await lifecycle.stop();
});

test('production lifecycle refuses to run without a control plane', async () => {
  const lifecycle = createOrchestratorLifecycle({
    redisFactory: () => ({ status: 'ready', ping: async () => 'PONG', disconnect: () => {} }),
    apiFactory: () => ({
      readCapabilities: async () => ({
        runtimeClasses: ['gvisor'],
        networkPolicyEnforced: true,
        admissionPolicyEnforced: true,
        pidLimitEnforced: true,
      }),
    }),
    onError: () => {},
  });
  const image = `registry.test/prototype@sha256:${'a'.repeat(64)}`;
  await assert.rejects(
    () =>
      lifecycle.start({
        signal: AbortSignal.timeout(1_000),
        config: {
          environment: 'production',
          controlPlaneUrl: null,
          redisUrl: 'redis://redis.test',
          schedulerNamespace: 'prototype-sandbox',
          runtimeClass: 'gvisor',
          stageProfiles: {
            generation: {
              image,
              activeDeadlineSeconds: 60,
              resources: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' },
            },
          },
          trustedImageDigests: [image],
          schedulerTtlSeconds: 600,
          terminationGracePeriodSeconds: 10,
          tmpSizeLimit: '256Mi',
          commandConsumer: 'service-a',
          concurrencyLimits: { global: 20, tenant: 5, user: 2 },
        },
      }),
    /control plane is required/,
  );
  await lifecycle.stop();
});

test('configured control plane is not ready without projected stage output', async () => {
  const lifecycle = createOrchestratorLifecycle({
    redisFactory: () => ({ status: 'ready', ping: async () => 'PONG', disconnect: () => {} }),
    apiFactory: () => ({
      readCapabilities: async () => ({
        runtimeClasses: ['gvisor'],
        networkPolicyEnforced: true,
        admissionPolicyEnforced: true,
        pidLimitEnforced: true,
      }),
    }),
    controlPlaneClientFactory: () => ({
      registerLease: async () => {},
      completeStage: async () => {},
      completeWaiting: async () => {},
      completePublication: async () => {},
      failStage: async () => {},
    }),
    onError: () => {},
  });
  const image = `registry.test/prototype@sha256:${'a'.repeat(64)}`;
  await assert.rejects(
    () =>
      lifecycle.start({
        signal: AbortSignal.timeout(1_000),
        config: {
          environment: 'test',
          controlPlaneUrl: 'http://control.test',
          projectedOutputRoot: null,
          redisUrl: 'redis://redis.test',
          schedulerNamespace: 'prototype-sandbox',
          runtimeClass: 'gvisor',
          stageProfiles: {
            generation: {
              image,
              activeDeadlineSeconds: 60,
              resources: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' },
            },
          },
          trustedImageDigests: [image],
          schedulerTtlSeconds: 600,
          terminationGracePeriodSeconds: 10,
          tmpSizeLimit: '256Mi',
          commandConsumer: 'service-a',
          concurrencyLimits: { global: 20, tenant: 5, user: 2 },
        },
      }),
    /projected output provider/,
  );
  await lifecycle.stop();
});
