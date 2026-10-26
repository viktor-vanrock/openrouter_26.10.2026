import { validateSourceManifest, verifySourceManifest } from './source-manifest.js';
import { deterministicLeaseId } from './stage-supervisor.js';
import { validateReactProject } from './react-project-policy.js';
export const GENERATION_ENGINES = Object.freeze(['direct-react-v1', 'opencode-fsd-v1']);

/** Strict common engine boundary; sandbox execution is supplied by the registered engine. */
export function validateGenerationInput(input) {
  const keys = [
    'engineId',
    'modelId',
    'command',
    'approvedPlan',
    'acceptedSource',
    'changeRequest',
    'selectedVariant',
    'pins',
    'limits',
  ];
  if (
    !input ||
    Object.keys(input).sort().join(',') !== keys.sort().join(',') ||
    !GENERATION_ENGINES.includes(input.engineId) ||
    input.modelId !== input.command?.modelId ||
    typeof input.approvedPlan?.text !== 'string' ||
    !input.approvedPlan.text.trim() ||
    input.approvedPlan.text.length > 50000 ||
    input.approvedPlan.approved !== true ||
    typeof input.changeRequest !== 'string' ||
    input.changeRequest.length > 50000 ||
    ![null, 'A', 'B'].includes(input.selectedVariant)
  )
    throw new Error('PROTOTYPE_GENERATION_INPUT_INVALID');
  deterministicLeaseId(input.command);
  if (
    !['tenantId', 'userId', 'modelId'].every(
      (key) => typeof input.command[key] === 'string' && input.command[key].trim(),
    ) ||
    Object.keys(input.approvedPlan).sort().join(',') !== 'approved,text' ||
    typeof input.acceptedSource !== 'object'
  )
    throw new Error('PROTOTYPE_GENERATION_INPUT_INVALID');
  if (input.command.stage !== 'generation' || input.command.pipelineStep !== 0)
    throw new Error('PROTOTYPE_GENERATION_INPUT_INVALID');
  if (input.acceptedSource) {
    validateSourceManifest(input.acceptedSource);
    if (
      input.acceptedSource.modelId !== input.modelId ||
      input.acceptedSource.engineId !== input.engineId ||
      input.acceptedSource.revision >= input.command.expectedRevision ||
      ['rulesDigest', 'templateDigest', 'toolchainDigest'].some(
        (key) => input.acceptedSource[key] !== input.pins?.[key],
      )
    ) {
      throw new Error('PROTOTYPE_GENERATION_SOURCE_CONFLICT');
    }
  }
  for (const pin of ['rulesDigest', 'templateDigest', 'toolchainDigest']) {
    if (!/^sha256:[a-f0-9]{64}$/.test(input.pins?.[pin] ?? ''))
      throw new Error('PROTOTYPE_GENERATION_INPUT_INVALID');
  }
  const limits = input.limits;
  if (
    !limits ||
    Object.keys(limits).sort().join(',') !==
      ['maxCostUsd', 'maxRequests', 'maxTools', 'maxRepairs', 'activeTimeoutMs'].sort().join(',') ||
    Object.keys(input.pins).sort().join(',') !==
      ['rulesDigest', 'templateDigest', 'toolchainDigest'].sort().join(',') ||
    typeof limits.maxCostUsd !== 'number' ||
    !Number.isFinite(limits.maxCostUsd) ||
    limits.maxCostUsd <= 0 ||
    limits.maxCostUsd > 2 ||
    !Number.isSafeInteger(limits.maxRequests) ||
    limits.maxRequests < 1 ||
    limits.maxRequests > 8 ||
    !Number.isSafeInteger(limits.maxTools) ||
    limits.maxTools < 1 ||
    limits.maxTools > 100 ||
    !Number.isSafeInteger(limits.maxRepairs) ||
    limits.maxRepairs < 0 ||
    limits.maxRepairs > 2 ||
    !Number.isSafeInteger(limits.activeTimeoutMs) ||
    limits.activeTimeoutMs < 1 ||
    limits.activeTimeoutMs > 600000
  ) {
    throw new Error('PROTOTYPE_GENERATION_LIMITS_INVALID');
  }
  return input;
}
export async function generateCandidate({ input, engines }) {
  validateGenerationInput(input);
  const engine = engines[input.engineId];
  if (typeof engine?.generate !== 'function')
    throw new Error('PROTOTYPE_GENERATION_ENGINE_UNAVAILABLE');
  const result = await engine.generate(input);
  verifySourceManifest(result.manifest, result.sources);
  if (
    result.manifest.engineId !== input.engineId ||
    result.manifest.modelId !== input.modelId ||
    result.manifest.revision !== input.command.expectedRevision ||
    ['rulesDigest', 'templateDigest', 'toolchainDigest'].some(
      (key) => result.manifest[key] !== input.pins[key],
    )
  ) {
    throw new Error('PROTOTYPE_GENERATION_RESULT_CONFLICT');
  }
  if (input.engineId === 'opencode-fsd-v1') validateReactProject(result.sources);
  return result;
}
