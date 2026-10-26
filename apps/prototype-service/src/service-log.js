import { safeDiagnostics } from './pipeline-diagnostics.js';

const textFields = [
  'jobId',
  'turnId',
  'commandId',
  'executionId',
  'attemptId',
  'modelId',
  'tenantId',
  'userId',
  'conversationId',
  'stage',
  'code',
  'reason',
  'dependency',
  'errorType',
  'sandboxId',
  'sessionId',
  'state',
  'stream',
  'line',
  'engine',
  'cleanup',
  'purpose',
  'finishReason',
  'sourceDigest',
  'method',
  'operation',
  'gatewayCode',
];
const numberFields = [
  'elapsedMs',
  'expectedRevision',
  'fenceToken',
  'upperCostUsd',
  'actualCostUsd',
  'inputTokens',
  'outputTokens',
  'maxOutputTokens',
  'httpStatus',
  'sourceBytes',
  'lineNumber',
  'columnNumber',
  'diagnosticCode',
  'exitCode',
  'failureCount',
];

/** Explicit field allowlist: never serialize dependency errors, headers, prompts or source. */
export function logEntry(event, fields = {}) {
  const entry = {
    time: new Date().toISOString(),
    service: 'prototype-worker',
    level: /(?:failed|error|unavailable|rejected|aborted)$/.test(event) ? 'error' : 'info',
    event: /^[a-z][a-z0-9_.]{0,100}$/.test(event) ? event : 'service.error',
  };
  for (const key of textFields) {
    if (typeof fields[key] === 'string') entry[key] = safeDiagnostics([fields[key]])[0];
  }
  for (const key of numberFields) {
    if (Number.isFinite(fields[key])) entry[key] = fields[key];
  }
  for (const key of ['intake', 'available', 'duplicate', 'succeeded', 'writersStopped']) {
    if (typeof fields[key] === 'boolean') entry[key] = fields[key];
  }
  if (Array.isArray(fields.diagnostics)) entry.diagnostics = safeDiagnostics(fields.diagnostics);
  return entry;
}

export function commandLogContext(command = {}) {
  command ??= {};
  return Object.fromEntries(
    [
      'jobId',
      'turnId',
      'commandId',
      'executionId',
      'attemptId',
      'modelId',
      'tenantId',
      'userId',
      'conversationId',
      'stage',
      'expectedRevision',
      'fenceToken',
    ].map((key) => [key, command[key]]),
  );
}

export function errorLogFields(error, fallback = 'PROTOTYPE_OPERATION_FAILED') {
  const value = error?.code ?? error?.message;
  return {
    code: typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(value) ? value : fallback,
    errorType: /^[a-zA-Z0-9_]{1,64}$/.test(error?.name ?? '') ? error.name : 'Unknown',
    httpStatus: error?.status ?? error?.$metadata?.httpStatusCode,
    gatewayCode: /^[a-z_]{1,100}$/.test(error?.gatewayCode ?? '') ? error.gatewayCode : undefined,
    reason: error?.details?.reason,
    lineNumber: error?.details?.lineNumber,
    columnNumber: error?.details?.columnNumber,
    diagnosticCode: error?.details?.diagnosticCode,
    finishReason: error?.details?.finishReason,
    sourceBytes: error?.details?.sourceBytes,
    sourceDigest: error?.details?.sourceDigest,
    diagnostics: error?.diagnostics,
  };
}
