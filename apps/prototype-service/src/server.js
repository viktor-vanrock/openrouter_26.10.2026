import http from 'node:http';

function respond(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function createRoleServer({ config, lifecycle = {} }) {
  const state = { live: true, ready: false, shuttingDown: false };
  const controller = new AbortController();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return respond(res, state.live ? 200 : 503, {
        status: state.live ? 'ok' : 'stopping',
        role: config.role,
      });
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      try {
        await refreshReadiness();
      } catch {
        state.ready = false;
      }
      const ready = state.ready && !state.shuttingDown;
      return respond(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        role: config.role,
      });
    }
    try {
      if (await lifecycle.handleRequest?.(req, res, controller.signal)) return;
    } catch {
      return respond(res, 503, { error: { code: 'SERVICE_UNAVAILABLE' } });
    }
    return respond(res, 404, { error: { code: 'NOT_FOUND' } });
  });

  async function start() {
    try {
      await lifecycle.start?.({ config, signal: controller.signal });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      state.ready = lifecycle.isReady ? await lifecycle.isReady() : false;
      return server.address();
    } catch (error) {
      controller.abort('startup_failed');
      await lifecycle.stop?.();
      server.close();
      throw error;
    }
  }
  async function refreshReadiness() {
    if (state.shuttingDown) {
      state.ready = false;
      return false;
    }
    state.ready = lifecycle.isReady ? await lifecycle.isReady() : false;
    return state.ready;
  }
  async function stop(reason = 'shutdown') {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    state.ready = false;
    controller.abort(reason);
    await lifecycle.stop?.({ reason });
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Prototype graceful shutdown timed out')),
          config.shutdownTimeoutMs,
        );
        timer.unref();
      }),
    ]);
    state.live = false;
  }
  return { server, state, signal: controller.signal, start, stop, refreshReadiness };
}
