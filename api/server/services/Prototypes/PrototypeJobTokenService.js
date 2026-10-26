const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const AUDIENCE = 'prototype-model-proxy';
const SCOPES = ['models:invoke'];

function sameLease(lease, claims) {
  return (
    lease &&
    claims.userId != null && String(claims.userId).length > 0 &&
    typeof claims.tenantId === 'string' && claims.tenantId.length > 0 &&
    typeof claims.modelId === 'string' && claims.modelId.length > 0 &&
    String(lease.userId) === String(claims.userId) &&
    lease.tenantId === claims.tenantId &&
    lease.modelId === claims.modelId &&
    lease.jobId === claims.jobId &&
    lease.turnId === claims.turnId &&
    lease.commandId === claims.commandId &&
    lease.attemptId === claims.attemptId &&
    lease.executionId === claims.executionId &&
    lease.stage === claims.stage &&
    lease.fenceToken === claims.fenceToken &&
    lease.revision === claims.revision &&
    lease.leaseId === claims.leaseId
  );
}

class PrototypeJobTokenService {
  constructor({ issuer, privateKey, publicKeys, maxTtlMs = 45_000, now = Date.now, activeLease }) {
    this.issuer = issuer;
    this.privateKey = privateKey;
    this.publicKeys = publicKeys;
    this.maxTtlMs = maxTtlMs;
    this.now = now;
    this.activeLease = activeLease;
  }

  async issue(input) {
    const lease = await this.activeLease(input);
    if (!sameLease(lease, input)) throw new Error('Prototype execution has no active lease');
    const nowMs = this.now();
    const leaseExpiryMs = Math.min(
      new Date(input.leaseExpiresAt).getTime(),
      new Date(lease.leaseExpiresAt).getTime(),
    );
    const expiresAtMs = Math.min(leaseExpiryMs, nowMs + this.maxTtlMs);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      throw new Error('Prototype execution has no active lease');
    }
    return jwt.sign(
      {
        jobId: input.jobId,
        userId: String(input.userId),
        tenantId: input.tenantId,
        modelId: input.modelId,
        turnId: input.turnId,
        commandId: input.commandId,
        attemptId: input.attemptId,
        executionId: input.executionId,
        stage: input.stage,
        fenceToken: input.fenceToken,
        revision: input.revision,
        leaseId: input.leaseId,
        scopes: SCOPES,
        exp: Math.floor(expiresAtMs / 1000),
      },
      this.privateKey,
      {
        algorithm: 'RS256',
        issuer: this.issuer,
        audience: AUDIENCE,
        subject: String(input.userId),
        jwtid: crypto.randomUUID(),
        noTimestamp: true,
      },
    );
  }

  expiresAt(input, token) {
    const issued = token ? jwt.decode(token) : null;
    if (Number.isSafeInteger(issued?.exp)) return issued.exp * 1000;
    return Math.floor(Math.min(new Date(input.leaseExpiresAt).getTime(), this.now() + this.maxTtlMs) / 1000) * 1000;
  }

  async verify(token) {
    let lastError;
    for (const publicKey of this.publicKeys) {
      try {
        const claims = jwt.verify(token, publicKey, {
          algorithms: ['RS256'],
          issuer: this.issuer,
          audience: AUDIENCE,
          clockTimestamp: Math.floor(this.now() / 1000),
        });
        if (
          typeof claims !== 'object' ||
          claims.userId !== claims.sub ||
          claims.scopes?.length !== 1 ||
          claims.scopes[0] !== SCOPES[0]
        ) {
          throw new Error('Prototype token claims are invalid');
        }
        const lease = await this.activeLease(claims);
        const leaseExpiryMs = new Date(lease?.leaseExpiresAt).getTime();
        if (!sameLease(lease, claims) || !Number.isFinite(leaseExpiryMs) || leaseExpiryMs <= this.now()) {
          throw new Error('Prototype execution has no active lease');
        }
        return claims;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('Prototype token verification failed');
  }
}

module.exports = { PrototypeJobTokenService };
