import { RedisPrototypeCommandSource, RedisPrototypeCommandSourceV2 } from './streams';

const command = {
  schemaVersion: 1,
  commandId: 'command_1',
  kind: 'start_turn',
  jobId: 'job_1',
  turnId: 'turn_1',
  tenantId: 'tenant_1',
  modelId: 'fake/model',
  expectedRevision: 1,
  executionId: 'execution_1',
  checkpointRevision: null,
  attachmentManifest: [],
  createdAt: '2026-09-24T10:00:00.000Z',
};

describe('RedisPrototypeCommandSource', () => {
  it('reclaims a stale pending command before reading a new one', async () => {
    const redis = {
      xgroup: jest.fn(async () => 'OK'),
      xautoclaim: jest.fn(async () => [
        '0-0',
        [['1-0', ['command', JSON.stringify(command)]]],
      ]),
      xreadgroup: jest.fn(),
    };
    const source = new RedisPrototypeCommandSource(redis, 'worker-a');
    await source.ensureGroup();
    await expect(source.next()).resolves.toEqual({ streamId: '1-0', command });
    expect(redis.xreadgroup).not.toHaveBeenCalled();
  });

  it('reads and acknowledges strict v2 commands on the isolated stream', async () => {
    const v2 = {
      schemaVersion: 2, commandId: 'command_2', kind: 'execute_stage', jobId: 'job_1',
      turnId: 'turn_1', tenantId: 'tenant_1', userId: 'user_1', modelId: 'fake/model', expectedRevision: 2,
      attemptId: 'attempt_1', executionId: 'execution_2', stage: 'generation', fenceToken: 3,
      checkpoint: null, sourceDigest: null,
      budget: { currency: 'USD', maxCostUsd: 1, maxRequests: 4, maxInputTokens: null, maxOutputTokens: null },
      createdAt: '2026-09-24T10:00:00.000Z', deadlineAt: '2026-09-24T10:10:00.000Z',
    };
    const redis = {
      xautoclaim: jest.fn(async () => ['0-0', []]),
      xreadgroup: jest.fn(async () => [[
        'prototype.commands.v2', [['2-0', ['command', JSON.stringify(v2)]]],
      ]]),
      xack: jest.fn(async () => 1),
    };
    const source = new RedisPrototypeCommandSourceV2(redis, 'service-a');
    await expect(source.next()).resolves.toEqual({ streamId: '2-0', command: v2 });
    await source.acknowledge('2-0');
    expect(redis.xack).toHaveBeenCalledWith('prototype.commands.v2', 'prototype-workers', '2-0');
  });

  it('reads a new group entry after reclaim has no pending work', async () => {
    const redis = {
      xautoclaim: jest.fn(async () => ['0-0', []]),
      xreadgroup: jest.fn(async () => [[
        'prototype.commands.v1',
        [['2-0', ['command', JSON.stringify(command)]]],
      ]]),
    };
    const source = new RedisPrototypeCommandSource(redis, 'worker-a', { blockMs: 25 });
    await expect(source.next()).resolves.toEqual({ streamId: '2-0', command });
    expect(redis.xreadgroup).toHaveBeenCalledWith(
      'GROUP', 'prototype-workers', 'worker-a', 'COUNT', 1, 'BLOCK', 25,
      'STREAMS', 'prototype.commands.v1', '>',
    );
  });

  it('stops returning work after close', async () => {
    const redis = { xautoclaim: jest.fn(), xreadgroup: jest.fn() };
    const source = new RedisPrototypeCommandSource(redis, 'worker-a');
    await source.close();
    await expect(source.next()).resolves.toBeNull();
    expect(redis.xautoclaim).not.toHaveBeenCalled();
  });
});
