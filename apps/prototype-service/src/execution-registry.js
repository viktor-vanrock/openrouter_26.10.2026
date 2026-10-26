const CLAIM_SCRIPT = `
local existing = redis.call('get', KEYS[1])
if existing then
  if existing == ARGV[1] then
    if redis.call('get', KEYS[2]) == ARGV[1] then return 3 end
    return 2
  end
  return 0
end
redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
return 1
`;

const MARK_SCHEDULED_SCRIPT = `
local existing = redis.call('get', KEYS[1])
if existing ~= ARGV[1] then return 0 end
local ttl = redis.call('pttl', KEYS[1])
if ttl <= 0 then return 0 end
redis.call('set', KEYS[2], ARGV[1], 'PX', ttl)
return 1
`;

export class RedisExecutionRegistry {
  constructor(redis, { minimumTtlMs = 60_000 } = {}) {
    this.redis = redis;
    this.minimumTtlMs = minimumTtlMs;
  }

  key(command) {
    return [
      'prototype:accepted',
      command.jobId,
      command.expectedRevision,
      command.attemptId,
      command.stage,
      command.fenceToken,
    ].join(':');
  }

  scheduledKey(command) {
    return `${this.key(command)}:scheduled`;
  }

  async claim(command, now = Date.now()) {
    const deadlineMs = new Date(command.deadlineAt).getTime();
    if (!Number.isFinite(deadlineMs) || deadlineMs <= now) {
      return { accepted: false, reason: 'deadline_expired' };
    }
    const ttlMs = Math.max(deadlineMs - now, this.minimumTtlMs);
    const result = Number(
      await this.redis.eval(
        CLAIM_SCRIPT,
        2,
        this.key(command),
        this.scheduledKey(command),
        command.executionId,
        ttlMs,
      ),
    );
    if (result === 0) return { accepted: false, reason: 'identity_conflict' };
    return { accepted: true, duplicate: result !== 1, scheduled: result === 3 };
  }

  async markScheduled(command) {
    return (
      Number(
        await this.redis.eval(
          MARK_SCHEDULED_SCRIPT,
          2,
          this.key(command),
          this.scheduledKey(command),
          command.executionId,
        ),
      ) === 1
    );
  }

  async isAccepted(command) {
    return (await this.redis.get(this.key(command))) === command.executionId;
  }
}
