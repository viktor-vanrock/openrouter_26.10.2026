const RESERVE_SCRIPT = `
local expired = redis.call('zrangebyscore', KEYS[5], '-inf', ARGV[4])
for _, key in ipairs(expired) do
  local expiredAmount = redis.call('get', key)
  if expiredAmount then
    local remaining = tonumber(redis.call('incrbyfloat', KEYS[3], -tonumber(expiredAmount)))
    if remaining < 0.000001 then redis.call('set', KEYS[3], '0') end
    -- The upstream may already have billed this request. Retain its worst-case
    -- charge and mark the identity settled, even if no usage report arrived.
    local settledKey = string.gsub(key, ':reservation:', ':settled:')
    redis.call('set', settledKey, expiredAmount, 'PX', ARGV[5], 'NX')
    redis.call('del', key)
  end
  redis.call('zrem', KEYS[5], key)
end
if redis.call('get', KEYS[4]) then return {4, redis.call('get', KEYS[4])} end
local current = redis.call('get', KEYS[1])
if current then
  if tonumber(current) == tonumber(ARGV[1]) then return {2, current} end
  return {3, current}
end
local spent = tonumber(redis.call('get', KEYS[2]) or '0')
local reserved = tonumber(redis.call('get', KEYS[3]) or '0')
local amount = tonumber(ARGV[1])
local ceiling = tonumber(ARGV[2])
if spent + amount > ceiling then return {0, tostring(spent)} end
local requests = tonumber(redis.call('get', KEYS[6]) or '0')
if requests >= tonumber(ARGV[6]) then return {6, tostring(requests)} end
redis.call('set', KEYS[1], ARGV[1], 'NX')
redis.call('zadd', KEYS[5], tonumber(ARGV[4]) + tonumber(ARGV[3]), KEYS[1])
redis.call('incrbyfloat', KEYS[3], ARGV[1])
redis.call('incrbyfloat', KEYS[2], ARGV[1])
redis.call('incr', KEYS[6])
return {1, ARGV[1]}
`;

const SETTLE_SCRIPT = `
local expired = redis.call('zrangebyscore', KEYS[5], '-inf', ARGV[3])
for _, key in ipairs(expired) do
  local expiredAmount = redis.call('get', key)
  if expiredAmount then
    local remaining = tonumber(redis.call('incrbyfloat', KEYS[3], -tonumber(expiredAmount)))
    if remaining < 0.000001 then redis.call('set', KEYS[3], '0') end
    local settledKey = string.gsub(key, ':reservation:', ':settled:')
    redis.call('set', settledKey, expiredAmount, 'PX', ARGV[2], 'NX')
    redis.call('del', key)
  end
  redis.call('zrem', KEYS[5], key)
end
local reservation = redis.call('get', KEYS[1])
if not reservation then
  local settled = redis.call('get', KEYS[4])
  if settled then
    if tonumber(settled) == tonumber(ARGV[1]) then return {2, settled} end
    return {3, settled}
  end
  return {0, 'missing'}
end
local amount = tonumber(reservation)
local actual = tonumber(ARGV[1])
local remaining = tonumber(redis.call('incrbyfloat', KEYS[3], -amount))
if remaining < 0.000001 then redis.call('set', KEYS[3], '0') end
redis.call('incrbyfloat', KEYS[2], actual - amount)
redis.call('set', KEYS[4], ARGV[1], 'PX', ARGV[2], 'NX')
redis.call('zrem', KEYS[5], KEYS[1])
redis.call('del', KEYS[1])
if actual > amount then return {5, ARGV[1]} end
return {1, ARGV[1]}
`;

function money(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite amount`);
  }
  return (Math.ceil(value * 1_000_000) / 1_000_000).toFixed(6);
}

function safeId(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,256}$/.test(value)) {
    throw new Error(`${name} must be a safe non-empty identifier`);
  }
  return value;
}

export class RedisBudgetLedger {
  constructor(
    redis,
    { reservationTtlMs = 120_000, settlementTtlMs = 86_400_000, now = Date.now } = {},
  ) {
    this.redis = redis;
    this.reservationTtlMs = reservationTtlMs;
    this.settlementTtlMs = settlementTtlMs;
    this.now = now;
  }

  keys(scope, reservationId) {
    const prefix = `prototype:budget:${safeId(scope?.tenantId, 'tenantId')}:${safeId(scope?.userId, 'userId')}:${safeId(scope?.jobId, 'jobId')}:${safeId(scope?.turnId, 'turnId')}`;
    safeId(reservationId, 'reservationId');
    return {
      reservation: `${prefix}:reservation:${reservationId}`,
      spent: `${prefix}:spent`,
      reserved: `${prefix}:reserved`,
      settled: `${prefix}:settled:${reservationId}`,
      expirations: `${prefix}:reservation-expirations`,
      requests: `${prefix}:requests`,
    };
  }

  async reserve(scope, { reservationId, amountUsd, ceilingUsd, maxRequests }) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
      throw new Error('maxRequests must be a positive finite integer');
    }
    const keys = this.keys(scope, reservationId);
    const result = await this.redis.eval(
      RESERVE_SCRIPT,
      6,
      keys.reservation,
      keys.spent,
      keys.reserved,
      keys.settled,
      keys.expirations,
      keys.requests,
      money(amountUsd, 'amountUsd'),
      money(ceilingUsd, 'ceilingUsd'),
      this.reservationTtlMs,
      this.now(),
      this.settlementTtlMs,
      maxRequests,
    );
    const status = Number(result?.[0]);
    if (status === 0) return { accepted: false, reason: 'budget_exceeded' };
    if (status === 3) return { accepted: false, reason: 'reservation_conflict' };
    if (status === 4) return { accepted: false, reason: 'reservation_settled' };
    if (status === 6) return { accepted: false, reason: 'request_limit_exceeded' };
    return { accepted: true, duplicate: status === 2, reservedUsd: Number(result[1]) };
  }

  async settle(scope, { reservationId, actualCostUsd }) {
    const keys = this.keys(scope, reservationId);
    const result = await this.redis.eval(
      SETTLE_SCRIPT,
      5,
      keys.reservation,
      keys.spent,
      keys.reserved,
      keys.settled,
      keys.expirations,
      money(actualCostUsd, 'actualCostUsd'),
      this.settlementTtlMs,
      this.now(),
    );
    const status = Number(result?.[0]);
    if (status === 0) return { settled: false, reason: 'reservation_missing' };
    if (status === 3) return { settled: false, reason: 'settlement_conflict' };
    if (status === 5) return { settled: false, reason: 'reservation_exceeded' };
    return { settled: true, duplicate: status === 2, actualCostUsd: Number(result[1]) };
  }
}
