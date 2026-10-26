const { generateKeyPairSync } = require('crypto');
const { PrototypeJobTokenService } = require('./PrototypeJobTokenService');

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rotatedKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

function createService(overrides = {}) {
  let now = 2_000_000_000_000;
  const activeLease = jest.fn(async () => ({
    jobId: 'job_1',
    userId: 'user_1', tenantId: 'tenant_1', modelId: 'openai/gpt-5-codex',
    turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
    executionId: 'execution_1',
    stage: 'generation', fenceToken: 2,
    revision: 4,
    leaseId: 'lease_1',
    leaseExpiresAt: new Date(now + 30_000),
  }));
  const service = new PrototypeJobTokenService({
    issuer: 'librechat-prototype-control',
    privateKey: keyPair.privateKey,
    publicKeys: [keyPair.publicKey],
    maxTtlMs: 45_000,
    now: () => now,
    activeLease,
    ...overrides,
  });
  return { service, activeLease, advance(ms) { now += ms; } };
}

const issueInput = {
  jobId: 'job_1',
  userId: 'user_1',
  tenantId: 'tenant_1',
  modelId: 'openai/gpt-5-codex',
  turnId: 'turn_1',
  commandId: 'command_1',
  attemptId: 'attempt_1',
  executionId: 'execution_1',
  stage: 'generation',
  fenceToken: 2,
  revision: 4,
  leaseId: 'lease_1',
  leaseExpiresAt: new Date(2_000_000_030_000),
};

describe('PrototypeJobTokenService', () => {
  it('issues and verifies an execution-scoped token bounded by the lease', async () => {
    const { service } = createService();
    const token = await service.issue(issueInput);

    await expect(service.verify(token)).resolves.toMatchObject({
      iss: 'librechat-prototype-control',
      aud: 'prototype-model-proxy',
      jobId: 'job_1',
      sub: 'user_1',
      userId: 'user_1',
      tenantId: 'tenant_1',
      modelId: 'openai/gpt-5-codex',
      turnId: 'turn_1',
      commandId: 'command_1',
      attemptId: 'attempt_1',
      executionId: 'execution_1',
      stage: 'generation',
      fenceToken: 2,
      revision: 4,
      leaseId: 'lease_1',
      scopes: ['models:invoke'],
      jti: expect.any(String),
      exp: 2_000_000_030,
    });
  });

  it.each([
    ['stale execution', { executionId: 'execution_old' }],
    ['stale attempt', { attemptId: 'attempt_old' }],
    ['stale fence', { fenceToken: 1 }],
    ['stale revision', { revision: 3 }],
    ['revoked lease', { leaseId: 'lease_old' }],
    ['wrong owner', { userId: 'user_other' }],
    ['wrong tenant', { tenantId: 'tenant_other' }],
    ['wrong model', { modelId: 'unselected/model' }],
  ])('rejects issue for %s', async (_name, patch) => {
    const { service } = createService();
    await expect(service.issue({ ...issueInput, ...patch })).rejects.toThrow('active lease');
  });

  it('rejects expiry and a token signed by an untrusted rotated key', async () => {
    const current = createService();
    const token = await current.service.issue(issueInput);
    current.advance(31_000);
    await expect(current.service.verify(token)).rejects.toThrow();

    const rotated = createService({
      privateKey: rotatedKeyPair.privateKey,
      publicKeys: [rotatedKeyPair.publicKey],
    });
    await expect(rotated.service.verify(token)).rejects.toThrow();
  });

  it('rejects a token after its lease is revoked server-side', async () => {
    const activeLease = jest.fn()
      .mockResolvedValueOnce({
        jobId: 'job_1', turnId: 'turn_1', commandId: 'command_1', attemptId: 'attempt_1',
        userId: 'user_1', tenantId: 'tenant_1', modelId: 'openai/gpt-5-codex',
        executionId: 'execution_1', stage: 'generation', fenceToken: 2,
        revision: 4, leaseId: 'lease_1',
        leaseExpiresAt: issueInput.leaseExpiresAt,
      })
      .mockResolvedValueOnce(null);
    const { service } = createService({ activeLease });
    const token = await service.issue(issueInput);

    await expect(service.verify(token)).rejects.toThrow('active lease');
  });

  it('accepts a token signed before a trusted signing-key rotation', async () => {
    const current = createService();
    const token = await current.service.issue(issueInput);
    const rotated = createService({
      privateKey: rotatedKeyPair.privateKey,
      publicKeys: [rotatedKeyPair.publicKey, keyPair.publicKey],
    });

    await expect(rotated.service.verify(token)).resolves.toMatchObject({ jobId: 'job_1' });
  });
  it('denies a still-signed token when trusted model/owner/lease expiry changes', async () => {
    for (const patch of [{ userId: 'another-owner' }, { modelId: 'another-model' },
      { tenantId: 'another-tenant' }, { leaseExpiresAt: new Date(0) }]) {
      const current = createService();
      const token = await current.service.issue(issueInput);
      current.activeLease.mockResolvedValue({ ...issueInput, ...patch });
      await expect(current.service.verify(token)).rejects.toThrow('active lease');
    }
  });
});
