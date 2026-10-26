import fs from 'node:fs/promises';
import { SandboxGatewayClient } from './sandbox-gateway-client.js';
import { GatewayPipelineClient } from './gateway-pipeline-client.js';
import { REACT_BUILD_PROFILE, REACT_FSD_BUILD_PROFILE } from './pipeline-contract.js';

export async function createExecutionBackend({
  config,
  directory,
  log,
  persist,
  repository,
  releaseLockUrl = new URL('../deploy/gateway/release-lock.json', import.meta.url),
  gateway,
  profile = REACT_BUILD_PROFILE,
}) {
  if (config.executionBackend !== 'sandbox-gateway') throw new Error('GATEWAY_BACKEND_REQUIRED');
  const lock = JSON.parse(await fs.readFile(releaseLockUrl, 'utf8'));
  if (![REACT_BUILD_PROFILE, REACT_FSD_BUILD_PROFILE].includes(profile))
    throw new Error('GATEWAY_BUILD_PROFILE_INVALID');
  const build = profile === REACT_FSD_BUILD_PROFILE ? lock.buildFsd : lock.build;
  if (
    lock.schemaVersion !== 1 ||
    lock.gatewayApi !== 1 ||
    build?.profile !== profile ||
    !/^.+@sha256:[a-f0-9]{64}$/.test(build.image ?? '') ||
    build.runner !== '/opt/prototype/runner/build.mjs' ||
    ![build.cpus, build.memoryMb, build.storageMb, build.timeoutMs].every(Number.isSafeInteger) ||
    build.cpus < 1 ||
    build.cpus > 4 ||
    build.memoryMb < 256 ||
    build.memoryMb > 8192 ||
    build.storageMb < 256 ||
    build.storageMb > 8192 ||
    build.timeoutMs < 180000 ||
    build.timeoutMs > 600000
  ) {
    throw new Error('GATEWAY_RELEASE_LOCK_INVALID');
  }
  if (
    ![
      build.templateDigest,
      build.toolchainDigest,
      ...(profile === REACT_FSD_BUILD_PROFILE ? [build.rulesDigest] : []),
    ].every((value) => /^sha256:[a-f0-9]{64}$/.test(value ?? ''))
  ) {
    throw new Error('GATEWAY_RELEASE_LOCK_INVALID');
  }
  const client = gateway ?? (await SandboxGatewayClient.fromConfig(config.gateway));
  await client.probe();
  return {
    gateway: client,
    release: lock,
    profile,
    pipeline: new GatewayPipelineClient({
      gateway: client,
      image: build.image,
      directory,
      log,
      persist,
      repository,
      limits: build,
    }),
  };
}
