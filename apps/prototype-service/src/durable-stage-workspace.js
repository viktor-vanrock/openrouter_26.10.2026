import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { S3ArtifactStore, artifactDigest } from '@librechat/prototype-worker';
const names = new Set([
  'plan.json',
  'App.tsx',
  'review.json',
  'checkpoint',
  'dependencies.zip',
  'snapshot.json',
]);
const outputNames = new Set([
  'checkpoint.tar.zst',
  'dependencies.zip',
  'preview.html',
  'sources.zip',
  'qa.json',
  'result.json',
  'publication.json',
  'failure.json',
]);
const safeId = (value) => /^[a-zA-Z0-9_.:-]{1,256}$/.test(value ?? '');
const fields = [
  'tenantId',
  'userId',
  'jobId',
  'turnId',
  'commandId',
  'attemptId',
  'executionId',
  'stage',
  'expectedRevision',
  'fenceToken',
  'modelId',
];
function identity(c) {
  if (
    !fields
      .filter((k) => !['expectedRevision', 'fenceToken', 'modelId'].includes(k))
      .every((k) => typeof c[k] === 'string' && safeId(c[k])) ||
    typeof c.modelId !== 'string' ||
    !c.modelId ||
    c.modelId.length > 256 ||
    /[\x00-\x1f]/.test(c.modelId) ||
    !Number.isSafeInteger(c.expectedRevision) ||
    c.expectedRevision < 0 ||
    !Number.isSafeInteger(c.fenceToken) ||
    c.fenceToken < 1
  )
    throw new Error('PROTOTYPE_WORKSPACE_IDENTITY_INVALID');
  return Object.fromEntries(fields.map((k) => [k, c[k]]));
}
const owner = (c) => ({
  tenantId: c.tenantId,
  jobId: c.jobId,
  executionId: c.executionId,
  revision: c.expectedRevision,
});
function verifyFiles(files) {
  if (
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    Object.keys(files).length > 13 ||
    Object.entries(files).some(
      ([name, content]) =>
        (!names.has(name) && !(name.startsWith('output/') && outputNames.has(name.slice(7)))) ||
        typeof content !== 'string' ||
        content.length > 12 * 1024 * 1024 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content),
    )
  ) {
    throw new Error('PROTOTYPE_WORKSPACE_FILES_INVALID');
  }
}
/** Scratch can disappear. Only owner-bound immutable object + fenced Mongo receipt authorizes restore. */
export class DurableStageWorkspace {
  constructor({ mongoose, jobs, storage, bucket, directory, pins }) {
    Object.assign(this, { mongoose, jobs, directory, pins });
    this.receipts = mongoose.connection.db.collection('prototypestagecheckpoints');
    this.store = new S3ArtifactStore(storage, bucket);
  }
  async active(c, session) {
    const job = await this.jobs
      .findOne(
        {
          jobId: c.jobId,
          tenantId: c.tenantId,
          userId: c.userId,
          modelId: c.modelId,
          activeTurnId: c.turnId,
          activeCommandId: c.commandId,
          activeAttemptId: c.attemptId,
          activeExecutionId: c.executionId,
          activeStage: c.stage,
          revision: c.expectedRevision,
          fenceToken: c.fenceToken,
          accessRevokedAt: null,
          status: { $in: ['preparing', 'running'] },
        },
        null,
        { session, maxTimeMS: 1000 },
      )
      .lean();
    if (!job) throw new Error('PROTOTYPE_WORKSPACE_AUTHORITY_REVOKED');
    return job;
  }
  async save(c, root, outputRoot, succeeded) {
    const binding = identity(c);
    await this.active(c);
    const files = {};
    for (const [prefix, directory, whitelist] of [
      ['', root, names],
      ['output/', outputRoot, outputNames],
    ]) {
      for (const name of whitelist) {
        try {
          const file = await fs.open(
            path.join(directory, name),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
              throw new Error('PROTOTYPE_WORKSPACE_SIZE_LIMIT');
            files[prefix + name] = (await file.readFile()).toString('base64');
          } finally {
            await file.close();
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
    verifyFiles(files);
    const bytes = Buffer.from(
      JSON.stringify({ schemaVersion: 1, identity: binding, succeeded, files }),
    );
    if (bytes.length > 12 * 1024 * 1024) throw new Error('PROTOTYPE_WORKSPACE_SIZE_LIMIT');
    const digest = artifactDigest(bytes);
    const reference = await this.store.publish({
      owner: owner(c),
      kind: 'checkpoint',
      bytes,
      digest,
      contentType: 'application/json',
      templateDigest: this.pins.templateDigest,
      toolchainDigest: this.pins.toolchainDigest,
    });
    const session = await this.mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const job = await this.active(c, session);
        const lock = await this.jobs.collection.updateOne(
          {
            _id: job._id,
            revision: c.expectedRevision,
            fenceToken: c.fenceToken,
            activeExecutionId: c.executionId,
          },
          { $inc: { workspaceAuthoritySerial: 1 } },
          { session },
        );
        if (lock.modifiedCount !== 1) throw new Error('PROTOTYPE_WORKSPACE_AUTHORITY_REVOKED');
        const old = await this.receipts.findOne({ _id: c.commandId }, { session });
        if (
          old &&
          (old.digest !== digest || Object.entries(binding).some(([k, v]) => old[k] !== v))
        )
          throw new Error('PROTOTYPE_WORKSPACE_RECEIPT_CONFLICT');
        await this.receipts.updateOne(
          { _id: c.commandId },
          { $setOnInsert: { ...binding, reference, digest, succeeded, createdAt: new Date() } },
          { upsert: true, session },
        );
      });
    } finally {
      await session.endSession();
    }
  }
  async materialize(row, root, outputRoot, expected) {
    if (!row || Object.entries(expected).some(([k, v]) => row[k] !== v))
      throw new Error('PROTOTYPE_WORKSPACE_OWNERSHIP_MISMATCH');
    if (
      row.reference?.templateDigest !== this.pins.templateDigest ||
      row.reference?.toolchainDigest !== this.pins.toolchainDigest
    )
      throw new Error('PROTOTYPE_WORKSPACE_PIN_MISMATCH');
    const bytes = await this.store.readVerified(row.reference, owner(row));
    if (bytes.length > 12 * 1024 * 1024 || artifactDigest(bytes) !== row.digest)
      throw new Error('PROTOTYPE_WORKSPACE_DIGEST_INVALID');
    const value = JSON.parse(bytes);
    if (
      value.schemaVersion !== 1 ||
      Object.entries(identity(row)).some(([k, v]) => value.identity[k] !== v)
    )
      throw new Error('PROTOTYPE_WORKSPACE_OWNERSHIP_MISMATCH');
    verifyFiles(value.files);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (outputRoot) await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
    for (const [name, encoded] of Object.entries(value.files)) {
      const isOutput = name.startsWith('output/');
      if (isOutput && !outputRoot) continue;
      const file = path.join(isOutput ? outputRoot : root, isOutput ? name.slice(7) : name);
      // Replace disposable scratch only; never follow a generated source symlink.
      const handle = await fs.open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(Buffer.from(encoded, 'base64'));
      } finally {
        await handle.close();
      }
    }
  }
  async restore(c) {
    const binding = identity(c);
    await this.active(c);
    const exact = await this.receipts.findOne({ _id: c.commandId });
    if (exact) {
      const root = path.join(this.directory, 'turns', c.turnId),
        outputRoot = path.join(this.directory, 'outputs', c.commandId);
      await this.materialize(exact, root, outputRoot, binding);
      return { outputRoot, succeeded: exact.succeeded, writersStopped: true };
    }
    const rows = await this.receipts
      .find({
        jobId: c.jobId,
        tenantId: c.tenantId,
        userId: c.userId,
        modelId: c.modelId,
        expectedRevision: { $lt: c.expectedRevision },
        succeeded: true,
      })
      .sort({ expectedRevision: -1 })
      .limit(100)
      .toArray();
    // Restore only the latest receipt for each turn; LocalReactStages selects accepted versions for edit bases.
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.turnId) || !safeId(row.turnId)) continue;
      seen.add(row.turnId);
      await this.materialize(row, path.join(this.directory, 'turns', row.turnId), null, {
        jobId: c.jobId,
        tenantId: c.tenantId,
        userId: c.userId,
        modelId: c.modelId,
      });
    }
    return null;
  }
}
