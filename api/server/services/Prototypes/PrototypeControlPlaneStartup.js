const crypto = require('node:crypto');
const { createPrototypeControlPlaneRouter } = require('../../routes/internal/prototypeControlPlane');
const { createDurablePublicationCompletion } = require('./PrototypeProductionWiring');
const { prototypeAvailability } = require('./PrototypeAvailability');

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function usesPrototypeBearerAuth(env = process.env) {
  return env.PROTOTYPE_SERVICE_AUTH_MODE === 'bearer';
}

function validatePrototypeServiceAuth(env) {
  const mode = env.PROTOTYPE_SERVICE_AUTH_MODE || 'mtls';
  if (!['mtls', 'bearer'].includes(mode) ||
      mode === 'bearer' && !/^[a-f0-9]{64}$/.test(env.PROTOTYPE_SERVICE_TOKEN || '')) {
    throw new Error('PROTOTYPE_SERVICE_AUTH_CONFIG_INVALID');
  }
}

function createPrototypeServiceAuthenticator({ env = process.env } = {}) {
  return async (req) => {
    if (env.NODE_ENV === 'production') {
      if (!usesPrototypeBearerAuth(env)) return require('./PrototypeControlPlaneTlsServer').isPrototypePrivateRequest(req);
      // TLS terminates at the existing trusted ingress. Never accept the development header.
      if (req.secure !== true || !/^[a-f0-9]{64}$/.test(env.PROTOTYPE_SERVICE_TOKEN || '')) return false;
      return safeEqual(req.get('Authorization'), `Bearer ${env.PROTOTYPE_SERVICE_TOKEN}`);
    }
    // The service may be started after the API. Refresh only the restricted identity profile.
    if (env.NODE_ENV === 'development') {
      try { require('./PrototypeDevProfile').applyPrototypeDevProfile({ env }); } catch { return false; }
    }
    const testIdentity = env.PROTOTYPE_TEST_WORKER_IDENTITY;
    return typeof testIdentity === 'string' && testIdentity.length > 0 &&
      safeEqual(req.get('X-Prototype-Worker'), testIdentity);
  };
}

function createPrototypeControlPlaneStartup({
  enabled,
  db,
  mongoose,
  env = process.env,
  authenticateService = createPrototypeServiceAuthenticator({ env }),
}) {
  if (!enabled) return null;
  if (!db || !mongoose || typeof authenticateService !== 'function') {
    throw new Error('Prototype control plane startup dependencies are incomplete');
  }

  let publishControlEvent = null;
  const publish = async (event) => {
    if (typeof publishControlEvent !== 'function') {
      throw new Error('Prototype control plane transport is unavailable');
    }
    return publishControlEvent(event);
  };
  const completePublication = createDurablePublicationCompletion({
    startSession: () => mongoose.startSession(),
    registerArtifacts: (input) => db.registerPrototypeArtifacts({ ...input,
      ...(env.PROTOTYPE_MONGO_URI ? { storageBucket: env.AWS_BUCKET_NAME } : {}),
    }),
    publishControlEvent: publish,
  });
  const router = createPrototypeControlPlaneRouter({
    authenticateService,
    registerLease: async (input) => {
      const job = await db.registerPrototypeLease(input);
      await publish({ schemaVersion: 2,
        eventId: `event_${crypto.createHash('sha256').update(`${input.executionId}:${input.leaseId}:progress`).digest('hex').slice(0, 24)}`,
        ...input, pipelineStep: job.pipelineStep ?? 0,
        payload: { type: 'progress', phase: input.stage }, createdAt: new Date().toISOString(),
      });
      return job;
    },
    completeStage: publish,
    completeWaiting: publish,
    completePublication,
    heartbeat: () => prototypeAvailability.heartbeat(),
  });

  let privateListener;
  let tokenRouter;
  return {
    router,
    setModelTokenRouter(router) { tokenRouter = router; },
    async startPrivateListener() {
      if (env.NODE_ENV !== 'production') return null;
      validatePrototypeServiceAuth(env);
      if (usesPrototypeBearerAuth(env)) return null;
      if (privateListener) return privateListener.server.address();
      const port = Number(env.PROTOTYPE_CONTROL_TLS_PORT ?? 3443);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PROTOTYPE_MTLS_CONFIG_INVALID');
      const { createPrototypeControlPlaneTlsServer } = require('./PrototypeControlPlaneTlsServer');
      const listener = await createPrototypeControlPlaneTlsServer({ router, tokenRouter, config: {
        certPath: env.PROTOTYPE_CONTROL_TLS_CERT_PATH, keyPath: env.PROTOTYPE_CONTROL_TLS_KEY_PATH,
        caPath: env.PROTOTYPE_CONTROL_TLS_CA_PATH, host: env.PROTOTYPE_CONTROL_TLS_HOST || '127.0.0.1', port,
        allowedServiceUris: (env.PROTOTYPE_CONTROL_TLS_SERVICE_URIS || '').split(',').map(value => value.trim()).filter(Boolean),
      } });
      try { const address = await listener.start(); privateListener = listener; return address; }
      catch (error) { await listener.stop(); throw error; }
    },
    async stopPrivateListener() {
      const listener = privateListener; privateListener = undefined; await listener?.stop();
    },
    bindTransport({ publishControlEvent: nextPublisher }) {
      if (typeof nextPublisher !== 'function') {
        throw new Error('Prototype control plane publisher is required');
      }
      publishControlEvent = nextPublisher;
    },
    unbindTransport() {
      publishControlEvent = null;
    },
  };
}

module.exports = {
  createPrototypeControlPlaneStartup,
  createPrototypeServiceAuthenticator,
  usesPrototypeBearerAuth,
  validatePrototypeServiceAuth,
};
