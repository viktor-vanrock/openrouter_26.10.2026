import { execFileSync } from 'child_process';
import mongoose from 'mongoose';
import { ensurePrototypeIndexes } from './prototypeIndexes';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

jest.setTimeout(120_000);

const integrationDescribe =
  process.env.PROTOTYPE_MONGO_INDEX_TEST === '1' ? describe : describe.skip;

integrationDescribe('ensurePrototypeIndexes real MongoDB migration', () => {
  const containerName = `prototype-index-migration-${process.pid}`;
  let connection: mongoose.Connection;

  beforeAll(async () => {
    execFileSync('docker', ['image', 'inspect', 'mongo:6'], { stdio: 'ignore' });
    execFileSync(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--pull=never',
        '--name',
        containerName,
        '--publish',
        '127.0.0.1::27017',
        'mongo:6',
      ],
      { stdio: 'ignore' },
    );
    const port = execFileSync('docker', ['port', containerName, '27017/tcp'], {
      encoding: 'utf8',
    })
      .trim()
      .split(':')
      .pop();
    const uri = `mongodb://127.0.0.1:${port}/prototype_index_${process.pid}`;

    connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 15_000 });
    await connection.asPromise();
  });

  afterAll(async () => {
    await connection?.close();
    try {
      execFileSync('docker', ['stop', containerName], { stdio: 'ignore' });
    } catch (_error) {
      // The uniquely named --rm container may already be gone.
    }
  });

  beforeEach(async () => {
    await connection.db!.dropDatabase();
  });

  it('replaces only the exact legacy index and is idempotent across ownership scopes', async () => {
    const jobs = connection.db!.collection('prototypejobs');
    await jobs.createIndex({ originToolCallId: 1 }, { name: 'originToolCallId_1', unique: true });
    await jobs.createIndex({ modelId: 1 }, { name: 'unknown_model_lookup' });

    await ensurePrototypeIndexes(connection);

    const migratedIndexes = await jobs.indexes();
    expect(migratedIndexes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'originToolCallId_1' })]),
    );
    expect(migratedIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tenantId_1_userId_1_originToolCallId_1',
          key: { tenantId: 1, userId: 1, originToolCallId: 1 },
          unique: true,
        }),
        expect.objectContaining({ name: 'unknown_model_lookup', key: { modelId: 1 } }),
      ]),
    );

    const scopedUpsert = (tenantId: string, userId: string, jobId: string) =>
      jobs.updateOne(
        { tenantId, userId, originToolCallId: 'shared-origin' },
        { $setOnInsert: { tenantId, userId, originToolCallId: 'shared-origin', jobId } },
        { upsert: true },
      );

    await scopedUpsert('tenant-a', 'user-a', 'job-a');
    await scopedUpsert('tenant-b', 'user-b', 'job-b');
    await scopedUpsert('tenant-a', 'user-a', 'job-retry');

    expect(await jobs.countDocuments({ originToolCallId: 'shared-origin' })).toBe(2);
    expect(await jobs.findOne({ tenantId: 'tenant-a', userId: 'user-a' })).toMatchObject({
      jobId: 'job-a',
    });

    await expect(ensurePrototypeIndexes(connection)).resolves.toBeDefined();
    expect((await jobs.indexes()).map(({ name }) => name)).toContain('unknown_model_lookup');
  });

  it('preserves a similarly named index that does not exactly match the legacy contract', async () => {
    const jobs = connection.db!.collection('prototypejobs');
    await jobs.createIndex(
      { originToolCallId: 1, modelId: 1 },
      { name: 'originToolCallId_1_custom', unique: true },
    );

    await ensurePrototypeIndexes(connection);

    expect(await jobs.indexes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'originToolCallId_1_custom',
          key: { originToolCallId: 1, modelId: 1 },
          unique: true,
        }),
        expect.objectContaining({
          name: 'tenantId_1_userId_1_originToolCallId_1',
          key: { tenantId: 1, userId: 1, originToolCallId: 1 },
          unique: true,
        }),
      ]),
    );
  });
});
