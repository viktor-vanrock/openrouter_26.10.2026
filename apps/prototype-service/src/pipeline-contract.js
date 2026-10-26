import { createHash } from 'node:crypto';
import { verifySourceManifest } from './source-manifest.js';
import { validateReactProject } from './react-project-policy.js';

export const PIPELINE_PROFILE = 'offline-prototype-v1';
export const REACT_BUILD_PROFILE = 'offline-react-build-v1';
export const REACT_FSD_BUILD_PROFILE = 'offline-react-fsd-build-v1';
export const MAX_INPUT_BYTES = 220_000;
export const MAX_RESULT_BYTES = 4_000_000;
export const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function validatePipelineInput(input) {
  if (input?.validation != null && input.validation !== 'browser')
    throw new Error('PIPELINE_INPUT_INVALID');
  const validation = input.validation === 'browser' ? { validation: 'browser' } : {};
  if (input?.profile === REACT_FSD_BUILD_PROFILE) {
    if (
      Object.keys(input)
        .filter((key) => key !== 'validation')
        .sort()
        .join(',') !==
        ['executionId', 'profile', 'format', 'sourceManifest', 'sources'].sort().join(',') ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(input.executionId ?? '') ||
      input.format !== 'react' ||
      input.sourceManifest?.engineId !== 'opencode-fsd-v1' ||
      Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024
    ) {
      throw new Error('PIPELINE_INPUT_INVALID');
    }
    verifySourceManifest(input.sourceManifest, input.sources);
    validateReactProject(input.sources);
    return {
      executionId: input.executionId,
      profile: input.profile,
      format: input.format,
      ...validation,
      sourceManifest: input.sourceManifest,
      sources: Object.fromEntries(
        Object.entries(input.sources).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    };
  }
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !['executionId', 'profile', 'format', 'source', 'validation'].includes(key),
    ) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(input.executionId ?? '') ||
    ![PIPELINE_PROFILE, REACT_BUILD_PROFILE].includes(input.profile) ||
    !['html', 'react'].includes(input.format) ||
    (input.profile === REACT_BUILD_PROFILE && input.format !== 'react') ||
    typeof input.source !== 'string' ||
    !input.source.trim() ||
    Buffer.byteLength(input.source) > 200_000
  ) {
    throw new Error('PIPELINE_INPUT_INVALID');
  }
  return {
    executionId: input.executionId,
    profile: input.profile,
    format: input.format,
    source: input.source,
    ...validation,
  };
}

export function pipelineIdentity(input) {
  const canonical = validatePipelineInput(input);
  return {
    name: `run-${digest(canonical.executionId).slice(7, 39)}`,
    inputDigest: digest(JSON.stringify(canonical)),
  };
}

export function decodePipelineResult(input, value) {
  const { inputDigest } = pipelineIdentity(input);
  if (
    value?.executionId !== input.executionId ||
    value?.inputDigest !== inputDigest ||
    value?.profile !== input.profile ||
    !value.artifacts ||
    Object.keys(value.artifacts).sort().join(',') !== 'html,qaEvidence,sourcesZip'
  ) {
    throw new Error('PIPELINE_RESULT_INVALID');
  }
  const result = { digests: {} };
  for (const key of ['html', 'sourcesZip', 'qaEvidence']) {
    const item = value.artifacts[key];
    const itemLimit =
      input.profile === REACT_FSD_BUILD_PROFILE
        ? key === 'html'
          ? 4 * 1024 * 1024
          : key === 'sourcesZip'
            ? 7 * 1024 * 1024
            : 128 * 1024
        : MAX_RESULT_BYTES;
    if (
      typeof item?.base64 !== 'string' ||
      item.base64.length > itemLimit ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.base64)
    ) {
      throw new Error('PIPELINE_RESULT_INVALID');
    }
    const bytes = Buffer.from(item.base64, 'base64');
    if (!bytes.length || digest(bytes) !== item.digest)
      throw new Error('PIPELINE_RESULT_DIGEST_INVALID');
    result[key] = bytes;
    result.digests[key] = item.digest;
  }
  const qa = JSON.parse(result.qaEvidence);
  const react = [REACT_BUILD_PROFILE, REACT_FSD_BUILD_PROFILE].includes(input.profile);
  const buildOnly = react && input.validation !== 'browser';
  const requiredChecks = react
    ? [
        'type-check',
        'lint',
        'build',
        ...(buildOnly ? [] : ['meaningful-body', 'preview-iframe', 'desktop', 'mobile']),
      ]
    : ['meaningful-body'];
  if (
    qa.passed !== true ||
    !requiredChecks.every((check) => qa.checks?.includes(check)) ||
    (buildOnly &&
      (qa.validation !== 'build-only' ||
        qa.browserQaPerformed !== false ||
        qa.format !== 'react' ||
        qa.executionId !== input.executionId ||
        qa.profile !== input.profile)) ||
    (react &&
      !buildOnly &&
      (qa.validation !== 'browser' ||
        qa.browserQaPerformed !== true ||
        qa.format !== 'react' ||
        qa.executionId !== input.executionId ||
        qa.profile !== input.profile)) ||
    qa.consoleErrors?.length ||
    qa.networkRequests?.length
  )
    throw new Error('PIPELINE_QA_FAILED');
  if (
    input.profile === REACT_FSD_BUILD_PROFILE &&
    (qa.sourceManifestDigest !== input.sourceManifest.digest ||
      qa.rulesDigest !== input.sourceManifest.rulesDigest ||
      qa.templateDigest !== input.sourceManifest.templateDigest ||
      qa.toolchainDigest !== input.sourceManifest.toolchainDigest)
  ) {
    throw new Error('PIPELINE_QA_FAILED');
  }
  return result;
}
