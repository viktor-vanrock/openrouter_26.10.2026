require('dotenv').config();
const { applyPrototypeDevProfile } = require('./services/Prototypes/PrototypeDevProfile');
try {
  if (applyPrototypeDevProfile())
    console.info('[Prototype] Optional local prototype service profile connected.');
} catch {
  console.warn(
    '[Prototype] Local prototype profile unavailable; continuing ordinary chat startup.',
  );
}
const telemetry = require('./telemetry');
const fs = require('fs');
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const cors = require('cors');
const axios = require('axios');
const express = require('express');
const mongoose = require('mongoose');
const passport = require('passport');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const { logger, runAsSystem } = require('@librechat/data-schemas');
const {
  isEnabled,
  apiNotFound,
  createMetrics,
  ErrorController,
  memoryDiagnostics,
  performStartupChecks,
  handleJsonParseError,
  GenerationJobManager,
  createStreamServices,
  initializeFileStorage,
  preAuthTenantMiddleware,
  setupGracefulShutdown,
  registerShutdownTask,
  updateInterfacePermissions,
} = require('@librechat/api');
const { connectDb, indexSync } = require('~/db');
const {
  updateAccessPermissions,
  sweepOrphanedPreviews,
  getRoleByName,
  seedDatabase,
} = require('~/models');
const initializeOAuthReconnectManager = require('./services/initializeOAuthReconnectManager');
const { capabilityContextMiddleware } = require('./middleware/roles/capabilities');
const createValidateImageRequest = require('./middleware/validateImageRequest');
const { startExpiredFileSweep } = require('./services/Files/process');
const { jwtLogin, ldapLogin, passportLogin } = require('~/strategies');
const { checkMigrations } = require('./services/start/migration');
const optionalJwtAuth = require('./middleware/optionalJwtAuth');
const initializeMCPs = require('./services/initializeMCPs');
const configureSocialLogins = require('./socialLogins');
const { getAppConfig } = require('./services/Config');
const staticCache = require('./utils/staticCache');
const noIndex = require('./middleware/noIndex');
const routes = require('./routes');
const db = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const { startPrototypeTransport } = require('./services/Prototypes/PrototypeTransportStartup');
const { startOptionalPrototype } = require('./services/Prototypes/PrototypeOptionalStartup');
const { prototypeAvailability } = require('./services/Prototypes/PrototypeAvailability');
const { openPrototypeStore } = require('./services/Prototypes/PrototypeStore');
const {
  createPrototypeControlPlaneStartup,
} = require('./services/Prototypes/PrototypeControlPlaneStartup');

const pkg = require('../../packages/api/dist/index.js');
const openrouterBalanceRoutes =
  pkg.OpenrouterStatisticsRoutes || pkg.default?.OpenrouterStatisticsRoutes;
const logsRoutes = pkg.LogsRoutes || pkg.default?.LogsRoutes;

const { PORT, HOST, ALLOW_SOCIAL_LOGIN, DISABLE_COMPRESSION, TRUST_PROXY } = process.env ?? {};

// Allow PORT=0 to be used for automatic free port assignment
const port = isNaN(Number(PORT)) ? 3080 : Number(PORT);
const host = HOST || 'localhost';
const trusted_proxy = Number(TRUST_PROXY) || 1; /* trust first proxy by default */

const app = express();
let serverReady = false;

const startServer = async () => {
  const { metricsMiddleware, metricsRouter } = createMetrics();
  if (!process.env.METRICS_SECRET) {
    logger.warn('[metrics] METRICS_SECRET is not set - /metrics will return 401 for all requests');
  }

  if (typeof Bun !== 'undefined') {
    axios.defaults.headers.common['Accept-Encoding'] = 'gzip';
  }
  await connectDb();

  logger.info('Connected to MongoDB');
  indexSync().catch((err) => {
    logger.error('[indexSync] Background sync failed:', err);
  });

  app.disable('x-powered-by');
  app.set('trust proxy', trusted_proxy);

  if (isEnabled(process.env.TENANT_ISOLATION_STRICT)) {
    logger.warn(
      '[Security] TENANT_ISOLATION_STRICT is active. Ensure your reverse proxy strips or sets ' +
        'the X-Tenant-Id header — untrusted clients must not be able to set it directly.',
    );
  }

  await runAsSystem(seedDatabase);
  /* Recover stuck `status: 'pending'` records from a crash mid-render.
   * `runAsSystem` is required тАФ `File` is tenant-isolated and strict
   * mode rejects unscoped queries. Lazy sweep in the preview endpoint
   * covers anything younger than the boot cutoff. */
  runAsSystem(sweepOrphanedPreviews).catch((err) => {
    logger.error('[sweepOrphanedPreviews] Background sweep failed:', err);
  });
  const appConfig = await getAppConfig({ baseOnly: true });
  const prototypeTransportEnabled = isEnabled(process.env.PROTOTYPE_TRANSPORT_ENABLED);
  let prototypeControlPlane;
  let prototypeModelProxy;
  try {
    prototypeControlPlane = createPrototypeControlPlaneStartup({
      enabled:
        prototypeTransportEnabled &&
        !process.env.PROTOTYPE_MONGO_URI &&
        appConfig.prototypeAgent?.enabled === true,
      db,
      mongoose,
    });
  } catch {
    logger.warn('[Prototype] Optional control plane is unavailable.');
  }
  initializeFileStorage(appConfig);
  startExpiredFileSweep({ appConfig, loadAppConfig: getAppConfig });
  await runAsSystem(async () => {
    await performStartupChecks(appConfig);
    await updateInterfacePermissions({ appConfig, getRoleByName, updateAccessPermissions });
  });

  const indexPath = path.join(appConfig.paths.dist, 'index.html');
  let indexHTML = fs.readFileSync(indexPath, 'utf8');

  // In order to provide support to serving the application in a sub-directory
  // We need to update the base href if the DOMAIN_CLIENT is specified and not the root path
  if (process.env.DOMAIN_CLIENT) {
    const clientUrl = new URL(process.env.DOMAIN_CLIENT);
    const baseHref = clientUrl.pathname.endsWith('/')
      ? clientUrl.pathname
      : `${clientUrl.pathname}/`;
    if (baseHref !== '/') {
      logger.info(`Setting base href to ${baseHref}`);
      indexHTML = indexHTML.replace(/base href="\/"/, `base href="${baseHref}"`);
    }
  }

  app.get('/health', (_req, res) => res.status(200).send('OK'));
  app.get('/livez', (_req, res) => res.status(200).send('OK'));
  app.get('/readyz', (_req, res) => {
    if (!serverReady) {
      return res.status(503).send('NOT_READY');
    }
    return res.status(200).send('OK');
  });

  /* Middleware */
  app.use(metricsMiddleware);
  app.use(noIndex);
  app.use(express.json({ limit: '6mb' }));
  app.use(express.urlencoded({ extended: true, limit: '6mb' }));
  app.use(handleJsonParseError);
  // Scoped bearer auth is independent of browser login. Preserve function JSON schemas before mongoSanitize.
  app.use('/api/prototype-model/v1', (req, res, next) => {
    if (!prototypeModelProxy)
      return res
        .status(503)
        .json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE', retryable: false } });
    return prototypeModelProxy.modelRouter(req, res, next);
  });
  // Existing HTTPS /api ingress carries authenticated worker requests in bearer mode.
  app.use('/api/internal/prototype-tokens', (req, res, next) => {
    const {
      usesPrototypeBearerAuth,
    } = require('./services/Prototypes/PrototypeControlPlaneStartup');
    if (process.env.NODE_ENV !== 'production' || !usesPrototypeBearerAuth())
      return res.sendStatus(404);
    if (!prototypeModelProxy)
      return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
    return prototypeModelProxy.tokenRouter(req, res, next);
  });
  app.use('/internal/prototype-tokens', (req, res, next) => {
    if (process.env.NODE_ENV === 'production' || !prototypeModelProxy) return res.sendStatus(404);
    return prototypeModelProxy.tokenRouter(req, res, next);
  });

  /**
   * Express 5 Compatibility: Make req.query writable for mongoSanitize
   * In Express 5, req.query is read-only by default, but express-mongo-sanitize needs to modify it
   */
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'query', {
      ...Object.getOwnPropertyDescriptor(req, 'query'),
      value: req.query,
      writable: true,
    });
    next();
  });

  app.use(mongoSanitize());
  app.use(cors());
  app.use(cookieParser());

  if (!isEnabled(DISABLE_COMPRESSION)) {
    app.use(compression());
  } else {
    console.warn('Response compression has been disabled via DISABLE_COMPRESSION.');
  }

  app.use(staticCache(appConfig.paths.dist));
  app.use(staticCache(appConfig.paths.fonts));
  app.use(staticCache(appConfig.paths.assets));

  if (telemetry.enabled) {
    app.use(telemetry.telemetryMiddleware);
  }

  if (!ALLOW_SOCIAL_LOGIN) {
    console.warn('Social logins are disabled. Set ALLOW_SOCIAL_LOGIN=true to enable them.');
  }

  /* OAUTH */
  app.use(passport.initialize());
  passport.use(jwtLogin());
  passport.use(passportLogin());

  /* LDAP Auth */
  if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
    passport.use(ldapLogin);
  }

  if (isEnabled(ALLOW_SOCIAL_LOGIN)) {
    await configureSocialLogins(app);
  }

  /* Per-request capability cache — must be registered before any route that calls hasCapability */
  app.use(capabilityContextMiddleware);

  /* Pre-auth tenant context for unauthenticated routes that need tenant scoping.
   * The reverse proxy / auth gateway sets `X-Tenant-Id` header for multi-tenant deployments. */
  app.use('/oauth', preAuthTenantMiddleware, routes.oauth);
  /* API Endpoints */
  app.use('/api/auth', preAuthTenantMiddleware, routes.auth);
  app.use('/api/admin', routes.adminAuth);
  app.use('/api/admin/config', routes.adminConfig);
  app.use('/api/admin/grants', routes.adminGrants);
  app.use('/api/admin/groups', routes.adminGroups);
  app.use('/api/admin/roles', routes.adminRoles);
  app.use('/api/admin/users', routes.adminUsers);
  app.use('/api/admin/user-activity', routes.adminUserActivity);
  app.use('/api/admin/new-users', routes.adminNewUsers);
  app.use('/api/admin/message-stats', routes.adminMessageStats);
  app.use('/api/admin/model-share', routes.adminModelShare);
  app.use('/api/admin/guides', routes.adminGuides);
  if (logsRoutes) {
    const { requireAdmin } = pkg;
    app.use('/api/admin/logs', requireJwtAuth, requireAdmin, logsRoutes);
  }
  app.use('/api/actions', routes.actions);
  app.use('/api/keys', routes.keys);
  app.use('/api/api-keys', routes.apiKeys);
  app.use('/api/user', routes.user);
  app.use('/api/search', routes.search);
  app.use('/api/openrouter', requireJwtAuth, openrouterBalanceRoutes);
  app.use('/api/messages', routes.messages);
  app.use('/api/convos', routes.convos);
  app.use('/api/conversations', routes.prototypes.conversations);
  app.use('/api/prototypes', routes.prototypes.jobs);
  if (prototypeTransportEnabled) {
    app.use('/api/internal/prototype-control/v2', (req, res, next) => {
      const {
        usesPrototypeBearerAuth,
      } = require('./services/Prototypes/PrototypeControlPlaneStartup');
      if (process.env.NODE_ENV !== 'production' || !usesPrototypeBearerAuth())
        return res.sendStatus(404);
      if (!prototypeControlPlane)
        return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
      return prototypeControlPlane.router(req, res, next);
    });
    app.use('/internal/prototype-control/v2', (req, res, next) => {
      if (!prototypeControlPlane)
        return res.status(503).json({ error: { code: 'PROTOTYPE_SERVICE_UNAVAILABLE' } });
      return prototypeControlPlane.router(req, res, next);
    });
  }
  app.use('/api/presets', routes.presets);
  app.use('/api/prompts', routes.prompts);
  app.use('/api/skills', routes.skills);
  app.use('/api/categories', routes.categories);
  app.use('/api/endpoints', routes.endpoints);
  app.use('/api/balance', routes.balance);
  app.use('/api/models', routes.models);
  app.use('/api/config', preAuthTenantMiddleware, optionalJwtAuth, routes.config);
  app.use('/api/assistants', routes.assistants);
  app.use('/api/files', await routes.files.initialize());
  app.use('/images/', createValidateImageRequest(appConfig.secureImageLinks), routes.staticRoute);
  app.use('/api/share', preAuthTenantMiddleware, routes.share);
  app.use('/api/roles', routes.roles);
  app.use('/api/agents', routes.agents);
  app.use('/api/banner', routes.banner);
  app.use('/api/guides', routes.guides);
  app.use('/api/memories', routes.memories);
  app.use('/api/permissions', routes.accessPermissions);

  app.use('/api/tags', routes.tags);
  app.use('/api/mcp', routes.mcp);

  app.use('/metrics', metricsRouter);

  /** 404 for unmatched API routes */
  app.use('/api', apiNotFound);

  /** SPA fallback - serve index.html for all unmatched routes */
  app.use((req, res) => {
    res.set({
      'Cache-Control': process.env.INDEX_CACHE_CONTROL || 'no-cache, no-store, must-revalidate',
      Pragma: process.env.INDEX_PRAGMA || 'no-cache',
      Expires: process.env.INDEX_EXPIRES || '0',
    });

    const lang = req.cookies.lang || req.headers['accept-language']?.split(',')[0] || 'en-US';
    const saneLang = lang.replace(/"/g, '&quot;');
    let updatedIndexHtml = indexHTML.replace(/lang="en-US"/g, `lang="${saneLang}"`);

    res.type('html');
    res.send(updatedIndexHtml);
  });

  /** Record trace errors before the final error controller. */
  if (telemetry.enabled) {
    app.use(telemetry.telemetryErrorMiddleware);
  }
  /** Error handler (must be last - Express identifies error middleware by its 4-arg signature) */
  app.use(ErrorController);

  const server = app.listen(port, host, async (err) => {
    if (err) {
      logger.error('Failed to start server:', err);
      process.exit(1);
    }

    if (host === '0.0.0.0') {
      logger.info(
        `Server listening on all interfaces at port ${port}. Use http://localhost:${port} to access it`,
      );
    } else {
      logger.info(`Server listening at http://${host == '0.0.0.0' ? 'localhost' : host}:${port}`);
    }

    /**
     * The listen callback is async, so any rejection from these awaits would
     * otherwise be detached from `startServer().catch(...)` (which only
     * catches errors that happen before `app.listen`). Without explicit
     * handling, the global `unhandledRejection` handler would swallow init
     * failures and leave the server listening but only partially
     * initialized тАФ passing liveness checks while serving broken requests.
     */
    try {
      await runAsSystem(async () => {
        await initializeMCPs();
        await initializeOAuthReconnectManager();
      });
      await checkMigrations();

      // Configure stream services (auto-detects Redis from USE_REDIS env var)
      const streamServices = createStreamServices();
      GenerationJobManager.configure(streamServices);
      GenerationJobManager.initialize();

      const prototypeRuntimeEnabled =
        prototypeTransportEnabled && appConfig.prototypeAgent?.enabled === true;
      if (prototypeRuntimeEnabled || process.env.PROTOTYPE_MODEL_PROXY_ENABLED === 'true') {
        let storeShutdownRegistered = false;
        const stopPrototypeStartup = startOptionalPrototype({
          logger,
          start: async () => {
            let prototypeDb = db;
            let prototypeMongoose = mongoose;
            if (!prototypeRuntimeEnabled && !process.env.PROTOTYPE_MONGO_URI) {
              throw new Error('PROTOTYPE_ADAPTER_REQUIRES_SEPARATE_STORE');
            }
            if (process.env.PROTOTYPE_MONGO_URI) {
              const store = await openPrototypeStore();
              prototypeMongoose = store.mongoose;
              prototypeDb = {
                ...store.methods,
                flushPrototypeChatProjection: () => store.projection.flush(),
              };
              if (!storeShutdownRegistered) {
                registerShutdownTask('prototype store', () => store.stop());
                storeShutdownRegistered = true;
              }
              prototypeControlPlane = createPrototypeControlPlaneStartup({
                enabled: true,
                db: prototypeDb,
                mongoose: prototypeMongoose,
              });
            }
            const stopMonitor = prototypeRuntimeEnabled
              ? prototypeAvailability.monitor(
                  prototypeMongoose.connection.db.collection('prototypeavailability'),
                )
              : () => {};
            try {
              const {
                createPrototypeModelProxyStartup,
              } = require('./services/Prototypes/PrototypeModelProxyStartup');
              const {
                createPrototypeServiceAuthenticator,
              } = require('./services/Prototypes/PrototypeControlPlaneStartup');
              const { runAsSystem } = require('@librechat/data-schemas');
              prototypeModelProxy = await createPrototypeModelProxyStartup({
                mongoose: prototypeMongoose,
                authenticateService: createPrototypeServiceAuthenticator(),
                getUserKeyValues: (input) => runAsSystem(async () => db.getUserKeyValues(input)),
              });
              prototypeControlPlane?.setModelTokenRouter(prototypeModelProxy?.tokenRouter);
              if (!prototypeRuntimeEnabled) {
                // Adapter-only rollout has no command intake, Redis, S3, heartbeat or generation admission.
                try {
                  await prototypeControlPlane?.startPrivateListener();
                } catch (error) {
                  await prototypeControlPlane?.stopPrivateListener();
                  throw error;
                }
                const stopAdapter = async () => {
                  await prototypeControlPlane?.stopPrivateListener();
                  prototypeModelProxy?.close();
                  prototypeModelProxy = null;
                  prototypeControlPlane?.setModelTokenRouter(undefined);
                };
                registerShutdownTask('prototype model adapter', stopAdapter);
                return { stop: stopAdapter };
              }
              const runtime = await startPrototypeTransport({
                enabled: prototypeTransportEnabled,
                appConfig,
                db: prototypeDb,
                mongoose: prototypeMongoose,
                logger,
                registerShutdownTask,
                bindControlPlane: (transport) => {
                  prototypeControlPlane?.bindTransport(transport);
                  return () => prototypeControlPlane?.unbindTransport();
                },
                startPrivateListener: () => prototypeControlPlane?.startPrivateListener(),
                stopPrivateListener: () => prototypeControlPlane?.stopPrivateListener(),
              });
              registerShutdownTask('prototype availability', stopMonitor);
              if (prototypeModelProxy)
                registerShutdownTask('prototype model proxy', () => {
                  prototypeModelProxy?.close();
                  prototypeModelProxy = null;
                });
              return runtime;
            } catch (error) {
              prototypeModelProxy?.close();
              prototypeModelProxy = null;
              prototypeControlPlane?.setModelTokenRouter(undefined);
              stopMonitor();
              throw error;
            }
          },
        });
        registerShutdownTask('optional prototype startup', stopPrototypeStartup);
      }

      const inspectFlags = process.execArgv.some((arg) => arg.startsWith('--inspect'));
      if (inspectFlags || isEnabled(process.env.MEM_DIAG)) {
        memoryDiagnostics.start();
      }
      serverReady = true;
      logger.info('Server readiness checks passing.');
    } catch (initErr) {
      serverReady = false;
      logger.error('Post-listen initialization failed:', initErr);
      process.exit(1);
    }
  });

  setupGracefulShutdown(server);
};

/**
 * Boot rejections (e.g. `connectDb`, `getAppConfig`, `performStartupChecks`)
 * must remain fail-fast: a half-initialized process with no listening HTTP
 * server should die immediately so the orchestrator restarts it, instead of
 * being kept alive by the `unhandledRejection` handler below until the
 * liveness probe eventually times out. Mirrors the pattern in
 * `experimental.js`.
 */
startServer().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});

let messageCount = 0;
process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    logger.error('There was an uncaught error:', err);
  }

  if (err.message && err.message?.toLowerCase()?.includes('abort')) {
    logger.warn('There was an uncatchable abort error.');
    return;
  }

  if (err.message.includes('GoogleGenerativeAI')) {
    logger.warn(
      '\n\n`GoogleGenerativeAI` errors cannot be caught due to an upstream issue, see: https://github.com/google-gemini/generative-ai-js/issues/303',
    );
    return;
  }

  if (err.message.includes('fetch failed')) {
    if (messageCount === 0) {
      logger.warn('Meilisearch error, search will be disabled');
      messageCount++;
    }

    return;
  }

  if (err.message.includes('OpenAIError') || err.message.includes('ChatCompletionMessage')) {
    logger.error(
      '\n\nAn Uncaught `OpenAIError` error may be due to your reverse-proxy setup or stream configuration, or a bug in the `openai` node package.',
    );
    return;
  }

  if (err.stack && err.stack.includes('@librechat/agents')) {
    logger.error(
      '\n\nAn error occurred in the agents system. The error has been logged and the app will continue running.',
      {
        message: err.message,
        stack: err.stack,
      },
    );
    return;
  }

  if (isEnabled(process.env.CONTINUE_ON_UNCAUGHT_EXCEPTION)) {
    logger.error('Unhandled error encountered. The app will continue running.', {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
    return;
  }

  process.exit(1);
});

/**
 * Unhandled promise rejection handler.
 *
 * Node 15+ terminates the process by default when a promise rejection is
 * unhandled. MCP OAuth reconnect storms and streamable-HTTP transport resets
 * can produce transient fire-and-forget rejections (ECONNRESET, token refresh
 * races) that are recoverable тАФ the server should log and keep serving other
 * requests rather than silently crash under load.
 *
 * Non-Error reasons are forwarded as-is so structured payloads (e.g.
 * `{ code: "ECONNRESET", errno: -104 }`) survive instead of being collapsed to
 * "[object Object]" by `String()`.
 */
process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    logger.error('Unhandled promise rejection. The app will continue running.', {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
      cause: reason.cause,
    });
    return;
  }
  logger.error('Unhandled promise rejection. The app will continue running.', { reason });
});

/** Export app for easier testing purposes */
module.exports = app;
