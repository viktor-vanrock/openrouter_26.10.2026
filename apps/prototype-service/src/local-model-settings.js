export function localModelLimitUsd() {
  const production = process.env.NODE_ENV === 'production';
  const fallback = production ? 2 : 10;
  const value = Number(process.env.PROTOTYPE_LOCAL_TURN_LIMIT_USD ?? fallback);
  if (production && !(Number.isFinite(value) && value > 0 && value <= 2))
    throw new Error('PROTOTYPE_TURN_BUDGET_INVALID');
  return Number.isFinite(value) && value > 0 && value <= 1000 ? value : fallback;
}

export function localModelTimeoutMs() {
  const value = Number(process.env.PROTOTYPE_LOCAL_MODEL_TIMEOUT_MS ?? 300000);
  return Number.isSafeInteger(value) && value >= 10000 && value <= 900000 ? value : 300000;
}
