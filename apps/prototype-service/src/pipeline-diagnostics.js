export function safeDiagnostics(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => typeof value === 'string')
    .slice(0, 8)
    .map((value) =>
      value
        // eslint-disable-next-line no-control-regex -- Remove terminal escapes from untrusted diagnostics.
        .replace(/\x1b\[[0-9;]*m/g, '')
        // eslint-disable-next-line no-control-regex -- Remove non-printable controls before log serialization.
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .replace(
          /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
          '<REDACTED>',
        )
        .replace(/\b(?:https?|mongodb(?:\+srv)?|redis(?:s)?):\/\/[^\s<>"']+/gi, '<url>')
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<REDACTED>')
        .replace(/Bearer\s+\S+|sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{12,}/gi, '<REDACTED>')
        .replace(
          /\b([A-Za-z0-9_]{0,100}(?:token|api[_-]?key|secret|password|creds_key|creds_iv)[A-Za-z0-9_]{0,100}["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
          '$1<REDACTED>',
        )
        .replace(
          /((?:api[_-]?key|authorization|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
          '$1<REDACTED>',
        )
        .replace(/\/(?:Users|home|workspace|tmp|private|var|run)\/[^\s:'"),]+/g, '<path>')
        .replace(/authorization|credential|api[_-]?key|signed.?url|object.?key/gi, '<REDACTED>')
        .slice(0, 4000),
    )
    .filter(Boolean);
}

export function pipelineFailure(error) {
  return {
    code: /^PROTOTYPE_[A-Z_]+$|^PIPELINE_[A-Z_]+$/.test(error?.message ?? '')
      ? error.message
      : 'PIPELINE_EXECUTION_FAILED',
    diagnostics: safeDiagnostics(error?.diagnostics),
  };
}

export function failureFromLog(log) {
  const marker = 'PROTOTYPE_PIPELINE_FAILURE=';
  const line = String(log)
    .split('\n')
    .findLast((value) => value.startsWith(marker));
  if (!line || line.length > 40000) return { code: 'PIPELINE_EXECUTION_FAILED', diagnostics: [] };
  try {
    const value = JSON.parse(line.slice(marker.length));
    return pipelineFailure({ message: value.code, diagnostics: value.diagnostics });
  } catch {
    return { code: 'PIPELINE_EXECUTION_FAILED', diagnostics: [] };
  }
}
