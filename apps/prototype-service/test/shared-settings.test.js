import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { loadPrototypeConfig } from '../src/config.js';
const { prototypeS3Config } = createRequire(import.meta.url)(
  '../../../api/server/services/Prototypes/PrototypeSharedConfig',
);

test('prototype storage uses only the common AWS settings without a region or path-style override', () => {
  const config = prototypeS3Config({
    AWS_BUCKET_NAME: 'common-files',
    AWS_ENDPOINT_URL: 'https://s3.test',
    AWS_REGION: 'explicit-region',
    AWS_FORCE_PATH_STYLE: 'false',
    AWS_ACCESS_KEY_ID: 'test-access',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
  });
  assert.equal(config.region, 'explicit-region');
  assert.equal(config.forcePathStyle, false);
  assert.equal(config.endpoint, 'https://s3.test');
  assert.deepEqual(config.credentials, {
    accessKeyId: 'test-access',
    secretAccessKey: 'test-secret',
  });
  assert.throws(
    () => prototypeS3Config({ AWS_BUCKET_NAME: 'common-files', AWS_REGION: '' }),
    /AWS_REGION/,
  );
});

test('local control plane derives the existing application URL and shares Redis and S3', () => {
  const config = loadPrototypeConfig({
    NODE_ENV: 'development',
    PROTOTYPE_SERVICE_ROLE: 'orchestrator',
    DOMAIN_SERVER: 'http://localhost:3333',
    REDIS_URI: 'redis://127.0.0.1:19079',
    AWS_ENDPOINT_URL: 'https://s3.test',
    AWS_BUCKET_NAME: 'common-files',
    AWS_REGION: 'explicit-region',
  });
  assert.equal(config.controlPlaneUrl, 'http://localhost:3333/');
  assert.equal(config.redisUrl, 'redis://127.0.0.1:19079');
  assert.equal(config.storageBucket, 'common-files');
  assert.equal(config.storageRegion, 'explicit-region');
});

test('local MinIO and remote S3 addressing follows the configured endpoint profile, not NODE_ENV', () => {
  const base = {
    AWS_BUCKET_NAME: 'common-files',
    AWS_REGION: 'explicit',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'secret',
  };
  const minio = prototypeS3Config({
    ...base,
    NODE_ENV: 'development',
    AWS_ENDPOINT_URL: 'http://127.0.0.1:19000',
    AWS_FORCE_PATH_STYLE: 'true',
  });
  assert.equal(minio.forcePathStyle, true);
  const remoteDev = prototypeS3Config({
    ...base,
    NODE_ENV: 'development',
    AWS_ENDPOINT_URL: 'https://obs.test',
    AWS_FORCE_PATH_STYLE: 'false',
  });
  assert.equal(remoteDev.forcePathStyle, false);
  const aws = prototypeS3Config({ ...base, NODE_ENV: 'production', AWS_FORCE_PATH_STYLE: 'false' });
  assert.equal(aws.forcePathStyle, false);
  assert.equal(Object.hasOwn(aws, 'endpoint'), false);
  assert.equal(aws.requestChecksumCalculation, 'WHEN_REQUIRED');
  assert.throws(
    () => prototypeS3Config({ ...base, AWS_FORCE_PATH_STYLE: 'flase' }),
    /AWS_FORCE_PATH_STYLE/,
  );
  assert.throws(
    () => prototypeS3Config({ ...base, AWS_SECRET_ACCESS_KEY: '' }),
    /configured together/,
  );
});

test('the actual S3 SDK places the bucket in the path for MinIO and in the host for remote S3', async () => {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const base = {
    AWS_BUCKET_NAME: 'common-files',
    AWS_REGION: 'eu-west-1',
    AWS_ACCESS_KEY_ID: 'fixture-access',
    AWS_SECRET_ACCESS_KEY: 'fixture-secret',
  };
  for (const [patch, expectedHost, expectedPath] of [
    [
      { AWS_ENDPOINT_URL: 'http://127.0.0.1:19000', AWS_FORCE_PATH_STYLE: 'true' },
      '127.0.0.1',
      '/common-files/fixture.txt',
    ],
    [
      {
        AWS_ENDPOINT_URL: 'https://obs.ru-moscow-1.hc.sbercloud.ru',
        AWS_FORCE_PATH_STYLE: 'false',
      },
      'common-files.obs.ru-moscow-1.hc.sbercloud.ru',
      '/fixture.txt',
    ],
    [{ AWS_FORCE_PATH_STYLE: 'false' }, 'common-files.s3.eu-west-1.amazonaws.com', '/fixture.txt'],
  ]) {
    const client = new S3Client({ ...prototypeS3Config({ ...base, ...patch }), maxAttempts: 1 });
    client.middlewareStack.add(
      () => async (args) => {
        assert.equal(args.request.hostname, expectedHost);
        assert.equal(args.request.path, expectedPath);
        throw new Error('fixture_intercept_before_network');
      },
      { step: 'finalizeRequest', name: 'assertS3Addressing', priority: 'low' },
    );
    try {
      await assert.rejects(
        client.send(
          new PutObjectCommand({
            Bucket: base.AWS_BUCKET_NAME,
            Key: 'fixture.txt',
            Body: Buffer.from('data'),
          }),
        ),
        /fixture_intercept/,
      );
    } finally {
      client.destroy();
    }
  }
});

test('Gateway production bearer config requires an independent strong service secret', () => {
  const base = {
    NODE_ENV: 'production',
    PROTOTYPE_SERVICE_ROLE: 'orchestrator',
    PROTOTYPE_EXECUTION_BACKEND: 'sandbox-gateway',
    PROTOTYPE_SERVICE_AUTH_MODE: 'bearer',
    PROTOTYPE_CONTROL_PLANE_URL: 'https://chat.test',
    SANDBOX_GATEWAY_URL: 'https://gateway.test',
    SANDBOX_GATEWAY_TOKEN: 'fixture-token',
    OPENROUTER_API_URL: 'https://provider.test/api/v1',
    REDIS_URI: 'rediss://redis.test',
    AWS_BUCKET_NAME: 'common',
    AWS_REGION: 'explicit',
  };
  for (const token of [undefined, 'short', 'A'.repeat(64)]) {
    assert.throws(
      () => loadPrototypeConfig({ ...base, PROTOTYPE_SERVICE_TOKEN: token }),
      /PROTOTYPE_SERVICE_TOKEN/,
    );
  }
  const config = loadPrototypeConfig({ ...base, PROTOTYPE_SERVICE_TOKEN: 'a'.repeat(64) });
  assert.equal(config.serviceAuthMode, 'bearer');
  assert.equal(config.serviceToken, 'a'.repeat(64));
  assert.equal(config.testWorkerIdentity, null);
  assert.equal(config.mtlsCertPath, null);
  assert.equal(config.workerIntakeEnabled, false);
  assert.throws(
    () =>
      loadPrototypeConfig({
        ...base,
        PROTOTYPE_SERVICE_TOKEN: 'a'.repeat(64),
        PROTOTYPE_WORKER_INTAKE_ENABLED: 'yes',
      }),
    /INTAKE_ENABLED/,
  );
  assert.throws(
    () =>
      loadPrototypeConfig({
        ...base,
        PROTOTYPE_SERVICE_TOKEN: 'a'.repeat(64),
        PROTOTYPE_CONTROL_PLANE_URL: 'http://chat.test',
      }),
    /unsupported protocol/,
  );
});
