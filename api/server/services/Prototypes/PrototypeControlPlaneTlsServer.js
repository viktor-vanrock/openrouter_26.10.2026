const fs = require('node:fs/promises');
const https = require('node:https');
const express = require('express');
const { constants } = require('node:fs');
const privateRequests = new WeakSet();
const isPrototypePrivateRequest = req => privateRequests.has(req);

/** Native peer certificate identity; forwarded headers and development identities are never trusted. */
function authenticatePrototypeCertificate(req, allowedUris) {
  const socket = req.socket;
  if (socket?.encrypted !== true || socket.authorized !== true || !Array.isArray(allowedUris) || !allowedUris.length) return false;
  const cert = socket.getPeerCertificate?.();
  const starts = Date.parse(cert?.valid_from);
  const expires = Date.parse(cert?.valid_to);
  if (!cert || !cert.subjectaltname || !cert.fingerprint256 ||
      !Number.isFinite(starts) || !Number.isFinite(expires) || starts > Date.now() || expires <= Date.now()) return false;
  const uris = cert.subjectaltname.split(', ').filter(value => value.startsWith('URI:')).map(value => value.slice(4));
  return uris.length === 1 && allowedUris.includes(uris[0]);
}

async function createPrototypeControlPlaneTlsServer({ config, router, tokenRouter }) {
  if (!config || !router || !config.certPath || !config.keyPath || !config.caPath ||
      !Array.isArray(config.allowedServiceUris) || config.allowedServiceUris.length < 1 ||
      config.allowedServiceUris.some(uri => typeof uri !== 'string' || !/^spiffe:\/\/[a-zA-Z0-9./_-]+$/.test(uri))) {
    throw new Error('PROTOTYPE_MTLS_CONFIG_INVALID');
  }
  const keyFile = await fs.open(config.keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let key;
  try {
    const stat = await keyFile.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16_384) throw new Error('PROTOTYPE_MTLS_KEY_INVALID');
    key = await keyFile.readFile();
  } finally { await keyFile.close(); }
  const [cert, ca] = await Promise.all([fs.readFile(config.certPath), fs.readFile(config.caPath)]);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!authenticatePrototypeCertificate(req, config.allowedServiceUris)) {
      return res.status(401).json({ error: { code: 'PROTOTYPE_WORKER_UNAUTHORIZED' } });
    }
    privateRequests.add(req);
    next();
  });
  app.use(express.json({ limit: '128kb', strict: true }));
  app.use('/internal/prototype-control/v2', router);
  if (tokenRouter) app.use('/internal/prototype-tokens', tokenRouter);
  app.use((_req, res) => res.sendStatus(404));
  const server = https.createServer({ cert, key, ca, requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.2' }, app);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return {
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port ?? 3443, config.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return server.address();
    },
    async stop() {
      if (!server.listening) return;
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
    },
  };
}
module.exports = { createPrototypeControlPlaneTlsServer, authenticatePrototypeCertificate, isPrototypePrivateRequest };
