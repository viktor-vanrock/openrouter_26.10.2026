import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSourceManifest,
  verifySourceManifest,
  validateSourceManifest,
  SOURCE_PROFILES,
} from '../src/source-manifest.js';
import { generateCandidate } from '../src/generation-engine.js';
const pins = {
  rulesDigest: `sha256:${'a'.repeat(64)}`,
  templateDigest: `sha256:${'b'.repeat(64)}`,
  toolchainDigest: `sha256:${'c'.repeat(64)}`,
};
const metadata = {
  ...pins,
  engineId: 'direct-react-v1',
  modelId: 'selected/model',
  profile: SOURCE_PROFILES.baseline,
  revision: 1,
};
const sources = { 'src/app/App.tsx': 'export function App() { return null; }' };

test('baseline and multi-file manifests round trip with complete content/identity binding', () => {
  const manifest = createSourceManifest(sources, metadata);
  assert.deepEqual(verifySourceManifest(JSON.parse(JSON.stringify(manifest)), sources), manifest);
  assert.throws(() =>
    verifySourceManifest(manifest, { ...sources, 'src/shared/lib/new.ts': 'export {}' }),
  );
  assert.throws(() => verifySourceManifest(manifest, { 'src/app/App.tsx': 'changed' }));
  assert.throws(() => validateSourceManifest({ ...manifest, modelId: 'different/model' }));
  const multi = { ...sources, 'src/entities/employee/index.ts': 'export const demo = 1;' };
  assert.equal(
    createSourceManifest(multi, {
      ...metadata,
      engineId: 'opencode-fsd-v1',
      profile: SOURCE_PROFILES.fsd,
    }).files.length,
    2,
  );
});

test('source manifest rejects traversal, duplicates, config inputs, binary text and bounds', () => {
  for (const name of [
    'src/app/../App.tsx',
    '/src/app/App.tsx',
    'src//app/App.tsx',
    'package.json',
    'src/app/.secret.ts',
    'src/app/config.js',
  ]) {
    assert.throws(() => createSourceManifest({ [name]: 'source' }, metadata));
  }
  assert.throws(() => createSourceManifest({ 'src/app/App.tsx': '\ud800' }, metadata));
  assert.throws(() =>
    createSourceManifest({ 'src/app/App.tsx': 'x'.repeat(256 * 1024 + 1) }, metadata),
  );
  const manifest = createSourceManifest(sources, metadata);
  assert.throws(() =>
    validateSourceManifest({ ...manifest, files: [...manifest.files, ...manifest.files] }),
  );
  assert.throws(() => validateSourceManifest({ ...manifest, arbitrary: true }));
});

test('engine boundary never changes the selected engine/model on failure', async () => {
  const input = {
    engineId: metadata.engineId,
    modelId: metadata.modelId,
    pins,
    acceptedSource: null,
    changeRequest: '',
    selectedVariant: null,
    approvedPlan: { approved: true, text: 'A and B' },
    limits: {
      maxCostUsd: 2,
      maxRequests: 8,
      maxTools: 100,
      maxRepairs: 2,
      activeTimeoutMs: 600000,
    },
    command: {
      jobId: 'job_1',
      turnId: 'turn_1',
      commandId: 'command_1',
      attemptId: 'attempt_1',
      executionId: 'execution_1',
      expectedRevision: 1,
      fenceToken: 2,
      stage: 'generation',
      pipelineStep: 0,
      modelId: metadata.modelId,
      tenantId: '__default__',
      userId: 'owner_fixture',
    },
  };
  let fallback = false;
  await assert.rejects(
    generateCandidate({
      input,
      engines: {
        'direct-react-v1': {
          generate: async () => {
            throw new Error('failed');
          },
        },
        'opencode-fsd-v1': {
          generate: async () => {
            fallback = true;
          },
        },
      },
    }),
    /failed/,
  );
  assert.equal(fallback, false);
  const result = await generateCandidate({
    input,
    engines: {
      'direct-react-v1': {
        generate: async () => ({ sources, manifest: createSourceManifest(sources, metadata) }),
      },
    },
  });
  assert.equal(result.manifest.modelId, input.modelId);
  await assert.rejects(
    generateCandidate({
      input: { ...input, approvedPlan: { ...input.approvedPlan, approved: false } },
      engines: {},
    }),
    /INPUT_INVALID/,
  );
  await assert.rejects(
    generateCandidate({
      input: { ...input, limits: { ...input.limits, arbitrary: true } },
      engines: {},
    }),
    /LIMITS_INVALID/,
  );
  await assert.rejects(
    generateCandidate({
      input: {
        ...input,
        acceptedSource: createSourceManifest(sources, {
          ...metadata,
          revision: 0,
          rulesDigest: `sha256:${'d'.repeat(64)}`,
        }),
      },
      engines: {},
    }),
    /SOURCE_CONFLICT/,
  );
});
