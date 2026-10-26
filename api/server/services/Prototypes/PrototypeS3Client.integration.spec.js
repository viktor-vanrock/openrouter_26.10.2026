const { randomUUID } = require('node:crypto');
const { PrototypeS3Client } = require('./PrototypeS3Client');

const integrationDescribe = process.env.PROTOTYPE_STORAGE_INTEGRATION === '1'
  ? describe
  : describe.skip;

const sha = (letter) => `sha256:${letter.repeat(64)}`;

integrationDescribe('PrototypeS3Client with real S3-compatible backend', () => {
  let client;
  let S3ArtifactStore;
  let worker;

  beforeAll(async () => {
    worker = await import('@librechat/prototype-worker');
    ({ S3ArtifactStore } = worker);
    client = new PrototypeS3Client({
      endpoint: process.env.AWS_ENDPOINT_URL,
      region: process.env.AWS_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  });

  afterAll(() => client?.destroy());

  it('publishes atomically, verifies ownership/digest, and remains readable without a workspace', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const owner = { tenantId: `tenant_${suffix}`, jobId: `job_${suffix}`, executionId: `execution_${suffix}`, revision: 1 };
    const bytes = Buffer.from('durable phase-3 html');
    const digest = `sha256:${require('node:crypto').createHash('sha256').update(bytes).digest('hex')}`;
    const store = new S3ArtifactStore(client, process.env.AWS_BUCKET_NAME);
    const reference = await store.publish({
      owner, kind: 'html', bytes, digest, contentType: 'text/html',
      templateDigest: sha('a'), toolchainDigest: sha('b'),
    });
    await expect(store.readVerified(reference, owner)).resolves.toEqual(bytes);
    await expect(store.readVerified(reference, { ...owner, tenantId: `other_${suffix}` }))
      .rejects.toThrow('OWNERSHIP');
    const staging = await client.listObjects({
      bucket: process.env.AWS_BUCKET_NAME,
      prefix: `staging/${owner.tenantId}/${owner.jobId}/${owner.executionId}/`,
    });
    expect(staging).toEqual([]);
    await client.deleteObject({ bucket: process.env.AWS_BUCKET_NAME, key: reference.objectKey });
  });

  it('does not replace an immutable key with different bytes', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const owner = { tenantId: `tenant_${suffix}`, jobId: `job_${suffix}`, executionId: `execution_${suffix}`, revision: 2 };
    const store = new S3ArtifactStore(client, process.env.AWS_BUCKET_NAME);
    const first = Buffer.from('first');
    const firstDigest = `sha256:${require('node:crypto').createHash('sha256').update(first).digest('hex')}`;
    const reference = await store.publish({ owner, kind: 'qa_evidence', bytes: first, digest: firstDigest, contentType: 'application/json', templateDigest: sha('a'), toolchainDigest: sha('b') });
    await expect(store.publish({ owner, kind: 'qa_evidence', bytes: Buffer.from('different'), digest: firstDigest, contentType: 'application/json', templateDigest: sha('a'), toolchainDigest: sha('b') }))
      .rejects.toThrow('DIGEST');
    await client.deleteObject({ bucket: process.env.AWS_BUCKET_NAME, key: reference.objectKey });
  });

  it('runs fake generation through dependency transfer, offline snapshot and real S3 publication', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const bucket = process.env.AWS_BUCKET_NAME;
    const store = new S3ArtifactStore(client, bucket);
    const published = [];
    const identity = (stage, repair = 0) => ({
      attemptId: `attempt_${suffix}_${repair}`,
      executionId: `${stage}_${suffix}_${repair}`,
      stageId: `${stage}_${suffix}_${repair}`,
    });
    const owner = (stageIdentity, revision = 1) => ({
      tenantId: `tenant_${suffix}`, jobId: `job_${suffix}`,
      executionId: stageIdentity.executionId, revision,
    });
    const templateDigest = sha('a');
    const toolchainDigest = sha('b');
    const checkpoint = Buffer.from('immutable checkpoint');
    const checkpointDigest = worker.artifactDigest(checkpoint);
    const snapshot = {
      html: Buffer.from('<main>offline</main>'),
      sourcesZip: Buffer.from('zip bytes'),
      qaEvidence: Buffer.from('{"passed":true}'),
    };
    snapshot.digests = {
      html: worker.artifactDigest(snapshot.html),
      sourcesZip: worker.artifactDigest(snapshot.sourcesZip),
      qaEvidence: worker.artifactDigest(snapshot.qaEvidence),
    };
    const pipeline = new worker.Phase3Pipeline({
      createIdentity: identity,
      generate: async () => ({ checkpoint, sourceDigest: checkpointDigest }),
      prepareDependencies: async (_sourceDigest, stageIdentity) => {
        const bytes = Buffer.from('verified dependencies');
        const reference = await store.publish({
          owner: owner(stageIdentity), kind: 'dependency_bundle', bytes,
          digest: worker.artifactDigest(bytes), contentType: 'application/zip', templateDigest, toolchainDigest,
        });
        published.push(reference);
        return reference;
      },
      transfer: async (input, stageIdentity) => Buffer.isBuffer(input)
        ? Buffer.from(input)
        : store.readVerified(input, { ...input, executionId: input.executionId, revision: input.revision }),
      buildQa: async ({ source, dependencyBundle }) => {
        expect(source).toEqual(checkpoint);
        expect(dependencyBundle).toEqual(Buffer.from('verified dependencies'));
        return snapshot;
      },
      repair: async () => { throw new Error('repair should not run'); },
      publish: async ({ checkpoint: value, snapshot: verified }, stageIdentity) => {
        const references = await new worker.PublicationAdapter(store).publish({
          owner: owner(stageIdentity), snapshot: verified, checkpoint: value, checkpointDigest,
          templateDigest, toolchainDigest,
        });
        published.push(...references);
        return references;
      },
      acceptPublication: async (references) => {
        for (const reference of references) {
          await expect(store.readVerified(reference, reference)).resolves.toHaveLength(reference.size);
        }
        return { status: 'review', references };
      },
    });
    try {
      await expect(pipeline.run()).resolves.toMatchObject({ status: 'review' });
    } finally {
      await Promise.all(published.map((reference) => client.deleteObject({ bucket, key: reference.objectKey })));
    }
  });
});
