const { PrototypeCostEstimator } = require('./PrototypeCostEstimator');

const DEFAULT_TIMEOUT_MS = 10_000;

function deadline(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Prototype advisory lookup timed out')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function createAdvisoryCostEstimator({
  config,
  loadCompletedCosts,
  resolveCredential,
  loadBalance,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
}) {
  const estimator = new PrototypeCostEstimator({
    defaults: config.costDefaults,
    loadCompletedCosts: (input) => deadline(loadCompletedCosts(input), timeoutMs).catch(() => []),
    now,
  });
  return async ({ modelId, spec, attachmentCount, req }) => {
    let balanceRemaining = null;
    const userId = req?.user?.id ?? req?.user?._id;
    if (userId != null) {
      try {
        const apiKey = await deadline(resolveCredential({ userId: String(userId) }), timeoutMs);
        const snapshot = await deadline(loadBalance({ apiKey, timeoutMs }), timeoutMs);
        if (typeof snapshot?.limit_remaining === 'number' && Number.isFinite(snapshot.limit_remaining)) {
          balanceRemaining = snapshot.limit_remaining;
        }
      } catch {
        // Credential and provider balance snapshots are advisory.
      }
    }
    return estimator.estimate({
      modelId,
      specLength: typeof spec === 'string' ? spec.length : 0,
      attachmentCount,
      balanceRemaining,
    });
  };
}

async function loadCompletedPrototypeCosts({ modelId }) {
  const mongoose = require('mongoose');
  if (!mongoose.models.PrototypeJob) return [];
  const rows = await mongoose.models.PrototypeJob.find(
    { modelId, status: 'completed', actualCostUsd: { $gte: 0 } },
    { actualCostUsd: 1 },
  )
    .sort({ completedAt: -1 })
    .limit(500)
    .lean();
  return rows.map((row) => row.actualCostUsd);
}

function resolvePrototypeGatewayBaseUrl(appConfig) {
  const endpoint = (appConfig?.endpoints?.custom ?? []).find(
    (entry) =>
      typeof entry?.baseURL === 'string' &&
      (String(entry.name).toLowerCase() === 'openrouter' ||
        entry.baseURL.toLowerCase().includes('openrouter')),
  );
  return endpoint?.baseURL ?? null;
}

module.exports = {
  createAdvisoryCostEstimator,
  loadCompletedPrototypeCosts,
  resolvePrototypeGatewayBaseUrl,
};
