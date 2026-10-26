import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePipelineInput,
  pipelineIdentity,
  decodePipelineResult,
  digest,
  REACT_BUILD_PROFILE,
  REACT_FSD_BUILD_PROFILE,
} from '../src/pipeline-contract.js';
import { createSourceManifest } from '../src/source-manifest.js';
const input = {
  executionId: 'attempt_1',
  profile: 'offline-prototype-v1',
  format: 'html',
  source: '<h1>Example</h1>',
};
test('pipeline contract rejects caller-selected infrastructure and commands', () => {
  for (const key of [
    'image',
    'command',
    'args',
    'namespace',
    'serviceAccountName',
    'env',
    'volumes',
    'url',
  ]) {
    assert.throws(
      () => validatePipelineInput({ ...input, [key]: 'untrusted' }),
      /PIPELINE_INPUT_INVALID/,
    );
  }
  assert.throws(() => validatePipelineInput({ ...input, executionId: '../../escape' }));
  assert.throws(() => validatePipelineInput({ ...input, source: 'x'.repeat(200_001) }));
});
test('idempotent identity is order independent and binds all execution data', () => {
  assert.deepEqual(
    pipelineIdentity(input),
    pipelineIdentity({
      source: input.source,
      format: input.format,
      profile: input.profile,
      executionId: input.executionId,
    }),
  );
  assert.equal(
    pipelineIdentity(input).name,
    pipelineIdentity({ ...input, source: '<h1>Changed</h1>' }).name,
  );
  assert.notEqual(
    pipelineIdentity(input).inputDigest,
    pipelineIdentity({ ...input, source: '<h1>Changed</h1>' }).inputDigest,
  );
});
test('results bind identity, exact bytes and successful browser evidence', () => {
  const make = (
    qa = { passed: true, checks: ['meaningful-body'], consoleErrors: [], networkRequests: [] },
  ) => ({
    ...input,
    inputDigest: pipelineIdentity(input).inputDigest,
    artifacts: Object.fromEntries(
      Object.entries({
        html: input.source,
        sourcesZip: 'archive',
        qaEvidence: JSON.stringify(qa),
      }).map(([key, value]) => [
        key,
        { base64: Buffer.from(value).toString('base64'), digest: digest(value) },
      ]),
    ),
  });
  assert.equal(decodePipelineResult(input, make()).html.toString(), input.source);
  assert.throws(() => decodePipelineResult(input, { ...make(), executionId: 'another' }));
  const poisoned = make();
  poisoned.artifacts.html.base64 = Buffer.from('changed').toString('base64');
  assert.throws(() => decodePipelineResult(input, poisoned), /DIGEST/);
  assert.throws(() => decodePipelineResult(input, make({ passed: false })), /QA_FAILED/);
});

test('React build-only evidence cannot substitute for browser QA or incomplete compilation', () => {
  const request = {
    ...input,
    format: 'react',
    profile: REACT_BUILD_PROFILE,
    source: 'export function App() { return null; }',
  };
  const qa = {
    passed: true,
    validation: 'build-only',
    browserQaPerformed: false,
    executionId: request.executionId,
    profile: request.profile,
    format: 'react',
    checks: ['type-check', 'lint', 'build'],
    consoleErrors: [],
    networkRequests: [],
  };
  const make = (evidence) => ({
    executionId: request.executionId,
    profile: request.profile,
    inputDigest: pipelineIdentity(request).inputDigest,
    artifacts: Object.fromEntries(
      Object.entries({
        html: '<main>compiled</main>',
        sourcesZip: 'source',
        qaEvidence: JSON.stringify(evidence),
      }).map(([key, value]) => [
        key,
        { base64: Buffer.from(value).toString('base64'), digest: digest(value) },
      ]),
    ),
  });
  assert.ok(decodePipelineResult(request, make(qa)).html);
  assert.throws(
    () => decodePipelineResult(request, make({ ...qa, checks: ['build'] })),
    /QA_FAILED/,
  );
  assert.throws(
    () => decodePipelineResult(request, make({ ...qa, browserQaPerformed: true })),
    /QA_FAILED/,
  );
  assert.throws(() => validatePipelineInput({ ...request, format: 'html' }), /INPUT_INVALID/);
  assert.throws(() => decodePipelineResult(input, make(qa)), /RESULT_INVALID/);
});

test('required browser gate rejects a successful build-only receipt and binds desktop/mobile iframe checks', () => {
  const request = {
    executionId: 'browser_attempt',
    format: 'react',
    profile: REACT_BUILD_PROFILE,
    source: 'export function App(){return null}',
    validation: 'browser',
  };
  const make = (qa) => ({
    executionId: request.executionId,
    profile: request.profile,
    inputDigest: pipelineIdentity(request).inputDigest,
    artifacts: Object.fromEntries(
      Object.entries({
        html: '<main>rendered</main>',
        sourcesZip: 'archive',
        qaEvidence: JSON.stringify(qa),
      }).map(([key, value]) => [
        key,
        { base64: Buffer.from(value).toString('base64'), digest: digest(value) },
      ]),
    ),
  });
  const qa = {
    passed: true,
    validation: 'browser',
    browserQaPerformed: true,
    executionId: request.executionId,
    profile: request.profile,
    format: 'react',
    checks: [
      'type-check',
      'lint',
      'build',
      'preview-iframe',
      'desktop',
      'mobile',
      'meaningful-body',
    ],
    consoleErrors: [],
    networkRequests: [],
  };
  assert.ok(decodePipelineResult(request, make(qa)));
  assert.throws(
    () =>
      decodePipelineResult(
        request,
        make({ ...qa, validation: 'build-only', browserQaPerformed: false }),
      ),
    /QA_FAILED/,
  );
  assert.throws(
    () =>
      decodePipelineResult(
        request,
        make({ ...qa, checks: qa.checks.filter((c) => c !== 'mobile') }),
      ),
    /QA_FAILED/,
  );
});

test('multi-file input binds every source and rejects configuration/extra authority before sandbox create', () => {
  const sources = {
    'src/app/App.tsx':
      "import { Page } from '@/pages/crm'; export function App() { return <Page />; }",
    'src/pages/crm/index.tsx':
      "import { Widget } from '@/widgets/crm'; export function Page() { return <Widget />; }",
    'src/widgets/crm/index.tsx':
      "import { Edit } from '@/features/edit'; export function Widget() { return <Edit />; }",
    'src/features/edit/index.tsx':
      "import { value } from '@/entities/employee'; import { Button } from '@ai-sber/uikit'; export function Edit() { return <Button>{value}</Button>; }",
    'src/entities/employee/index.ts':
      "import { name } from '@/shared/lib'; export const value = name;",
    'src/shared/lib/index.ts': "export const name = 'Employee';",
  };
  const sourceManifest = createSourceManifest(sources, {
    engineId: 'opencode-fsd-v1',
    profile: 'react-fsd-source-v1',
    modelId: 'chosen/model',
    revision: 4,
    rulesDigest: digest('rules'),
    templateDigest: digest('template'),
    toolchainDigest: digest('toolchain'),
  });
  const multi = {
    executionId: 'multi_attempt',
    profile: REACT_FSD_BUILD_PROFILE,
    format: 'react',
    sources,
    sourceManifest,
  };
  assert.deepEqual(
    pipelineIdentity(multi),
    pipelineIdentity({ ...multi, sources: Object.fromEntries(Object.entries(sources).reverse()) }),
  );
  assert.throws(
    () =>
      validatePipelineInput({
        ...multi,
        sources: { ...sources, 'src/shared/lib/index.ts': 'changed' },
      }),
    /MANIFEST/,
  );
  assert.throws(() => validatePipelineInput({ ...multi, image: 'caller-image' }), /INPUT_INVALID/);
  assert.throws(
    () => validatePipelineInput({ ...multi, sources: { ...sources, 'package.json': '{}' } }),
    /MANIFEST/,
  );
});
