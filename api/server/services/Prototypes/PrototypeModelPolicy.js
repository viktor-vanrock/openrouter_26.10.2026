function matchesGlob(value, glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function evaluateModel({ modelId, providerCapabilities, policy }) {
  const result = { policyVersion: policy.version };
  if ((policy.blockedPatterns ?? []).some((pattern) => matchesGlob(modelId, pattern))) {
    return { ...result, allowed: false, code: 'PROTOTYPE_MODEL_BLOCKED' };
  }
  if (policy.requireToolCalling === true && providerCapabilities?.toolCalling !== true) {
    return { ...result, allowed: false, code: 'PROTOTYPE_MODEL_UNSUPPORTED' };
  }
  const recommendedPatterns = policy.recommendedPatterns ?? [];
  const recommended = recommendedPatterns.length === 0 || recommendedPatterns.some((pattern) =>
    matchesGlob(modelId, pattern),
  );
  return {
    ...result,
    allowed: true,
    recommendation: recommended ? 'recommended' : 'not_recommended',
  };
}

function listRecommendedModels({ availableModelIds, policy }) {
  return [...new Set(availableModelIds)]
    .filter((modelId) =>
      (policy.recommendedPatterns ?? []).some((pattern) => matchesGlob(modelId, pattern)) &&
      !(policy.blockedPatterns ?? []).some((pattern) => matchesGlob(modelId, pattern)),
    )
    .sort();
}

module.exports = { evaluateModel, listRecommendedModels };
