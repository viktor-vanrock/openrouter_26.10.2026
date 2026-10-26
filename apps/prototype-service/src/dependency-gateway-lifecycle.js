import fs from 'node:fs/promises';
import {
  createForwardProxyTransport,
  DependencyGatewayRuntime,
} from './dependency-gateway-runtime.js';

export function createDependencyGatewayLifecycle({
  readFile = fs.readFile,
  lookup,
  transportFactory = createForwardProxyTransport,
} = {}) {
  let runtime;
  return {
    async start({ config }) {
      if (config.outboundProxyType !== 'http-forward' || !config.outboundProxyUrl)
        throw new Error('Dependency Gateway requires a configured HTTP forward proxy');
      if (config.outboundProxyDestinationGuard !== 'attested')
        throw new Error('Outbound proxy destination validation is not attested');
      const closure = JSON.parse(await readFile(config.dependencyClosurePath, 'utf8'));
      if (!Array.isArray(closure)) throw new Error('Dependency closure must be an array');
      runtime = new DependencyGatewayRuntime({
        allowlist: config.registryAllowlist,
        closure,
        lookup,
        gatewayBaseUrl: config.dependencyGatewayPublicUrl,
        maxRequests: config.dependencyMaxRequests,
        transport: transportFactory({
          proxyUrl: config.outboundProxyUrl,
          timeoutMs: config.dependencyRequestTimeoutMs,
          maxResponseBytes: config.dependencyMaxResponseBytes,
        }),
      });
      await runtime.start();
    },
    async isReady() {
      return runtime?.isReady() ?? false;
    },
    async handleRequest(req, res, signal) {
      return runtime?.handleRequest(req, res, signal) ?? false;
    },
    async stop() {
      await runtime?.stop();
    },
  };
}
