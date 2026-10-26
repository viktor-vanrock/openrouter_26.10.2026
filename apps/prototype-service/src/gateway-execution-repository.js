import { deterministicLeaseId } from './stage-supervisor.js';
const fields = [
  'jobId',
  'turnId',
  'commandId',
  'tenantId',
  'userId',
  'modelId',
  'expectedRevision',
  'attemptId',
  'executionId',
  'stage',
  'fenceToken',
];

export function gatewayExecutionIdentity(command) {
  const leaseId = deterministicLeaseId(command);
  if (
    !['tenantId', 'userId', 'modelId'].every(
      (key) => typeof command[key] === 'string' && command[key].length > 0,
    )
  ) {
    throw new Error('GATEWAY_EXECUTION_IDENTITY_INVALID');
  }
  return { ...Object.fromEntries(fields.map((key) => [key, command[key]])), leaseId };
}

/** Mongo is authority. Duplicate/ambiguous intents never authorize another create/session. */
export class GatewayExecutionRepository {
  constructor({ model, jobs }) {
    this.model = model;
    this.jobs = jobs;
  }
  async assertActive(command) {
    const job = await this.jobs
      .findOne({
        jobId: command.jobId,
        tenantId: command.tenantId,
        userId: command.userId,
        activeTurnId: command.turnId,
        activeCommandId: command.commandId,
        activeAttemptId: command.attemptId,
        activeExecutionId: command.executionId,
        activeStage: command.stage,
        revision: command.expectedRevision,
        fenceToken: command.fenceToken,
        activeLeaseId: deterministicLeaseId(command),
        status: { $nin: ['failed', 'canceled', 'completed'] },
      })
      .lean();
    if (!job) throw new Error('GATEWAY_EXECUTION_STALE');
  }
  async begin(command, { inputDigest, image, runId }) {
    const identity = gatewayExecutionIdentity(command);
    await this.assertActive(command);
    try {
      const record = await this.model.create({
        ...identity,
        inputDigest,
        image,
        runId,
        phase: 'create_intent',
      });
      return { created: true, record: record.toObject() };
    } catch (error) {
      if (error.code !== 11000) throw error;
      const record = await this.model.findOne({ commandId: command.commandId }).lean();
      if (
        !record ||
        Object.entries(identity).some(([key, value]) => String(record[key]) !== String(value)) ||
        record.inputDigest !== inputDigest ||
        record.image !== image
      )
        throw new Error('GATEWAY_EXECUTION_CONFLICT');
      return { created: false, record };
    }
  }
  async update(command, revision, changes, { requireActive = true } = {}) {
    if (requireActive) await this.assertActive(command);
    const allowed = new Set([
      'phase',
      'sandboxId',
      'sessionId',
      'stdoutOffset',
      'stderrOffset',
      'snapshotRefs',
      'cleanup',
      'errorCode',
    ]);
    if (Object.keys(changes).some((key) => !allowed.has(key)))
      throw new Error('GATEWAY_LEDGER_UPDATE_INVALID');
    const result = await this.model
      .findOneAndUpdate(
        { ...gatewayExecutionIdentity(command), ledgerRevision: revision },
        { $set: changes, $inc: { ledgerRevision: 1 } },
        { new: true, runValidators: true },
      )
      .lean();
    if (!result) throw new Error('GATEWAY_LEDGER_CAS_CONFLICT');
    return result;
  }
}
