import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runStageCommand, writeStageFailure } from '../src/stage-runtime.js';
import { artifactDigest, S3ArtifactStore } from '@librechat/prototype-worker';
import JSZip from 'jszip';

const digest = `sha256:${'a'.repeat(64)}`;

async function fixture(input) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-stage-'));
  const inputPath = path.join(root, 'input.json');
  const outputPath = path.join(root, 'output');
  const workspacePath = path.join(root, 'workspace');
  const credentialsPath = path.join(root, 'credentials.json');
  const modelCredentialsPath = path.join(root, 'model-credentials.json');
  await fs.mkdir(workspacePath);
  await fs.writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
  await fs.writeFile(
    credentialsPath,
    JSON.stringify({
      endpoint: 'http://s3.test',
      region: 'us-east-1',
      bucket: 'test-bucket',
      forcePathStyle: true,
      accessKeyId: 'test',
      secretAccessKey: 'test-secret',
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    modelCredentialsPath,
    JSON.stringify({
      baseUrl: 'http://model-gateway.internal',
      token: 'ephemeral-test-token',
    }),
    { mode: 0o600 },
  );
  return {
    root,
    outputPath,
    workspacePath,
    env: {
      NODE_ENV: 'test',
      PROTOTYPE_STAGE_INPUT_PATH: inputPath,
      PROTOTYPE_STAGE_OUTPUT_PATH: outputPath,
      PROTOTYPE_WORKSPACE_PATH: workspacePath,
      PROTOTYPE_JOB_ID: 'job_1',
      PROTOTYPE_TURN_ID: 'turn_1',
      PROTOTYPE_COMMAND_ID: 'command_1',
      PROTOTYPE_EXPECTED_REVISION: '2',
      PROTOTYPE_STORAGE_CREDENTIALS_PATH: credentialsPath,
      PROTOTYPE_MODEL_CREDENTIALS_PATH: modelCredentialsPath,
      PROTOTYPE_ATTEMPT_ID: 'attempt_1',
      PROTOTYPE_EXECUTION_ID: 'execution_1',
      PROTOTYPE_FENCE_TOKEN: '4',
      PROTOTYPE_PIPELINE_STEP: '0',
    },
  };
}

class MemoryS3 {
  objects = new Map();
  async putObject(input) {
    if (input.ifNoneMatch && this.objects.has(input.key)) throw new Error('precondition');
    this.objects.set(input.key, { body: Buffer.from(input.body), metadata: { ...input.metadata } });
  }
  async headObject({ key }) {
    const value = this.objects.get(key);
    return value ? { size: value.body.length, metadata: { ...value.metadata } } : null;
  }
  async getObject({ key }) {
    return Buffer.from(this.objects.get(key).body);
  }
  async deleteObject({ key }) {
    this.objects.delete(key);
  }
  destroy() {}
}

test('dependency stage receives only trusted contract input and writes a bounded bundle result', async () => {
  const value = await fixture({
    manifest: { name: 'trusted' },
    lockfile: { lockfileVersion: 3 },
    gatewayUrl: 'http://dependency.internal',
  });
  const calls = [];
  try {
    const result = await runStageCommand('dependency_preparation', {
      env: {
        ...value.env,
        PROTOTYPE_STAGE: 'dependency_preparation',
        PROTOTYPE_PIPELINE_STEP: '2',
      },
      installer: {
        install: async (input) => {
          calls.push(input);
          return Buffer.from('bundle');
        },
      },
    });
    assert.equal(result.kind, 'dependency_bundle');
    assert.equal(result.bundleDigest, artifactDigest(Buffer.from('bundle')));
    assert.equal(calls[0].destination, path.join(value.workspacePath, 'install'));
    assert.equal(
      await fs.readFile(path.join(value.outputPath, 'dependencies.zip'), 'utf8'),
      'bundle',
    );
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('generation stage uses protected model credentials and emits an immutable checkpoint', async () => {
  const value = await fixture({ modelId: 'fake/model', prompt: 'Build the approved prototype' });
  const calls = [];
  await fs.writeFile(path.join(value.workspacePath, 'source.tsx'), 'export default true');
  const generationClient = {
    createSession: async (workspace, modelId, proxy) => {
      calls.push(['create', workspace, modelId, proxy.baseUrl]);
      return { workspace };
    },
    runTurn: async () => 'Implemented\nPROTOTYPE_CODE_DONE: crm',
    disposeSession: async () => calls.push(['dispose']),
  };
  try {
    const result = await runStageCommand('generation', {
      env: { ...value.env, PROTOTYPE_STAGE: 'generation' },
      generationClient,
    });
    assert.equal(result.type, 'code_done');
    assert.equal(result.prototypeSlug, 'crm');
    assert.match(result.checkpointDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      (await fs.stat(path.join(value.outputPath, 'checkpoint.tar.zst'))).size,
      result.checkpointSize,
    );
    assert.deepEqual(
      calls.map((entry) => entry[0]),
      ['create', 'dispose'],
    );
    assert.doesNotMatch(JSON.stringify(result), /ephemeral-test-token|model-gateway\.internal/i);
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('generation repair receives only bounded trusted diagnostics', async () => {
  const value = await fixture({
    modelId: 'fake/model',
    prompt: 'Repair the approved prototype',
    repair: { ordinal: 2, diagnostics: ['src/app.tsx: type mismatch'] },
  });
  await fs.writeFile(path.join(value.workspacePath, 'source.tsx'), 'export default true');
  const prompts = [];
  const generationClient = {
    createSession: async () => ({}),
    runTurn: async (_session, prompt) => {
      prompts.push(prompt);
      return 'Fixed\nPROTOTYPE_CODE_DONE: crm';
    },
    disposeSession: async () => {},
  };
  try {
    await runStageCommand('generation', {
      env: { ...value.env, PROTOTYPE_STAGE: 'generation' },
      generationClient,
    });
    assert.match(prompts[0], /repair 2\/2/);
    assert.match(prompts[0], /src\/app\.tsx: type mismatch/);
    await fs.writeFile(
      value.env.PROTOTYPE_STAGE_INPUT_PATH,
      JSON.stringify({
        modelId: 'fake/model',
        prompt: 'Repair',
        repair: { ordinal: 3, diagnostics: ['error'] },
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      () =>
        runStageCommand('generation', {
          env: { ...value.env, PROTOTYPE_STAGE: 'generation' },
          generationClient,
        }),
      /REPAIR_INPUT_INVALID/,
    );
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('offline build stage writes HTML, ZIP, QA evidence and digest-bound result', async () => {
  const value = await fixture({ templateDigest: digest, toolchainDigest: digest });
  try {
    const result = await runStageCommand('build_qa', {
      env: { ...value.env, PROTOTYPE_STAGE: 'build_qa', PROTOTYPE_PIPELINE_STEP: '4' },
      buildQa: {
        execute: async () => ({
          html: Buffer.from('<main>ok</main>'),
          sourcesZip: Buffer.from('zip'),
          qaEvidence: Buffer.from('{}'),
          digests: { html: digest, sourcesZip: digest, qaEvidence: digest },
        }),
      },
    });
    assert.equal(result.kind, 'verified_snapshot');
    assert.match(result.snapshotDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      await fs.readFile(path.join(value.outputPath, 'preview.html'), 'utf8'),
      '<main>ok</main>',
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(value.outputPath, 'result.json'), 'utf8')).digests,
      {
        html: digest,
        sourcesZip: digest,
        qaEvidence: digest,
      },
    );
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('stage input rejects secrets, transcript, object keys and mismatched stage identity', async () => {
  const value = await fixture({
    manifest: {},
    lockfile: {},
    gatewayUrl: 'http://dependency.internal',
    modelToken: 'forbidden',
  });
  try {
    await assert.rejects(
      () =>
        runStageCommand('dependency_preparation', {
          env: {
            ...value.env,
            PROTOTYPE_STAGE: 'dependency_preparation',
            PROTOTYPE_PIPELINE_STEP: '2',
          },
          installer: { install: async () => Buffer.alloc(0) },
        }),
      /INPUT_SENSITIVE/,
    );
    await assert.rejects(
      () =>
        runStageCommand('build_qa', {
          env: {
            ...value.env,
            PROTOTYPE_STAGE: 'dependency_preparation',
            PROTOTYPE_PIPELINE_STEP: '2',
          },
          buildQa: { execute: async () => null },
        }),
      /STAGE_UNSUPPORTED/,
    );
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('trusted transfer restores a verified dependency bundle into a fresh workspace copy', async () => {
  const client = new MemoryS3();
  const owner = {
    tenantId: 'tenant_1',
    jobId: 'job_1',
    executionId: 'execution_source',
    revision: 1,
  };
  const zip = new JSZip();
  zip.file('node_modules/pkg/index.js', 'module.exports = true');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const reference = await new S3ArtifactStore(client, 'test-bucket').publish({
    owner,
    kind: 'dependency_bundle',
    bytes,
    digest: artifactDigest(bytes),
    contentType: 'application/zip',
    templateDigest: digest,
    toolchainDigest: digest,
  });
  const value = await fixture({ reference, owner, format: 'zip', destination: 'dependencies' });
  try {
    const result = await runStageCommand('transfer', {
      env: { ...value.env, PROTOTYPE_STAGE: 'transfer', PROTOTYPE_PIPELINE_STEP: '3' },
      createS3Client: () => client,
    });
    assert.equal(result.kind, 'restored_workspace');
    assert.equal(result.restoredDigest, reference.digest);
    assert.equal(
      await fs.readFile(
        path.join(value.workspacePath, 'dependencies/node_modules/pkg/index.js'),
        'utf8',
      ),
      'module.exports = true',
    );
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('publish stage verifies one snapshot and writes immutable S3 references', async () => {
  const client = new MemoryS3();
  const value = await fixture({});
  const checkpoint = Buffer.from('checkpoint');
  const html = Buffer.from('<main>verified</main>');
  const sources = Buffer.from('sources');
  const qa = Buffer.from('{"passed":true}');
  for (const [name, bytes] of Object.entries({
    'checkpoint.tar.zst': checkpoint,
    'preview.html': html,
    'sources.zip': sources,
    'qa.json': qa,
  })) {
    await fs.writeFile(path.join(value.workspacePath, name), bytes);
  }
  const input = {
    owner: { tenantId: 'tenant_1', jobId: 'job_1', executionId: 'execution_1', revision: 1 },
    target: 'review_ready',
    checkpointRevision: 1,
    templateDigest: digest,
    toolchainDigest: digest,
    checkpointPath: 'checkpoint.tar.zst',
    htmlPath: 'preview.html',
    sourcesPath: 'sources.zip',
    qaEvidencePath: 'qa.json',
    checkpointDigest: artifactDigest(checkpoint),
    digests: {
      html: artifactDigest(html),
      sourcesZip: artifactDigest(sources),
      qaEvidence: artifactDigest(qa),
    },
  };
  await fs.writeFile(value.env.PROTOTYPE_STAGE_INPUT_PATH, JSON.stringify(input), { mode: 0o600 });
  try {
    const result = await runStageCommand('publish', {
      env: { ...value.env, PROTOTYPE_STAGE: 'publish', PROTOTYPE_PIPELINE_STEP: '5' },
      createS3Client: () => client,
    });
    assert.equal(result.artifactCount, 4);
    const publication = JSON.parse(
      await fs.readFile(path.join(value.outputPath, 'publication.json'), 'utf8'),
    );
    assert.deepEqual(publication.references.map((entry) => entry.kind).sort(), [
      'checkpoint',
      'html',
      'qa_evidence',
      'sources_zip',
    ]);
    assert.equal(client.objects.size, 4);
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});

test('writes bounded sanitized build failure diagnostics for the trusted supervisor', async () => {
  const value = await fixture({ templateDigest: digest, toolchainDigest: digest });
  try {
    const failure = await writeStageFailure(
      'build_qa',
      Object.assign(new Error('PROTOTYPE_BUILD_FAILED'), {
        diagnostics: [`type-check: ${value.workspacePath}/src/app.tsx failed`],
      }),
      { ...value.env, PROTOTYPE_STAGE: 'build_qa', PROTOTYPE_PIPELINE_STEP: '4' },
    );
    assert.equal(failure.code, 'PROTOTYPE_BUILD_FAILED');
    assert.equal(failure.retryable, true);
    assert.match(failure.diagnostics[0], /<workspace>\/src\/app\.tsx/);
    assert.doesNotMatch(JSON.stringify(failure), new RegExp(value.workspacePath));
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(value.outputPath, 'failure.json'), 'utf8')),
      failure,
    );
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
});
