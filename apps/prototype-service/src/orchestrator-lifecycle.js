import Redis from 'ioredis';
import path from 'node:path';
import { RedisPrototypeCommandSourceV2 } from '@librechat/prototype-worker';
import { PrototypeControlPlaneClient } from './control-plane-client.js';
import { RedisPrototypeEventPublisherV2 } from './event-publisher.js';
import { RedisExecutionRegistry } from './execution-registry.js';
import { KubernetesHttpApi } from './kubernetes-api.js';
import { PrototypeOrchestratorRuntime } from './orchestrator-runtime.js';
import { RedisConcurrencyQuota } from './quota.js';
import { createKubernetesStageSupervisor } from './stage-supervisor.js';
import {
  assertSchedulerCapabilities,
  buildExecutionInput,
  KubernetesScheduler,
} from './scheduler.js';

function defaultOutputRootFor({ config, command }) {
  if (typeof config.projectedOutputRoot !== 'string' || config.projectedOutputRoot.length === 0) {
    throw new Error('Prototype projected output provider is not configured');
  }
  const root = path.resolve(config.projectedOutputRoot);
  const outputRoot = path.resolve(root, command.jobId, command.executionId);
  if (!outputRoot.startsWith(`${root}${path.sep}`)) {
    throw new Error('Prototype projected output path is invalid');
  }
  return outputRoot;
}

export function createOrchestratorLifecycle({
  redisFactory = (url) => new Redis(url, { enableReadyCheck: true, maxRetriesPerRequest: null }),
  apiFactory = (config) =>
    new KubernetesHttpApi({
      baseUrl: config.kubernetesApiUrl,
      tokenPath: config.kubernetesTokenPath,
      caPath: config.kubernetesCaPath,
      namespace: config.schedulerNamespace,
      capabilitiesConfigMap: config.schedulerCapabilitiesConfigMap,
    }),
  runtimeFactory = (dependencies) => new PrototypeOrchestratorRuntime(dependencies),
  controlPlaneClientFactory = (config) => {
    if (!config.controlPlaneUrl) return null;
    if (config.environment === 'production') {
      throw new Error('Prototype production mTLS control-plane transport is not configured');
    }
    if (typeof config.testWorkerIdentity !== 'string' || config.testWorkerIdentity.length === 0) {
      throw new Error('Prototype test worker identity is not configured');
    }
    return new PrototypeControlPlaneClient({
      baseUrl: config.controlPlaneUrl,
      environment: config.environment,
      headers: async () => ({ 'X-Prototype-Worker': config.testWorkerIdentity }),
    });
  },
  outputRootFor = defaultOutputRootFor,
  onError = (error) =>
    process.stderr.write(
      `Prototype orchestrator error: ${error instanceof Error ? error.message : 'unknown'}\n`,
    ),
} = {}) {
  let redis;
  let runtime;
  let loop;
  let ready = false;

  return {
    async start({ config, signal }) {
      if (
        !config.redisUrl ||
        !config.schedulerNamespace ||
        !config.runtimeClass ||
        !config.stageProfiles
      ) {
        throw new Error('Prototype orchestrator dependencies are not configured');
      }
      redis = redisFactory(config.redisUrl);
      await redis.ping();
      const api = apiFactory(config);
      const schedulerConfig = {
        namespace: config.schedulerNamespace,
        runtimeClass: config.runtimeClass,
        trustedImageDigests: config.trustedImageDigests,
        ttlSecondsAfterFinished: config.schedulerTtlSeconds,
        terminationGracePeriodSeconds: config.terminationGracePeriodSeconds,
        tmpSizeLimit: config.tmpSizeLimit,
      };
      const capabilities = await api.readCapabilities(config.runtimeClass);
      assertSchedulerCapabilities(capabilities, schedulerConfig);
      const source = new RedisPrototypeCommandSourceV2(redis, config.commandConsumer);
      const scheduler = new KubernetesScheduler({ api, config: schedulerConfig, capabilities });
      const buildJobInput = (command) => buildExecutionInput(command, config);
      let supervisor;
      if (config.controlPlaneUrl) {
        if (
          outputRootFor === defaultOutputRootFor &&
          (typeof config.projectedOutputRoot !== 'string' ||
            config.projectedOutputRoot.length === 0)
        ) {
          throw new Error('Prototype projected output provider is not configured');
        }
        const client = controlPlaneClientFactory(config);
        if (!client) throw new Error('Prototype control plane client is not configured');
        supervisor = createKubernetesStageSupervisor({
          client,
          scheduler,
          buildJobInput,
          outputRootFor: (command, outcome) => outputRootFor({ config, command, outcome }),
          signal,
        });
      } else if (config.environment === 'production') {
        throw new Error('Prototype control plane is required in production');
      }
      runtime = runtimeFactory({
        source,
        events: new RedisPrototypeEventPublisherV2(redis),
        registry: new RedisExecutionRegistry(redis),
        scheduler,
        ...(supervisor ? { supervisor } : {}),
        quota: new RedisConcurrencyQuota(redis, config.concurrencyLimits),
        buildJobInput,
        onError,
      });
      await runtime.prepare();
      ready = true;
      loop = runtime.start({ signal }).catch((error) => {
        ready = false;
        onError(error);
      });
    },
    async isReady() {
      if (!ready || !redis || redis.status !== 'ready') return false;
      return runtime?.isReady() ?? false;
    },
    async stop() {
      ready = false;
      await runtime?.stop();
      redis?.disconnect(false);
      await loop;
    },
  };
}
