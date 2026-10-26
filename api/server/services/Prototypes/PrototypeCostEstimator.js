function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function classifyBalance({ balanceRemaining, estimate }) {
  if (typeof balanceRemaining !== 'number' || !Number.isFinite(balanceRemaining)) return 'unknown';
  if (balanceRemaining < estimate.likely) return 'likely_insufficient';
  if (balanceRemaining < estimate.high) return 'possibly_insufficient';
  return 'sufficient';
}

class PrototypeCostEstimator {
  constructor({ defaults, loadCompletedCosts, now = Date.now }) {
    this.defaults = defaults;
    this.loadCompletedCosts = loadCompletedCosts;
    this.now = now;
  }

  async estimate({ modelId, specLength, attachmentCount, balanceRemaining = null }) {
    const rawCosts = await this.loadCompletedCosts({ modelId, specLength, attachmentCount });
    const costs = rawCosts
      .filter((cost) => typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
      .sort((left, right) => left - right);
    const configured = this.defaults[modelId] ?? this.defaults['*'];
    if (!configured) throw new Error('Prototype cost defaults are unavailable');
    const historical = costs.length >= 30;
    const low = historical ? costs[0] : configured.low;
    const likely = historical ? quantile(costs, 0.5) : configured.likely;
    const highBeforeBuffer = historical ? quantile(costs, 0.9) : configured.high;
    return {
      currency: 'USD',
      low,
      likely,
      high: highBeforeBuffer * 1.2,
      recoveryBufferPercent: 20,
      method: historical ? 'historical_quantiles' : 'admin_default',
      sampleSize: costs.length,
      modelId,
      calculatedAt: new Date(this.now()),
      balanceRemaining,
    };
  }
}

module.exports = { PrototypeCostEstimator, classifyBalance };
