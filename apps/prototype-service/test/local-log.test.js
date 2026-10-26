import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localLogger, serviceLogger } from '../src/local-log.js';
import { errorLogFields } from '../src/service-log.js';
import { failureFromLog, safeDiagnostics } from '../src/pipeline-diagnostics.js';

test('local logs persist stage identity and sanitized compiler errors in an owner-only file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-log-'));
  const messages = [];
  try {
    const log = localLogger(directory, { info: (message) => messages.push(message) });
    log('stage.failed', {
      jobId: 'job_test',
      stage: 'build_qa',
      diagnostics: ['TS2322 Bearer secret /workspace/src/App.tsx'],
    });
    const text = await fs.readFile(path.join(directory, 'service.log'), 'utf8');
    assert.match(text, /TS2322/);
    assert.doesNotMatch(text, /secret|\/workspace/);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /Проверка готовности/);
    assert.match(messages[1], /TS2322/);
    assert.doesNotMatch(messages.join('\n'), /secret|\/workspace/);
    assert.equal((await fs.stat(path.join(directory, 'service.log'))).mode & 0o077, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('pipeline logs expose only the bounded failure marker, never result artifacts or full stacks', () => {
  const line =
    'PROTOTYPE_PIPELINE_FAILURE=' +
    JSON.stringify({ code: 'PROTOTYPE_BUILD_FAILED', diagnostics: ['type-check: TS2322'] });
  assert.deepEqual(failureFromLog(`ignored\n${line}\n`), {
    code: 'PROTOTYPE_BUILD_FAILED',
    diagnostics: ['type-check: TS2322'],
  });
  assert.deepEqual(failureFromLog('PROTOTYPE_PIPELINE_RESULT=private-artifact'), {
    code: 'PIPELINE_EXECUTION_FAILED',
    diagnostics: [],
  });
  assert.ok(safeDiagnostics(['x'.repeat(50000)])[0].length <= 4000);
});

test('production writes one bounded JSON line with correlation and diagnostics to stdout without files', () => {
  const lines = [];
  const log = serviceLogger('/missing/workspace', {
    environment: 'production',
    terminal: { info: (line) => lines.push(line) },
  });
  log('stage.failed', {
    jobId: 'job_full_identifier',
    turnId: 'turn_1',
    commandId: 'approve_1',
    executionId: 'execution_1',
    attemptId: 'attempt_1',
    modelId: '~openai/gpt-luna-latest',
    stage: 'generation',
    code: 'LIVE_MODEL_REACT_INVALID',
    reason: 'tsx_syntax_error',
    lineNumber: 42,
    columnNumber: 7,
    diagnostics: ['TS1005\nBearer very-private-token https://example.test?token=secret'],
    rawSource: 'private source',
    prompt: 'private prompt',
    apiKey: 'private-key',
    headers: { Authorization: 'secret' },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].split('\n').length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.service, 'prototype-worker');
  assert.equal(entry.level, 'error');
  assert.equal(entry.executionId, 'execution_1');
  assert.equal(entry.modelId, '~openai/gpt-luna-latest');
  assert.equal(entry.reason, 'tsx_syntax_error');
  assert.equal(entry.lineNumber, 42);
  assert.match(entry.diagnostics[0], /TS1005/);
  assert.doesNotMatch(
    lines[0],
    /very-private|example.test|private source|private prompt|private-key|Authorization/,
  );
});

test('all structured fields redact signed URLs, credentials, JWTs and PEM keys; unknown fields are dropped', () => {
  const lines = [];
  const log = serviceLogger(null, {
    environment: 'production',
    terminal: { info: (line) => lines.push(line) },
  });
  log('service.error', {
    line: 'mongodb://user:pass@host/db redis://user:pass@host AWS_SECRET_ACCESS_KEY=private-secret PROTOTYPE_SERVICE_TOKEN="private-token"',
    diagnostics: [
      'eyJtest.payload.signature',
      '-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----',
    ],
    ...errorLogFields({
      name: 'Error',
      message: 'mongodb://private-host',
      stack: 'private stack',
      cause: 'private cause',
    }),
  });
  assert.doesNotMatch(lines[0], /user:pass|private-|payload|signature/);
  assert.equal(JSON.parse(lines[0]).code, 'PROTOTYPE_OPERATION_FAILED');
});

test('local output distinguishes the maximum response allowance from actual model usage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-log-'));
  const lines = [];
  try {
    const log = localLogger(directory, { info: (line) => lines.push(line) });
    log('model.start', { maxOutputTokens: 65536 });
    assert.match(lines[0], /лимит ответа/);
    assert.doesNotMatch(lines[0], / · ответ /);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
