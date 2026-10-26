const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const https = require('node:https');
const express = require('express');
const { createPrototypeControlPlaneTlsServer } = require('./PrototypeControlPlaneTlsServer');
const { createPrototypeServiceAuthenticator, createPrototypeControlPlaneStartup } = require('./PrototypeControlPlaneStartup');

function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'localhost', port, method: 'POST', path: '/internal/prototype-control/v2/heartbeat',
      ...options, headers: { 'content-type': 'application/json', 'X-Prototype-Worker': 'dev-header',
        'X-Forwarded-Client-Cert': 'spiffe://chatrouter/prototype-service' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.setTimeout(3000, () => req.destroy(new Error('test timeout')));
    req.on('error', reject); req.end('{}');
  });
}

it('real TLS admits the allowed peer SAN and rejects absent/wrong/untrusted certificates and forged headers', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-mtls-'));
  const file = name => path.join(directory, name);
  const openssl = args => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' });
  let server, startup;
  try {
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Test CA', '-days', '1']);
    for (const [name, san] of [['server', 'DNS:localhost'], ['allowed', 'URI:spiffe://chatrouter/prototype-service'],
      ['expired', 'URI:spiffe://chatrouter/prototype-service'], ['wrong', 'URI:spiffe://foreign/service']]) {
      openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`]);
      await fs.writeFile(file(`${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=${name === 'server' ? 'serverAuth' : 'clientAuth'}\n`);
      if (name === 'expired') {
        await fs.writeFile(file('index.txt'), '');
        await fs.writeFile(file('serial'), '1000\n');
        await fs.writeFile(file('ca.cnf'), `[ca]\ndefault_ca=local\n[local]\ndatabase=index.txt\nserial=serial\nnew_certs_dir=.\ncertificate=ca.crt\nprivate_key=ca.key\ndefault_md=sha256\ndefault_days=1\npolicy=policy\nx509_extensions=client\n[policy]\ncommonName=supplied\n[client]\nsubjectAltName=${san}\nextendedKeyUsage=clientAuth\n`);
        openssl(['ca', '-batch', '-config', 'ca.cnf', '-in', 'expired.csr', '-out', 'expired.crt',
          '-startdate', '20200101000000Z', '-enddate', '20200102000000Z']);
      } else {
        openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-extfile', `${name}.ext`]);
      }
    }
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'foreign.key', '-out', 'foreign.crt', '-subj', '/CN=Untrusted', '-days', '1']);
    await fs.chmod(file('server.key'), 0o600); await fs.chmod(file('allowed.key'), 0o600);
    const router = express.Router();
    const authenticate = createPrototypeServiceAuthenticator({ env: { NODE_ENV: 'production' } });
    const tokenRouter = express.Router();
    tokenRouter.post('/refresh', async (req, res) => res.status(await authenticate(req) ? 200 : 401)
      .json({ token: 'scoped-test-token' }));
    router.post('/heartbeat', async (req, res) => res.status(await authenticate(req) ? 200 : 401).json({ accepted: true }));
    server = await createPrototypeControlPlaneTlsServer({ router, tokenRouter, config: { host: '127.0.0.1', port: 0,
      certPath: file('server.crt'), keyPath: file('server.key'), caPath: file('ca.crt'),
      allowedServiceUris: ['spiffe://chatrouter/prototype-service'] } });
    const { port } = await server.start();
    const ca = await fs.readFile(file('ca.crt'));
    await expect(request(port, { ca, cert: await fs.readFile(file('allowed.crt')), key: await fs.readFile(file('allowed.key')) })).resolves.toBe(200);
    const { PrototypeControlPlaneClient } = await import('../../../../apps/prototype-service/src/control-plane-client.js');
    const client = await PrototypeControlPlaneClient.fromMtlsConfig({ baseUrl: `https://localhost:${port}`,
      certPath: file('allowed.crt'), keyPath: file('allowed.key'), caPath: file('ca.crt') });
    await expect(client.post('/internal/prototype-control/v2/heartbeat', {})).resolves.toEqual({ accepted: true });
    await expect(client.post('/internal/prototype-tokens/refresh', {})).resolves.toEqual({ token: 'scoped-test-token' });
    await expect(authenticate({ socket: { encrypted: true, authorized: true },
      get: () => 'spiffe://chatrouter/prototype-service' })).resolves.toBe(false);
    await expect(request(port, { ca, cert: await fs.readFile(file('wrong.crt')), key: await fs.readFile(file('wrong.key')) })).resolves.toBe(401);
    await expect(request(port, { ca })).rejects.toThrow();
    await expect(request(port, { ca, cert: await fs.readFile(file('expired.crt')), key: await fs.readFile(file('expired.key')) })).rejects.toThrow();
    await expect(request(port, { ca, cert: await fs.readFile(file('foreign.crt')), key: await fs.readFile(file('foreign.key')) })).rejects.toThrow();
    await server.stop();
    startup = createPrototypeControlPlaneStartup({ enabled: true, env: { NODE_ENV: 'production',
      PROTOTYPE_CONTROL_TLS_HOST: '127.0.0.1', PROTOTYPE_CONTROL_TLS_PORT: String(port),
      PROTOTYPE_CONTROL_TLS_CERT_PATH: file('server.crt'), PROTOTYPE_CONTROL_TLS_KEY_PATH: file('server.key'),
      PROTOTYPE_CONTROL_TLS_CA_PATH: file('ca.crt'), PROTOTYPE_CONTROL_TLS_SERVICE_URIS: 'spiffe://chatrouter/prototype-service' },
      db: { registerPrototypeLease: jest.fn(), registerPrototypeArtifacts: jest.fn() }, mongoose: { startSession: jest.fn() } });
    startup.setModelTokenRouter(tokenRouter);
    await startup.startPrivateListener();
    await expect(client.post('/internal/prototype-control/v2/heartbeat', { ready: true })).resolves.toEqual({ accepted: true });
    await expect(client.post('/internal/prototype-tokens/refresh', {})).resolves.toEqual({ token: 'scoped-test-token' });
    await startup.stopPrivateListener();
  } finally { await startup?.stopPrivateListener(); await server?.stop(); await fs.rm(directory, { recursive: true, force: true }); }
});
