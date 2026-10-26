const CLAIM_SCRIPT = `
local expired = redis.call('zrangebyscore', KEYS[5], '-inf', ARGV[5])
for _, claimKey in ipairs(expired) do
  local raw = redis.call('get', claimKey)
  if raw then
    local claim = cjson.decode(raw)
    for _, counterKey in ipairs(claim.counters) do
      local next = tonumber(redis.call('decr', counterKey))
      if next <= 0 then redis.call('del', counterKey) end
    end
    redis.call('del', claimKey)
  end
  redis.call('zrem', KEYS[5], claimKey)
end
local existing = redis.call('get', KEYS[1])
if existing then
  local claim = cjson.decode(existing)
  if claim.identity == ARGV[1] then return {2, 'duplicate'} end
  return {0, 'identity_conflict'}
end
local counts = {
  tonumber(redis.call('get', KEYS[2]) or '0'),
  tonumber(redis.call('get', KEYS[3]) or '0'),
  tonumber(redis.call('get', KEYS[4]) or '0')
}
local limits = { tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]) }
local names = { 'global', 'tenant', 'user' }
for index = 1, 3 do
  if counts[index] >= limits[index] then return {0, names[index]} end
end
local claim = cjson.encode({ identity = ARGV[1], counters = { KEYS[2], KEYS[3], KEYS[4] } })
redis.call('set', KEYS[1], claim)
redis.call('zadd', KEYS[5], ARGV[6], KEYS[1])
redis.call('incr', KEYS[2])
redis.call('incr', KEYS[3])
redis.call('incr', KEYS[4])
return {1, 'accepted'}
`;

const RELEASE_SCRIPT = `
local raw = redis.call('get', KEYS[1])
if not raw then return 2 end
local claim = cjson.decode(raw)
if claim.identity ~= ARGV[1] then return 0 end
for _, counterKey in ipairs(claim.counters) do
  local next = tonumber(redis.call('decr', counterKey))
  if next <= 0 then redis.call('del', counterKey) end
end
redis.call('del', KEYS[1])
redis.call('zrem', KEYS[2], KEYS[1])
return 1
`;

function safe(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export class RedisConcurrencyQuota {
  constructor(redis, limits, now = Date.now) {
    this.redis = redis;
    this.limits = limits;
    this.now = now;
    for (const key of ['global', 'tenant', 'user']) {
      if (!Number.isSafeInteger(limits?.[key]) || limits[key] < 1) {
        throw new Error(`Prototype ${key} concurrency limit is invalid`);
      }
    }
  }

  keys(command) {
    const tenantId = safe(command.tenantId, 'tenantId');
    const userId = safe(command.userId, 'userId');
    const executionId = safe(command.executionId, 'executionId');
    return {
      claim: `prototype:quota:claim:${tenantId}:${userId}:${executionId}`,
      global: 'prototype:quota:active:global',
      tenant: `prototype:quota:active:tenant:${tenantId}`,
      user: `prototype:quota:active:user:${tenantId}:${userId}`,
      expirations: 'prototype:quota:expirations',
    };
  }

  identity(command) {
    return [command.jobId, command.attemptId, command.executionId, command.fenceToken]
      .map((value) => safe(String(value), 'quota identity'))
      .join(':');
  }

  async claim(command) {
    const deadline = new Date(command.deadlineAt).getTime();
    const now = this.now();
    if (!Number.isFinite(deadline) || deadline <= now)
      return { accepted: false, reason: 'deadline_expired' };
    const keys = this.keys(command);
    const result = await this.redis.eval(
      CLAIM_SCRIPT,
      5,
      keys.claim,
      keys.global,
      keys.tenant,
      keys.user,
      keys.expirations,
      this.identity(command),
      this.limits.global,
      this.limits.tenant,
      this.limits.user,
      now,
      deadline,
    );
    const status = Number(result?.[0]);
    if (status === 0)
      return { accepted: false, reason: `${result?.[1] ?? 'unknown'}_quota_exceeded` };
    return { accepted: true, duplicate: status === 2 };
  }

  async release(command) {
    const keys = this.keys(command);
    const result = Number(
      await this.redis.eval(
        RELEASE_SCRIPT,
        2,
        keys.claim,
        keys.expirations,
        this.identity(command),
      ),
    );
    if (result === 0) return { released: false, reason: 'identity_conflict' };
    return { released: true, duplicate: result === 2 };
  }
}
