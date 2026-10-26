import { createHash } from 'node:crypto';
import { S3ArtifactStore, type S3CompatibleClient } from './s3';

class MemoryS3 implements S3CompatibleClient {
  objects = new Map<string, { body: Buffer; metadata: Record<string, string> }>();
  failCopy = false;
  async putObject(input: { key: string; body: Buffer; metadata: Record<string, string>; ifNoneMatch?: '*' }) {
    if (this.failCopy && input.ifNoneMatch) throw new Error('S3 outage');
    if (input.ifNoneMatch && this.objects.has(input.key)) throw new Error('precondition failed');
    this.objects.set(input.key, { body: Buffer.from(input.body), metadata: { ...input.metadata } });
  }
  async headObject(input: { key: string }) { const object = this.objects.get(input.key); return object ? { size: object.body.length, metadata: { ...object.metadata } } : null; }
  async getObject(input: { key: string }) { const value = this.objects.get(input.key); if (!value) throw new Error('not found'); return Buffer.from(value.body); }
  async deleteObject(input: { key: string }) { this.objects.delete(input.key); }
}

const digest = (bytes: Buffer): `sha256:${string}` => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const owner = { tenantId: 'tenant_1', jobId: 'job_1', executionId: 'exec_1', revision: 3 };
const hash = `sha256:${'a'.repeat(64)}` as const;

describe('S3ArtifactStore', () => {
  it('stages, verifies and atomically exposes an ownership-bound immutable object', async () => {
    const client = new MemoryS3(); const store = new S3ArtifactStore(client, 'test-bucket'); const bytes = Buffer.from('hello');
    const reference = await store.publish({ owner, kind: 'html', bytes, digest: digest(bytes), contentType: 'text/html', templateDigest: hash, toolchainDigest: hash });
    expect(reference.objectKey).toContain('/executions/exec_1/revisions/3/');
    expect(await store.readVerified(reference, owner)).toEqual(bytes);
    expect([...client.objects.keys()].every((key) => !key.startsWith('staging/'))).toBe(true);
  });

  it('cleans interrupted staging and never exposes final visibility on outage', async () => {
    const client = new MemoryS3(); client.failCopy = true; const store = new S3ArtifactStore(client, 'test-bucket'); const bytes = Buffer.from('hello');
    await expect(store.publish({ owner, kind: 'html', bytes, digest: digest(bytes), contentType: 'text/html', templateDigest: hash, toolchainDigest: hash })).rejects.toThrow('outage');
    expect(client.objects.size).toBe(0);
  });

  it('rejects digest and ownership mismatches on every restore', async () => {
    const client = new MemoryS3(); const store = new S3ArtifactStore(client, 'test-bucket'); const bytes = Buffer.from('hello');
    await expect(store.publish({ owner, kind: 'html', bytes, digest: `sha256:${'0'.repeat(64)}`, contentType: 'text/html', templateDigest: hash, toolchainDigest: hash })).rejects.toThrow('DIGEST');
    const reference = await store.publish({ owner, kind: 'html', bytes, digest: digest(bytes), contentType: 'text/html', templateDigest: hash, toolchainDigest: hash });
    await expect(store.readVerified(reference, { ...owner, tenantId: 'tenant_2' })).rejects.toThrow('OWNERSHIP');
  });
});

it('rejects correct metadata with corrupted bytes before exposing an accepted reference', async () => {
  const client = new MemoryS3();
  client.getObject = async () => Buffer.from('corrupted');
  const store = new S3ArtifactStore(client, 'test-bucket');
  const bytes = Buffer.from('hello');
  await expect(store.publish({ owner, kind: 'html', bytes, digest: digest(bytes), contentType: 'text/html',
    templateDigest: hash, toolchainDigest: hash })).rejects.toThrow('PUBLICATION_DIGEST_MISMATCH');
});

it('joins an identical conditional-create race without issuing another PUT', async () => {
  const client = new MemoryS3();
  const original = client.putObject.bind(client);
  let immutablePuts = 0;
  client.putObject = async input => {
    await original(input);
    if (input.ifNoneMatch) {
      immutablePuts++;
      throw Object.assign(new Error('exists'), { name: 'ObjectAlreadyExists', $metadata: { httpStatusCode: 409 } });
    }
  };
  const store = new S3ArtifactStore(client, 'test-bucket');
  const bytes = Buffer.from('hello');
  const reference = await store.publish({ owner, kind: 'html', bytes, digest: digest(bytes), contentType: 'text/html',
    templateDigest: hash, toolchainDigest: hash });
  expect(immutablePuts).toBe(1);
  expect(await store.readVerified(reference, owner)).toEqual(bytes);
});
