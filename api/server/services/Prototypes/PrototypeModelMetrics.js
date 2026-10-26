const mongoose = require('mongoose');

const WORKING_STATES = new Set(['queued', 'preparing', 'running']);

/** Sum active intervals; waiting for a user, review and completed time are excluded. */
function executionTimes(events, now = Date.now()) {
  const totals = new Map();
  const previous = new Map();
  function add(event, end) {
    const card = event.publicPayload;
    const start = new Date(event.createdAt).getTime();
    if (!card?.turnId || !WORKING_STATES.has(card.status) || !Number.isFinite(start)) return;
    const key = `${event.jobId}:${card.turnId}`;
    const entry = totals.get(key) ?? {
      jobId: event.jobId,
      turnId: card.turnId,
      modelId: card.modelId,
      seconds: 0,
      complete: false,
    };
    entry.seconds += Math.max(0, end - start) / 1000;
    totals.set(key, entry);
  }
  for (const event of events) {
    const at = new Date(event.createdAt).getTime();
    if (!Number.isFinite(at)) continue;
    const prior = previous.get(event.jobId);
    if (prior) add(prior, at);
    previous.set(event.jobId, event);
    const card = event.publicPayload;
    if (card?.turnId && ['review', 'completed'].includes(card.status)) {
      const key = `${event.jobId}:${card.turnId}`;
      const entry = totals.get(key);
      if (entry) entry.complete = true;
    }
  }
  for (const event of previous.values()) add(event, now);
  return totals;
}

function turnLimitUsd() {
  const value = Number(process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD ?? 10);
  return Number.isFinite(value) && value > 0 && value <= 1000 ? value : 10;
}

async function prototypeModelMetrics(card) {
  let scope = mongoose;
  if (process.env.PROTOTYPE_MONGO_URI) {
    const legacy = await mongoose.models.PrototypeJob?.exists({ jobId: card.jobId });
    if (!legacy) scope = require('./PrototypeStore').getPrototypeStore().mongoose;
  }
  const db = scope.connection.db;
  const job = await scope.models.PrototypeJob.findOne({ jobId: card.jobId }).lean();
  const history = job
    ? await scope.models.PrototypeJob.find(
        {
          userId: job.userId,
          tenantId: job.tenantId,
          modelId: card.modelId,
          versions: { $exists: true, $ne: [] },
        },
        { jobId: 1 },
      )
        .sort({ updatedAt: -1 })
        .limit(20)
        .lean()
    : [];
  const jobIds = [...new Set([card.jobId, ...history.map((entry) => entry.jobId)])];
  const timingEvents = await db
    .collection('prototypeevents')
    .find(
      { jobId: { $in: jobIds } },
      {
        projection: {
          jobId: 1,
          createdAt: 1,
          'publicPayload.turnId': 1,
          'publicPayload.status': 1,
          'publicPayload.modelId': 1,
        },
      },
    )
    .sort({ createdAt: -1, eventId: -1 })
    .limit(10000)
    .toArray();
  const timings = executionTimes(timingEvents.reverse());
  const observed = [...timings.values()]
    .filter(
      (entry) =>
        entry.complete &&
        entry.seconds > 0 &&
        entry.modelId === card.modelId &&
        !(entry.jobId === card.jobId && entry.turnId === card.turnId),
    )
    .map((entry) => entry.seconds)
    .sort((a, b) => a - b);
  const elapsed = timings.get(`${card.jobId}:${card.turnId}`)?.seconds ?? 0;
  const metrics = await db
    .collection('prototypemodelmetrics')
    .find(
      { jobId: card.jobId },
      {
        projection: {
          purpose: 1,
          turnId: 1,
          estimate: 1,
          status: 1,
          actualCostUsd: 1,
          promptTokens: 1,
          completionTokens: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    )
    .sort({ updatedAt: -1 })
    .limit(500)
    .toArray();
  const agent = await db
    .collection('prototypeagentrequests')
    .find(
      { jobId: card.jobId },
      {
        projection: {
          turnId: 1,
          status: 1,
          actualMicros: 1,
          promptTokens: 1,
          completionTokens: 1,
          createdAt: 1,
          settledAt: 1,
        },
      },
    )
    .sort({ createdAt: -1 })
    .limit(500)
    .toArray();
  metrics.push(
    ...agent.map((entry) => ({
      ...entry,
      purpose: 'code',
      actualCostUsd: Number.isFinite(entry.actualMicros) ? entry.actualMicros / 1_000_000 : null,
      updatedAt: entry.settledAt ?? entry.createdAt,
    })),
  );
  const current = metrics.filter((entry) => entry.turnId === card.turnId);
  const estimatedRequest =
    current.find((entry) => entry.purpose === 'code' && entry.estimate) ??
    current.find((entry) => entry.estimate);
  const estimate = estimatedRequest?.estimate ?? null;
  const billed = metrics.filter((entry) => Number.isFinite(entry.actualCostUsd));
  const tokenUsage = metrics.filter(
    (entry) =>
      Number.isSafeInteger(entry.promptTokens) || Number.isSafeInteger(entry.completionTokens),
  );
  const ledger = card.turnId
    ? await db
        .collection('prototypemodelbudgets')
        .findOne({ _id: card.turnId }, { projection: { reservedMicros: 1 } })
    : null;
  const agentLedger = card.turnId
    ? await db
        .collection('prototypeagentbudgets')
        .findOne({ _id: card.turnId }, { projection: { reservedMicros: 1, maxMicros: 1 } })
    : null;
  return {
    timing: {
      elapsedSeconds: elapsed,
      running: WORKING_STATES.has(card.status),
      durationLowSeconds: observed.length
        ? observed[Math.floor((observed.length - 1) * 0.2)]
        : null,
      durationHighSeconds: observed.length
        ? observed[Math.ceil((observed.length - 1) * 0.8)]
        : null,
      sampleSize: observed.length,
    },
    estimate,
    estimatePurpose: estimatedRequest?.purpose ?? null,
    limitUsd: agentLedger
      ? agentLedger.maxMicros / 1_000_000
      : (estimate?.limitUsd ?? turnLimitUsd()),
    committedUsd: ((ledger?.reservedMicros ?? 0) + (agentLedger?.reservedMicros ?? 0)) / 1_000_000,
    actualCostUsd: billed.length
      ? billed.reduce((sum, entry) => sum + entry.actualCostUsd, 0)
      : null,
    costComplete: metrics
      .filter((entry) =>
        ['running', 'answered', 'failed', 'settled', 'unknown', 'reserved'].includes(entry.status),
      )
      .every((entry) => Number.isFinite(entry.actualCostUsd)),
    promptTokens: tokenUsage.length
      ? tokenUsage.reduce((sum, entry) => sum + (entry.promptTokens ?? 0), 0)
      : null,
    completionTokens: tokenUsage.length
      ? tokenUsage.reduce((sum, entry) => sum + (entry.completionTokens ?? 0), 0)
      : null,
  };
}

module.exports = { prototypeModelMetrics, executionTimes };
