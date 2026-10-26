const { PrototypeCostEstimator, classifyBalance } = require('./PrototypeCostEstimator');

const defaults = {
  'fixed/model': { low: 1, likely: 2, high: 4 },
  '*': { low: 2, likely: 3, high: 5 },
};

describe('PrototypeCostEstimator', () => {
  it('uses model defaults and includes the recovery buffer', async () => {
    const estimator = new PrototypeCostEstimator({ defaults, loadCompletedCosts: jest.fn(async () => []) });
    await expect(estimator.estimate({ modelId: 'fixed/model', specLength: 100, attachmentCount: 0 }))
      .resolves.toMatchObject({
        currency: 'USD', low: 1, likely: 2, high: 4.8,
        recoveryBufferPercent: 20, method: 'admin_default', sampleSize: 0,
        modelId: 'fixed/model',
      });
  });

  it('uses per-model historical P50/P90 only after 30 completed jobs', async () => {
    const costs = Array.from({ length: 30 }, (_value, index) => index + 1);
    const loadCompletedCosts = jest.fn(async () => costs);
    const estimator = new PrototypeCostEstimator({ defaults, loadCompletedCosts });
    await expect(estimator.estimate({ modelId: 'fixed/model', specLength: 100, attachmentCount: 1 }))
      .resolves.toMatchObject({
        low: 1, likely: 15.5, high: 32.52,
        method: 'historical_quantiles', sampleSize: 30, modelId: 'fixed/model',
      });
    expect(loadCompletedCosts).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'fixed/model' }));
  });

  it('falls back for an unknown model or an insufficient history sample', async () => {
    const estimator = new PrototypeCostEstimator({
      defaults,
      loadCompletedCosts: jest.fn(async () => Array.from({ length: 29 }, () => 1)),
    });
    await expect(estimator.estimate({ modelId: 'unknown/model', specLength: 1, attachmentCount: 0 }))
      .resolves.toMatchObject({ low: 2, likely: 3, high: 6, method: 'admin_default', sampleSize: 29 });
  });

  it.each([
    [null, 'unknown'],
    [1, 'likely_insufficient'],
    [3, 'possibly_insufficient'],
    [5, 'sufficient'],
  ])('classifies balance %s as %s', (balanceRemaining, expected) => {
    expect(classifyBalance({
      balanceRemaining,
      estimate: { likely: 2, high: 4 },
    })).toBe(expected);
  });
});
