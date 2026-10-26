import { randomUUID } from 'node:crypto';
import { localModelLimitUsd } from './local-model-settings.js';

const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,256}$/;

export class PersonalBudgetError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export async function reservePersonalModelRequest({
  mongoose,
  command,
  quotedUpperUsd,
  purpose = 'code',
}) {
  const ceilingUsd = localModelLimitUsd();
  if (
    !mongoose?.connection?.db ||
    !SAFE_ID.test(command?.jobId ?? '') ||
    !SAFE_ID.test(command?.turnId ?? '') ||
    !SAFE_ID.test(command?.commandId ?? '') ||
    !SAFE_ID.test(command?.attemptId ?? '') ||
    !SAFE_ID.test(command?.executionId ?? '') ||
    !Number.isSafeInteger(command?.expectedRevision) ||
    command.expectedRevision < 0 ||
    !Number.isSafeInteger(command?.fenceToken) ||
    command.fenceToken < 1 ||
    command.stage !== 'generation' ||
    command.pipelineStep !== 0 ||
    typeof quotedUpperUsd !== 'number' ||
    !Number.isFinite(quotedUpperUsd) ||
    quotedUpperUsd <= 0 ||
    quotedUpperUsd > ceilingUsd ||
    !['moderation', 'plan', 'code'].includes(purpose)
  ) {
    throw new PersonalBudgetError('LIVE_MODEL_BUDGET_INVALID');
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const job = await mongoose.connection.db.collection('prototypejobs').findOne(
        {
          jobId: command.jobId,
          activeTurnId: command.turnId,
          activeCommandId: command.commandId,
          activeAttemptId: command.attemptId,
          activeExecutionId: command.executionId,
          activeStage: 'generation',
          revision: command.expectedRevision,
          fenceToken: command.fenceToken,
          status: 'running',
          accessRevokedAt: null,
        },
        { session, projection: { jobId: 1, userId: 1, tenantId: 1 } },
      );
      if (!job || String(job.userId) !== command.userId || job.tenantId !== command.tenantId) {
        throw new PersonalBudgetError('LIVE_MODEL_EXECUTION_STALE');
      }
      // A replay of the same command must not bill twice. An explicit retry is
      // a new command and may reserve again within the total turn budget.
      const amount = Math.ceil(quotedUpperUsd * 1_000_000) / 1_000_000;
      const micros = Math.ceil(quotedUpperUsd * 1_000_000);
      const reservations = mongoose.connection.db.collection('prototypemodelreservations');
      if (
        await reservations.findOne(
          { jobId: command.jobId, commandId: command.commandId, purpose },
          { session },
        )
      ) {
        throw new PersonalBudgetError('LIVE_MODEL_BUDGET_ALREADY_RESERVED');
      }
      const ledger = mongoose.connection.db.collection('prototypemodelbudgets');
      await ledger.updateOne(
        { _id: command.turnId },
        { $setOnInsert: { reservedUpperUsd: 0, reservedMicros: 0 } },
        { upsert: true, session },
      );
      const reserved = await ledger.updateOne(
        {
          _id: command.turnId,
          reservedMicros: { $lte: Math.floor(ceilingUsd * 1_000_000) - micros },
        },
        { $inc: { reservedUpperUsd: amount, reservedMicros: micros } },
        { session },
      );
      if (reserved.modifiedCount !== 1) throw new PersonalBudgetError('LIVE_MODEL_BUDGET_EXCEEDED');
      await reservations.insertOne(
        {
          _id: `${command.commandId}:${purpose}`,
          turnId: command.turnId,
          purpose,
          reservationId: randomUUID(),
          jobId: command.jobId,
          commandId: command.commandId,
          executionId: command.executionId,
          modelId: command.modelId,
          upperCostUsd: amount,
          status: 'reserved',
          createdAt: new Date(),
        },
        { session },
      );
    });
    return { accepted: true };
  } catch (error) {
    if (error instanceof PersonalBudgetError) throw error;
    if (error?.code === 11000) throw new PersonalBudgetError('LIVE_MODEL_BUDGET_ALREADY_RESERVED');
    throw new PersonalBudgetError('LIVE_MODEL_BUDGET_UNAVAILABLE');
  } finally {
    await session.endSession();
  }
}

/** Only a provider-reported cost releases the unused part of a reservation. */
export async function settlePersonalModelRequest({ mongoose, command, purpose, usage }) {
  if (!Number.isFinite(usage?.cost) || usage.cost < 0) return;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const reservations = mongoose.connection.db.collection('prototypemodelreservations');
      const reservation = await reservations.findOne(
        {
          _id: `${command.commandId}:${purpose}`,
          jobId: command.jobId,
          turnId: command.turnId,
          status: 'reserved',
        },
        { session },
      );
      if (!reservation) return;
      const actualMicros = Math.ceil(usage.cost * 1_000_000);
      const difference = actualMicros - Math.ceil(reservation.upperCostUsd * 1_000_000);
      await reservations.updateOne(
        { _id: reservation._id, status: 'reserved' },
        {
          $set: { status: 'settled', actualCostUsd: usage.cost, settledAt: new Date() },
        },
        { session },
      );
      await mongoose.connection.db.collection('prototypemodelbudgets').updateOne(
        { _id: command.turnId },
        {
          $inc: { reservedMicros: difference, reservedUpperUsd: difference / 1_000_000 },
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
}
