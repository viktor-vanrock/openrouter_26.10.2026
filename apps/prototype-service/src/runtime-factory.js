import { RedisPrototypeCommandSourceV2, S3ArtifactStore } from '@librechat/prototype-worker';
import { createExecutionBackend } from './execution-backend.js';
import { GatewayExecutionRepository } from './gateway-execution-repository.js';
import { ReactStages } from './react-stages.js';
import { PrototypeOrchestratorRuntime } from './orchestrator-runtime.js';
import { createControlPlaneStageSupervisor } from './stage-supervisor.js';
import { RedisExecutionRegistry } from './execution-registry.js';
import { RedisConcurrencyQuota } from './quota.js';
import { RedisPrototypeEventPublisherV2 } from './event-publisher.js';
import { reactPrototypeInstructions } from './react-prototype.js';
import { digest } from './pipeline-contract.js';
import { PrototypeControlPlaneClient } from './control-plane-client.js';
import { DurableStageWorkspace } from './durable-stage-workspace.js';
import { errorLogFields } from './service-log.js';

export async function createGatewayControlPlaneClient(config, { log } = {}) {
  if (config.environment === 'production' && config.serviceAuthMode === 'bearer')
    return PrototypeControlPlaneClient.fromBearerConfig({
      baseUrl: config.controlPlaneUrl,
      token: config.serviceToken,
      log,
    });
  if (config.environment === 'production')
    return PrototypeControlPlaneClient.fromMtlsConfig({
      baseUrl: config.controlPlaneUrl,
      certPath: config.mtlsCertPath,
      keyPath: config.mtlsKeyPath,
      caPath: config.mtlsCaPath,
      log,
    });
  if (!config.testWorkerIdentity) throw new Error('PROTOTYPE_DEVELOPMENT_IDENTITY_REQUIRED');
  return new PrototypeControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    environment: config.environment,
    headers: async () => ({ 'X-Prototype-Worker': config.testWorkerIdentity }),
    log,
  });
}

/** Common dependency factory; environment-specific connections/auth are injected. */
export async function createGatewayRuntime({
  config,
  mongoose,
  models,
  methods,
  storage,
  redis,
  sourceRedis,
  directory,
  log,
  client,
}) {
  client ??= await createGatewayControlPlaneClient(config, { log });
  const repository = new GatewayExecutionRepository({
    model: models.PrototypeGatewayExecution,
    jobs: models.PrototypeJob,
  });
  const store = new S3ArtifactStore(storage, config.storageBucket);
  const backend = await createExecutionBackend({
    config,
    directory,
    log,
    repository,
    persist: async ({ snapshot, command }) => {
      const qa = JSON.parse(snapshot.qaEvidence);
      if (
        qa.templateDigest !== backend.release.build.templateDigest ||
        qa.toolchainDigest !== backend.release.build.toolchainDigest
      ) {
        throw new Error('GATEWAY_TOOLCHAIN_PIN_MISMATCH');
      }
      const refs = [];
      for (const [key, kind, contentType] of [
        ['html', 'html', 'text/html'],
        ['sourcesZip', 'sources_zip', 'application/zip'],
        ['qaEvidence', 'qa_evidence', 'application/json'],
      ]) {
        refs.push(
          await store.publish({
            owner: {
              tenantId: command.tenantId,
              jobId: command.jobId,
              executionId: command.executionId,
              revision: command.expectedRevision,
            },
            kind,
            bytes: snapshot[key],
            digest: snapshot.digests[key],
            contentType,
            templateDigest: qa.templateDigest,
            toolchainDigest: qa.toolchainDigest,
          }),
        );
      }
      return refs;
    },
  });
  const stages = new ReactStages({
    mongoose,
    models,
    methods,
    storage,
    storageBucket: config.storageBucket,
    pipeline: backend.pipeline,
    directory,
    gatewayUrl: config.modelProviderUrl,
    log,
    workspace: new DurableStageWorkspace({
      mongoose,
      jobs: models.PrototypeJob,
      storage,
      bucket: config.storageBucket,
      directory,
      pins: backend.release.build,
    }),
    generationBinding: {
      schemaVersion: 1,
      engineId: 'direct-react-v1',
      sourceProfile: 'react-source-v1',
      rulesDigest: digest(await reactPrototypeInstructions()),
      templateDigest: backend.release.build.templateDigest,
      toolchainDigest: backend.release.build.toolchainDigest,
    },
  });
  const source = new RedisPrototypeCommandSourceV2(sourceRedis, config.commandConsumer, {
    group: 'prototype-gateway',
    blockMs: 500,
    claimIdleMs: 30_000,
  });
  const supervisor = createControlPlaneStageSupervisor({
    client,
    waitForCompletion: (command) => stages.execute(command),
  });
  // The stages own Gateway creation through the durable ledger; no scheduler privilege is needed.
  const runtime = new PrototypeOrchestratorRuntime({
    source,
    supervisor,
    events: new RedisPrototypeEventPublisherV2(redis),
    registry: new RedisExecutionRegistry(redis),
    quota: new RedisConcurrencyQuota(redis, config.concurrencyLimits),
    executionMode: 'supervised',
    buildJobInput: (command) => command,
    log,
    onError: (error) =>
      log('service.error', errorLogFields(error, 'PROTOTYPE_SERVICE_UNAVAILABLE')),
  });
  return { runtime, stages, backend, repository };
}
