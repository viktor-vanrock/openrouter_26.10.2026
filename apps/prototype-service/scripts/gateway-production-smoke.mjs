/** Packaged production worker: own local stores, real Gateway GET, no model calls or shared intake. */
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config({ quiet: true });
const id = randomBytes(12).toString('hex');
const image = process.env.PROTOTYPE_ACCEPTANCE_IMAGE ?? 'chatrouter-prototype-worker:local';
const container = `prototype-worker-smoke-${id}`;
const active = process.argv.includes('--active');
const redisContainer = `prototype-redis-smoke-${id}`,
  s3Container = `prototype-s3-smoke-${id}`;
const network = `prototype-worker-smoke-${id}`;
const output = path.resolve(`.prototype-dev/production-worker-smoke-${id}`);
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const localUri = (input, database) => {
  const uri = new URL(input);
  if (uri.protocol !== 'mongodb:' || !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname))
    throw new Error('LOCAL_TEST_URI_REQUIRED');
  uri.pathname = `/${database}_${id}`;
  return uri;
};
const primary = localUri(process.env.MONGO_URI, 'worker_chat');
const prototype = localUri(process.env.PROTOTYPE_MONGO_URI, 'worker_prototype');
if (!prototype.searchParams.has('replicaSet')) throw new Error('LOCAL_REPLICA_REQUIRED');
const dockerUri = (uri) => {
  const copy = new URL(uri);
  copy.hostname = 'host.docker.internal';
  return copy.toString();
};
const docker = (args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
const evidence = {
  at: new Date().toISOString(),
  image,
  mode: active ? 'active-empty-queue' : 'standby',
  scope: 'own local DBs/real Gateway authenticated GET/packaged worker',
  productionStoreWrites: 0,
  paidProviderPosts: 0,
  checks: {},
  cleanup: {},
};
let started = false;
let controlServer,
  redisStarted = false,
  s3Started = false;
let networkCreated = false;
const freePort = async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
try {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const redis = new URL(process.env.REDIS_URI);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(redis.hostname))
    throw new Error('LOCAL_REDIS_REQUIRED');
  redis.hostname = 'host.docker.internal';
  const allowed = [
    'SANDBOX_GATEWAY_URL',
    'SANDBOX_GATEWAY_TOKEN',
    'OPENROUTER_API_URL',
    'AWS_BUCKET_NAME',
    'AWS_REGION',
    'AWS_ENDPOINT_URL',
    'AWS_FORCE_PATH_STYLE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ];
  const env = {
    ...Object.fromEntries(
      allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
    ),
    NODE_ENV: 'production',
    LOG_TO_FILE: 'false',
    PROTOTYPE_SERVICE_ROLE: 'orchestrator',
    PROTOTYPE_EXECUTION_BACKEND: 'sandbox-gateway',
    PROTOTYPE_SERVICE_AUTH_MODE: 'bearer',
    PROTOTYPE_SERVICE_TOKEN: randomBytes(32).toString('hex'),
    PROTOTYPE_CONTROL_PLANE_URL: 'https://unused-control-plane.invalid',
    PROTOTYPE_WORKER_INTAKE_ENABLED: 'false',
    MONGO_URI: dockerUri(primary),
    PROTOTYPE_MONGO_URI: dockerUri(prototype),
    REDIS_URI: redis.toString(),
  };
  let heartbeatCount = 0;
  const mounts = [];
  if (active) {
    docker(['network', 'create', network]);
    networkCreated = true;
    const redisPort = await freePort(),
      s3Port = await freePort(),
      controlPort = await freePort();
    docker([
      'run',
      '-d',
      '--name',
      redisContainer,
      '--network',
      network,
      '-p',
      `127.0.0.1:${redisPort}:6379`,
      'redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
      'redis-server',
      '--appendonly',
      'yes',
      '--maxmemory-policy',
      'noeviction',
    ]);
    redisStarted = true;
    const access = 'local-smoke-access',
      password = randomBytes(16).toString('hex');
    const s3EnvFile = path.join(output, 's3.env');
    await fs.writeFile(s3EnvFile, `MINIO_ROOT_USER=${access}\nMINIO_ROOT_PASSWORD=${password}\n`, {
      mode: 0o600,
    });
    docker([
      'run',
      '-d',
      '--name',
      s3Container,
      '--network',
      network,
      '--env-file',
      s3EnvFile,
      '-p',
      `127.0.0.1:${s3Port}:9000`,
      'bitnamilegacy/minio@sha256:451fe6858cb770cc9d0e77ba811ce287420f781c7c1b806a386f6896471a349c',
    ]);
    s3Started = true;
    const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${s3Port}`,
      forcePathStyle: true,
      credentials: { accessKeyId: access, secretAccessKey: password },
      maxAttempts: 1,
    });
    const s3Deadline = Date.now() + 20000;
    let bucketReady = false;
    while (Date.now() < s3Deadline) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: 'worker-smoke-files' }));
        bucketReady = true;
        break;
      } catch {
        await delay(300);
      }
    }
    s3.destroy();
    if (!bucketReady) throw new Error('LOCAL_S3_UNAVAILABLE');
    const keyFile = path.join(output, 'control.key'),
      certFile = path.join(output, 'control.crt');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-days',
        '1',
        '-subj',
        '/CN=host.docker.internal',
        '-addext',
        'subjectAltName=DNS:host.docker.internal,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    await fs.chmod(keyFile, 0o600);
    await fs.chmod(certFile, 0o644);
    controlServer = https.createServer(
      { key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) },
      (req, res) => {
        req.resume();
        if (
          req.url === '/api/internal/prototype-control/v2/heartbeat' &&
          req.method === 'POST' &&
          req.headers.authorization === `Bearer ${env.PROTOTYPE_SERVICE_TOKEN}`
        ) {
          heartbeatCount++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"accepted":true}');
        } else {
          res.writeHead(404);
          res.end('{}');
        }
      },
    );
    await new Promise((resolve) => controlServer.listen(controlPort, '0.0.0.0', resolve));
    Object.assign(env, {
      REDIS_URI: `redis://${redisContainer}:6379`,
      PROTOTYPE_WORKER_INTAKE_ENABLED: 'true',
      PROTOTYPE_CONTROL_PLANE_URL: `https://host.docker.internal:${controlPort}`,
      NODE_EXTRA_CA_CERTS: '/run/control-ca.crt',
      AWS_ENDPOINT_URL: `http://${s3Container}:9000`,
      AWS_BUCKET_NAME: 'worker-smoke-files',
      AWS_REGION: 'us-east-1',
      AWS_FORCE_PATH_STYLE: 'true',
      AWS_ACCESS_KEY_ID: access,
      AWS_SECRET_ACCESS_KEY: password,
      CREDS_KEY: randomBytes(32).toString('hex'),
      CREDS_IV: randomBytes(16).toString('hex'),
      PROTOTYPE_LOCAL_TURN_LIMIT_USD: '2',
    });
    env.AWS_REQUEST_CHECKSUM_CALCULATION = 'WHEN_REQUIRED';
    delete env.AWS_SESSION_TOKEN;
    mounts.push('--mount', `type=bind,source=${certFile},target=/run/control-ca.crt,readonly`);
    mounts.push('--network', network);
  }
  const envFile = path.join(output, 'runtime.env');
  if (Object.values(env).some((value) => /[\r\n]/.test(value)))
    throw new Error('ENV_VALUE_INVALID');
  await fs.writeFile(
    envFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  docker([
    'run',
    '-d',
    '--name',
    container,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=256m,uid=10001,gid=10001',
    '--tmpfs',
    '/var/lib/prototype:rw,noexec,nosuid,size=256m,uid=10001,gid=10001',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--env-file',
    envFile,
    ...mounts,
    '-p',
    `127.0.0.1:${port}:3090`,
    image,
  ]);
  started = true;
  evidence.imageId = docker(['inspect', container, '--format', '{{.Image}}']).trim();
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  let alive = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).status === 200) {
        alive = true;
        break;
      }
    } catch {}
    if (docker(['inspect', container, '--format', '{{.State.Running}}']).trim() !== 'true') break;
    await delay(500);
  }
  if (!alive) throw new Error('PACKAGED_STARTUP_FAILED');
  evidence.checks.nonRoot = docker(['exec', container, 'id', '-u']).trim() === '10001';
  evidence.checks.expectedReadiness =
    (await fetch(`${base}/readyz`)).status === (active ? 200 : 503);
  const status = await (await fetch(`${base}/status`)).json();
  evidence.checks.expectedHealthyMode =
    status.mode === (active ? 'active' : 'standby') &&
    status.dependencies === 'available' &&
    status.engine === 'direct-react-v1';
  evidence.checks.noApiRuntimeSource =
    docker([
      'exec',
      container,
      'node',
      '-e',
      'process.stdout.write(String(require("node:fs").existsSync("/app/api/server")))',
    ]).trim() === 'false';
  const store = new mongoose.Mongoose();
  try {
    await store.connect(prototype.toString(), {
      serverSelectionTimeoutMS: 2000,
      autoCreate: false,
      autoIndex: false,
    });
    evidence.checks.noOutbox =
      (await store.connection.db.collection('prototypeoutboxes').countDocuments()) === 0;
    evidence.checks.noHeartbeat =
      (await store.connection.db.collection('prototypeavailability').countDocuments()) === 0;
  } finally {
    await store.disconnect();
  }
  if (active) {
    const heartbeatDeadline = Date.now() + 10000;
    while (!heartbeatCount && Date.now() < heartbeatDeadline) await delay(100);
    evidence.checks.httpsBearerHeartbeat = heartbeatCount > 0;
    evidence.checks.storageVerified = status.storage === 'verified_on_start';
    evidence.checks.emptyIsolatedCommandQueue =
      docker(['exec', redisContainer, 'redis-cli', 'XLEN', 'prototype.commands.v2']).trim() === '0';
  }
  docker(['stop', '--time', '10', container]);
  const state = JSON.parse(docker(['inspect', container, '--format', '{{json .State}}']));
  evidence.checks.gracefulSigterm = state.ExitCode === 0 && !state.OOMKilled;
  evidence.passed = Object.values(evidence.checks).every((value) => value === true);
} catch (error) {
  evidence.passed = false;
  evidence.code = /^[A-Z_]+$/.test(error.message) ? error.message : 'PACKAGED_SMOKE_FAILED';
  if (error.stderr)
    await fs.writeFile(path.join(output, 'tool-error.log'), error.stderr, { mode: 0o600 });
} finally {
  if (started) {
    // Logs remain private and are never printed; the runtime emits only bounded error codes.
    try {
      const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8', timeout: 10000 });
      await fs.writeFile(
        path.join(output, 'container.log'),
        `${logs.stdout ?? ''}${logs.stderr ?? ''}`,
        { mode: 0o600 },
      );
    } catch {}
    try {
      docker(['rm', '-f', container]);
      evidence.cleanup.container = 'removed';
    } catch {
      evidence.cleanup.container = 'unknown';
    }
  }
  if (controlServer) await new Promise((resolve) => controlServer.close(resolve));
  for (const [name, exists] of [
    [redisContainer, redisStarted],
    [s3Container, s3Started],
  ]) {
    if (exists) {
      try {
        docker(['rm', '-f', name]);
        evidence.cleanup[name.startsWith('prototype-redis') ? 'redis' : 's3'] =
          'own disposable container removed';
      } catch {
        evidence.cleanup[name] = 'unknown';
      }
    }
  }
  if (networkCreated) {
    try {
      docker(['network', 'rm', network]);
      evidence.cleanup.network = 'own network removed';
    } catch {
      evidence.cleanup.network = 'unknown';
    }
  }
  for (const [name, uri] of [
    ['primary', primary],
    ['prototype', prototype],
  ]) {
    const connection = mongoose.createConnection();
    try {
      await connection.openUri(uri.toString(), { serverSelectionTimeoutMS: 2000 });
      await connection.dropDatabase();
      evidence.cleanup[name] = 'own temporary DB removed';
    } catch {
      evidence.cleanup[name] = 'unknown';
    } finally {
      await connection.close();
    }
  }
  await fs.rm(path.join(output, 'runtime.env'), { force: true });
  await fs.rm(path.join(output, 's3.env'), { force: true });
  await fs.rm(path.join(output, 'control.key'), { force: true });
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
}
console.log(JSON.stringify({ ...evidence, evidenceFile: path.join(output, 'receipt.json') }));
if (!evidence.passed || Object.values(evidence.cleanup).some((v) => v === 'unknown'))
  process.exitCode = 1;
