import { loadPrototypeConfig } from './config.js';
import { createOrchestratorLifecycle } from './orchestrator-lifecycle.js';
import { createDependencyGatewayLifecycle } from './dependency-gateway-lifecycle.js';
import { createRoleServer } from './server.js';
import { serviceLogger } from './local-log.js';
import { errorLogFields } from './service-log.js';

async function defaultLifecycle(config, env) {
  if (config.role === 'orchestrator')
    return config.executionBackend === 'sandbox-gateway'
      ? (await import('./gateway-orchestrator-lifecycle.js')).createGatewayOrchestratorLifecycle({
          env,
        })
      : createOrchestratorLifecycle();
  if (config.role === 'dependency-gateway') return createDependencyGatewayLifecycle();
  return { isReady: async () => false };
}

export async function runRole(expectedRole, { env = process.env, lifecycle } = {}) {
  const config = loadPrototypeConfig(env, expectedRole);
  const log = serviceLogger(config.workspaceDirectory, { environment: env.NODE_ENV });
  const service = createRoleServer({
    config,
    lifecycle: lifecycle ?? (await defaultLifecycle(config, env)),
  });
  const shutdown = async (signal) => {
    log('service.shutdown', { reason: signal });
    try {
      await service.stop(signal);
    } catch (error) {
      log('service.shutdown_failed', errorLogFields(error, 'PROTOTYPE_SHUTDOWN_FAILED'));
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await service.start();
  } catch (error) {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    throw error;
  }
  return service;
}
