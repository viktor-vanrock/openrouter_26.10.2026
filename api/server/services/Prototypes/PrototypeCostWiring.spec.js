const mongoose = require('mongoose');
const {
  createAdvisoryCostEstimator,
  loadCompletedPrototypeCosts,
} = require('./PrototypeCostWiring');

describe('Prototype advisory cost production seam', () => {
  it('uses validated defaults, model-scoped history and a bounded credential balance lookup', async () => {
    const loadCompletedCosts = jest.fn(async () => []);
    const resolveCredential = jest.fn(async () => 'synthetic-key');
    const loadBalance = jest.fn(async ({ apiKey, timeoutMs }) => {
      expect(apiKey).toBe('synthetic-key');
      expect(timeoutMs).toBe(250);
      return { limit_remaining: 0.75 };
    });
    const estimateCost = createAdvisoryCostEstimator({
      config: {
        costDefaults: {
          'fixed/model': { low: 0.1, likely: 0.5, high: 1 },
          '*': { low: 0.2, likely: 0.8, high: 2 },
        },
      },
      loadCompletedCosts,
      resolveCredential,
      loadBalance,
      timeoutMs: 250,
      now: () => new Date('2033-05-18T03:33:20.000Z').getTime(),
    });

    await expect(
      estimateCost({
        modelId: 'fixed/model',
        spec: 'prototype spec',
        attachmentCount: 2,
        req: { user: { id: 'user_1' } },
      }),
    ).resolves.toMatchObject({
      modelId: 'fixed/model',
      likely: 0.5,
      high: 1.2,
      balanceRemaining: 0.75,
    });
    expect(loadCompletedCosts).toHaveBeenCalledWith({
      modelId: 'fixed/model',
      specLength: 14,
      attachmentCount: 2,
    });
    expect(resolveCredential).toHaveBeenCalledWith({ userId: 'user_1' });
  });

  it('returns an estimate with unknown balance when credential or balance lookup fails', async () => {
    const estimateCost = createAdvisoryCostEstimator({
      config: { costDefaults: { '*': { low: 0.2, likely: 0.8, high: 2 } } },
      loadCompletedCosts: jest.fn(async () => []),
      resolveCredential: jest.fn(async () => {
        throw new Error('credential unavailable');
      }),
      loadBalance: jest.fn(),
      timeoutMs: 250,
    });

    await expect(
      estimateCost({
        modelId: 'unknown/model',
        spec: 'spec',
        attachmentCount: 0,
        req: { user: { id: 'user_1' } },
      }),
    ).resolves.toMatchObject({ modelId: 'unknown/model', balanceRemaining: null });
  });

  it('loads only completed history for the requested immutable model', async () => {
    const lean = jest.fn(async () => [{ actualCostUsd: 0.2 }, { actualCostUsd: 0.6 }]);
    const limit = jest.fn(() => ({ lean }));
    const sort = jest.fn(() => ({ limit }));
    const find = jest.fn(() => ({ sort }));
    const previous = mongoose.models.PrototypeJob;
    mongoose.models.PrototypeJob = { find };
    try {
      await expect(loadCompletedPrototypeCosts({ modelId: 'fixed/model' })).resolves.toEqual([
        0.2,
        0.6,
      ]);
      expect(find).toHaveBeenCalledWith(
        { modelId: 'fixed/model', status: 'completed', actualCostUsd: { $gte: 0 } },
        { actualCostUsd: 1 },
      );
    } finally {
      if (previous) mongoose.models.PrototypeJob = previous;
      else delete mongoose.models.PrototypeJob;
    }
  });

  it('falls back to admin defaults when model history is unavailable', async () => {
    const estimateCost = createAdvisoryCostEstimator({
      config: { costDefaults: { '*': { low: 0.2, likely: 0.8, high: 2 } } },
      loadCompletedCosts: jest.fn(async () => {
        throw new Error('history unavailable');
      }),
      resolveCredential: jest.fn(async () => 'synthetic-key'),
      loadBalance: jest.fn(async () => ({ limit_remaining: 4 })),
      timeoutMs: 250,
    });

    await expect(
      estimateCost({
        modelId: 'unknown/model',
        spec: 'spec',
        attachmentCount: 0,
        req: { user: { id: 'user_1' } },
      }),
    ).resolves.toMatchObject({
      method: 'admin_default',
      sampleSize: 0,
      likely: 0.8,
      high: 2.4,
      balanceRemaining: 4,
    });
  });

  it('selects the fixed OpenRouter gateway from trusted application config', () => {
    const { resolvePrototypeGatewayBaseUrl } = require('./PrototypeCostWiring');
    expect(resolvePrototypeGatewayBaseUrl({
      endpoints: {
        custom: [
          { name: 'Other', baseURL: 'https://other.invalid/v1' },
          { name: 'OpenRouter', baseURL: 'https://gateway.internal/v1' },
        ],
      },
    })).toBe('https://gateway.internal/v1');
    expect(resolvePrototypeGatewayBaseUrl({ endpoints: { custom: [] } })).toBeNull();
  });
});
