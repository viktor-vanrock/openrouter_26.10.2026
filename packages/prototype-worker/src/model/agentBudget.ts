import type { Mongoose, Model, mongo, Types } from 'mongoose';

export type AgentBudgetIdentity = { jobId: string; turnId: string; tenantId: string; userId: string; modelId: string };
export type AgentBudgetCommand = AgentBudgetIdentity & { commandId: string; attemptId: string; executionId: string;
  leaseId: string; expectedRevision: number; fenceToken: number };
export type AgentBudgetLimits = { maxCostUsd: number; maxRequests: number; activeTimeoutMs: number };
type BudgetTurn = AgentBudgetIdentity & { _id: string; maxMicros: number; maxRequests: number; requestCount: number;
  reservedMicros: number; deadlineAt: Date; createdAt: Date };
type BudgetRequest = AgentBudgetCommand & { _id: string; requestId: string; requestDigest: string;
  reservedMicros: number; status: 'reserved' | 'unknown' | 'settled'; createdAt: Date;
  actualMicros?: number | null; promptTokens?: number | null; completionTokens?: number | null; settledAt?: Date | null };
type BudgetJob = { _id: Types.ObjectId; jobId: string; tenantId: string; userId: string | Types.ObjectId;
  modelId: string; activeTurnId: string; activeCommandId: string; activeAttemptId: string; activeExecutionId: string;
  activeLeaseId: string; activeStage: string; revision: number; fenceToken: number; status: string; accessRevokedAt: Date | null };
/** Durable multi-request turn budget. Unknown outcomes retain the original reservation. */
const toMicros = (value: number, ceiling = 2) => {
  if (!Number.isFinite(value) || value < 0 || value > ceiling) throw new Error('PROTOTYPE_AGENT_BUDGET_INVALID');
  return Math.ceil(value * 1_000_000);
};
const identityFields = ['jobId', 'turnId', 'tenantId', 'userId', 'modelId'] as const;
const same = (record: AgentBudgetIdentity | null, command: AgentBudgetIdentity) => record != null && identityFields.every(key => String(record[key]) === String(command[key]));
const executionFields = ['commandId', 'attemptId', 'executionId', 'leaseId', 'expectedRevision', 'fenceToken'] as const;
export class AgentTurnBudget {
  mongoose: Mongoose; jobs: Model<BudgetJob>; now: () => number; turns: mongo.Collection<BudgetTurn>; requests: mongo.Collection<BudgetRequest>;
  constructor({ mongoose, jobs, now = Date.now }: { mongoose: Mongoose; jobs: Model<BudgetJob>; now?: () => number }) {
    this.mongoose = mongoose; this.jobs = jobs; this.now = now;
    this.turns = mongoose.connection.db!.collection<BudgetTurn>('prototypeagentbudgets');
    this.requests = mongoose.connection.db!.collection<BudgetRequest>('prototypeagentrequests');
  }
  async reserve({ command, requestId, requestDigest, upperCostUsd, limits }: { command: AgentBudgetCommand; requestId: string; requestDigest: string; upperCostUsd: number; limits: AgentBudgetLimits }) {
    if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(requestId ?? '') || !/^sha256:[a-f0-9]{64}$/.test(requestDigest ?? '') ||
        !identityFields.every(key => typeof command?.[key] === 'string' && command[key].length > 0) ||
        !Number.isSafeInteger(limits?.maxRequests) || limits.maxRequests < 1 || limits.maxRequests > 8 ||
        !Number.isSafeInteger(limits?.activeTimeoutMs) || limits.activeTimeoutMs < 1 || limits.activeTimeoutMs > 600000) {
      throw new Error('PROTOTYPE_AGENT_BUDGET_INVALID');
    }
    const maxMicros = toMicros(limits.maxCostUsd), amount = toMicros(upperCostUsd);
    if (maxMicros <= 0 || amount > maxMicros) throw new Error('PROTOTYPE_AGENT_BUDGET_EXCEEDED');
    const session = await this.mongoose.startSession();
    let receipt: BudgetRequest | undefined;
    try {
      await session.withTransaction(async () => {
        const active = await this.jobs.findOne({ jobId: command.jobId, tenantId: command.tenantId, userId: command.userId,
          modelId: command.modelId, activeTurnId: command.turnId, activeCommandId: command.commandId,
          activeAttemptId: command.attemptId, activeExecutionId: command.executionId,
          activeLeaseId: command.leaseId, activeStage: 'generation', revision: command.expectedRevision,
          fenceToken: command.fenceToken, status: 'running', accessRevokedAt: null }, null, { session }).lean();
        if (!active) throw new Error('PROTOTYPE_AGENT_AUTHORITY_REVOKED');
        // Force a transactional write conflict with a concurrent cancel/fence change.
        const authority = await this.jobs.collection.updateOne({ _id: active._id,
          fenceToken: command.fenceToken, revision: command.expectedRevision, status: 'running',
          activeLeaseId: command.leaseId }, { $inc: { modelAuthoritySerial: 1 } }, { session });
        if (authority.modifiedCount !== 1) throw new Error('PROTOTYPE_AGENT_AUTHORITY_REVOKED');
        const id = `${command.turnId}:${requestId}`;
        const existing = await this.requests.findOne({ _id: id }, { session });
        if (existing) {
          if (!same(existing, command) || executionFields.some(key => existing[key] !== command[key]) ||
              existing.requestDigest !== requestDigest) throw new Error('PROTOTYPE_AGENT_REQUEST_CONFLICT');
          throw Object.assign(new Error('PROTOTYPE_AGENT_REQUEST_REPLAY'), { receipt: { requestId, status: existing.status } });
        }
        const identity: AgentBudgetIdentity = { jobId: command.jobId, turnId: command.turnId, tenantId: command.tenantId, userId: command.userId, modelId: command.modelId };
        await this.turns.updateOne({ _id: command.turnId }, { $setOnInsert: { ...identity, maxMicros,
          maxRequests: limits.maxRequests, requestCount: 0, reservedMicros: 0,
          deadlineAt: new Date(this.now() + limits.activeTimeoutMs), createdAt: new Date(this.now()) } }, { session, upsert: true });
        const turn = await this.turns.findOne({ _id: command.turnId }, { session });
        if (!turn || !same(turn, command) || turn.maxMicros !== maxMicros || turn.maxRequests !== limits.maxRequests) throw new Error('PROTOTYPE_AGENT_BUDGET_CONFLICT');
        // Planning happens outside OpenCode but spends the same user's turn ceiling.
        const planners = this.mongoose.connection.db!.collection<{ _id: string; reservedMicros?: number; reservedUpperUsd?: number;
          agentAuthoritySerial?: number }>('prototypemodelbudgets');
        // Share the write-conflict boundary with any simultaneous planner reservation.
        await planners.updateOne({ _id: command.turnId }, { $setOnInsert: { reservedMicros: 0, reservedUpperUsd: 0 },
          $inc: { agentAuthoritySerial: 1 } }, { session, upsert: true });
        const planner = await planners.findOne({ _id: command.turnId }, { session });
        const earlierMicros = planner?.reservedMicros ?? 0;
        if (!Number.isSafeInteger(earlierMicros) || earlierMicros < 0 || earlierMicros > maxMicros - amount) {
          throw new Error('PROTOTYPE_AGENT_BUDGET_EXCEEDED');
        }
        const updated = await this.turns.updateOne({ _id: command.turnId,
          requestCount: { $lt: limits.maxRequests }, reservedMicros: { $lte: maxMicros - amount - earlierMicros },
          deadlineAt: { $gt: new Date(this.now()) } }, { $inc: { requestCount: 1, reservedMicros: amount } }, { session });
        if (updated.modifiedCount !== 1) throw new Error('PROTOTYPE_AGENT_BUDGET_EXCEEDED');
        // reserved means authority has been spent, even if the process dies before or after provider POST.
        receipt = { ...command, _id: id, requestId, requestDigest, reservedMicros: amount, status: 'reserved',
          ...Object.fromEntries(executionFields.map(key => [key, command[key]])),
          createdAt: new Date(this.now()) };
        await this.requests.insertOne(receipt, { session });
      });
    } finally { await session.endSession(); }
    if (!receipt) throw new Error('PROTOTYPE_AGENT_BUDGET_UNAVAILABLE');
    return { requestId, status: receipt.status };
  }
  async settle({ command, requestId, actualCostUsd, promptTokens = null, completionTokens = null }: { command: AgentBudgetCommand; requestId: string; actualCostUsd: number | null; promptTokens?: number | null; completionTokens?: number | null }) {
    const actualMicros = actualCostUsd == null ? null : toMicros(actualCostUsd, 1000);
    for (const tokens of [promptTokens, completionTokens]) if (tokens != null && (!Number.isSafeInteger(tokens) || tokens < 0)) {
      throw new Error('PROTOTYPE_AGENT_USAGE_INVALID');
    }
    const session = await this.mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const receipt = await this.requests.findOne({ _id: `${command.turnId}:${requestId}` }, { session });
        if (!receipt || !same(receipt, command) || executionFields.some(key => receipt[key] !== command[key])) throw new Error('PROTOTYPE_AGENT_REQUEST_CONFLICT');
        if (receipt.status === 'settled') {
          if (receipt.actualMicros !== actualMicros || receipt.promptTokens !== promptTokens || receipt.completionTokens !== completionTokens) {
            throw new Error('PROTOTYPE_AGENT_REQUEST_CONFLICT');
          }
          return;
        }
        await this.requests.updateOne({ _id: receipt._id, status: { $ne: 'settled' } }, { $set: {
          status: actualMicros == null ? 'unknown' : 'settled', actualMicros, promptTokens, completionTokens,
          settledAt: actualMicros == null ? null : new Date(this.now()),
        } }, { session });
        if (actualMicros != null) await this.turns.updateOne({ _id: command.turnId },
          { $inc: { reservedMicros: actualMicros - receipt.reservedMicros } }, { session });
      });
    } finally { await session.endSession(); }
  }
}
