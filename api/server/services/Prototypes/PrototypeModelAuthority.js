const tuple = ['jobId', 'turnId', 'commandId', 'attemptId', 'executionId', 'stage', 'fenceToken', 'leaseId'];

/** Durable generation-only lease. Renewal is service-authenticated and cannot extend the turn deadline. */
class PrototypeModelAuthority {
  constructor({ mongoose, now = Date.now }) {
    this.mongoose = mongoose;
    this.now = now;
    this.leases = mongoose.connection.db.collection('prototypemodelleases');
  }

  async job(input, session) {
    if (input.stage !== 'generation') return null;
    const job = await this.mongoose.models.PrototypeJob.findOne({ jobId: input.jobId,
      activeTurnId: input.turnId, activeCommandId: input.commandId, activeAttemptId: input.attemptId,
      activeExecutionId: input.executionId, activeStage: 'generation', activeLeaseId: input.leaseId,
      'generation.engineId': 'opencode-fsd-v1',
      fenceToken: input.fenceToken, status: 'running', accessRevokedAt: null,
      ...(input.revision == null ? {} : { revision: input.revision }) }, null, { session, maxTimeMS: 1000 }).lean();
    if (!job || input.userId != null && String(job.userId) !== input.userId ||
        input.tenantId != null && job.tenantId !== input.tenantId || input.modelId != null && job.modelId !== input.modelId) return null;
    return job;
  }

  async renew(input) {
    const session = await this.mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const job = await this.job(input, session);
        if (!job) throw new Error('PROTOTYPE_AGENT_AUTHORITY_REVOKED');
        const updated = await this.mongoose.models.PrototypeJob.collection.updateOne({ _id: job._id,
          revision: job.revision, fenceToken: input.fenceToken, status: 'running', activeLeaseId: input.leaseId },
        { $inc: { modelAuthoritySerial: 1 } }, { session });
        if (updated.modifiedCount !== 1) throw new Error('PROTOTYPE_AGENT_AUTHORITY_REVOKED');
        const identity = { ...Object.fromEntries(tuple.map(key => [key, input[key]])),
          userId: String(job.userId), tenantId: job.tenantId, modelId: job.modelId, revision: job.revision };
        // One deadline for the entire turn, including all attempts and renewals.
        const turns = this.mongoose.connection.db.collection('prototypemodelturnleases');
        await turns.updateOne({ _id: input.turnId }, { $setOnInsert: { jobId: input.jobId,
          deadlineAt: new Date(this.now() + 600_000) } }, { session, upsert: true });
        const turn = await turns.findOne({ _id: input.turnId }, { session });
        if (turn.jobId !== input.jobId || turn.deadlineAt.getTime() <= this.now()) throw new Error('PROTOTYPE_AGENT_AUTHORITY_REVOKED');
        const existing = await this.leases.findOne({ _id: input.executionId }, { session });
        if (existing && Object.keys(identity).some(key => existing[key] !== identity[key])) {
          throw new Error('PROTOTYPE_AGENT_AUTHORITY_REVOKED');
        }
        result = { ...identity, leaseExpiresAt: new Date(Math.min(turn.deadlineAt.getTime(), this.now() + 60_000)) };
        await this.leases.updateOne({ _id: input.executionId }, { $set: result }, { session, upsert: true });
      });
    } finally { await session.endSession(); }
    return result;
  }

  async active(input) {
    const lease = await this.leases.findOne({ _id: input.executionId }, { maxTimeMS: 1000 });
    if (!lease || tuple.some(key => lease[key] !== input[key]) || lease.leaseExpiresAt.getTime() <= this.now() ||
        !(await this.job({ ...input, revision: lease.revision }))) return null;
    return lease;
  }
}
module.exports = { PrototypeModelAuthority };
