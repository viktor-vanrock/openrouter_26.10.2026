import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { S3ArtifactStore, artifactDigest } from '@librechat/prototype-worker';
import { runStageCommand } from '../src/stage-runtime.js';
import { StageS3Client } from '../src/s3-client.js';
import { readVerifiedPublicationResult } from '../src/stage-supervisor.js';

const enabled = process.env.PROTOTYPE_STORAGE_INTEGRATION === '1';
const digest = `sha256:${'a'.repeat(64)}`;

test(
  'executable publish and transfer stages use real MinIO without exposing credentials in results',
  { skip: !enabled },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-stage-s3-'));
    const workspace = path.join(root, 'workspace');
    const output = path.join(root, 'output');
    const inputPath = path.join(root, 'input.json');
    const credentialsPath = path.join(root, 'credentials.json');
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const owner = {
      tenantId: `tenant_${suffix}`,
      jobId: `job_${suffix}`,
      executionId: `execution_${suffix}`,
      revision: 1,
    };
    const client = new StageS3Client({
      endpoint: process.env.AWS_ENDPOINT_URL,
      region: process.env.AWS_REGION,
      forcePathStyle: process.env.AWS_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
    const bucket = process.env.AWS_BUCKET_NAME;
    const store = new S3ArtifactStore(client, bucket);
    const baseEnv = {
      NODE_ENV: 'test',
      PROTOTYPE_STAGE_INPUT_PATH: inputPath,
      PROTOTYPE_STAGE_OUTPUT_PATH: output,
      PROTOTYPE_WORKSPACE_PATH: workspace,
      PROTOTYPE_STORAGE_CREDENTIALS_PATH: credentialsPath,
      PROTOTYPE_JOB_ID: owner.jobId,
      PROTOTYPE_TURN_ID: `turn_${suffix}`,
      PROTOTYPE_COMMAND_ID: `command_${suffix}`,
      PROTOTYPE_EXPECTED_REVISION: '1',
      PROTOTYPE_ATTEMPT_ID: `attempt_${suffix}`,
      PROTOTYPE_EXECUTION_ID: owner.executionId,
      PROTOTYPE_FENCE_TOKEN: '1',
      PROTOTYPE_PIPELINE_STEP: '5',
    };
    const published = [];
    try {
      await fs.mkdir(workspace);
      await fs.writeFile(
        credentialsPath,
        JSON.stringify({
          endpoint: process.env.AWS_ENDPOINT_URL,
          region: process.env.AWS_REGION,
          bucket,
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          forcePathStyle: process.env.AWS_FORCE_PATH_STYLE === 'true',
        }),
        { mode: 0o600 },
      );
      const zip = new JSZip();
      zip.file('src/index.js', 'export default true');
      const files = {
        'checkpoint.tar.zst': Buffer.from('checkpoint'),
        'preview.html': Buffer.from('<main>real MinIO stage</main>'),
        'sources.zip': await zip.generateAsync({ type: 'nodebuffer' }),
        'qa.json': Buffer.from('{"passed":true}'),
      };
      for (const [name, bytes] of Object.entries(files))
        await fs.writeFile(path.join(workspace, name), bytes);
      const publishInput = {
        owner,
        target: 'review_ready',
        checkpointRevision: 1,
        templateDigest: digest,
        toolchainDigest: digest,
        checkpointPath: 'checkpoint.tar.zst',
        htmlPath: 'preview.html',
        sourcesPath: 'sources.zip',
        qaEvidencePath: 'qa.json',
        checkpointDigest: artifactDigest(files['checkpoint.tar.zst']),
        digests: {
          html: artifactDigest(files['preview.html']),
          sourcesZip: artifactDigest(files['sources.zip']),
          qaEvidence: artifactDigest(files['qa.json']),
        },
      };
      await fs.writeFile(inputPath, JSON.stringify(publishInput), { mode: 0o600 });
      await runStageCommand('publish', { env: { ...baseEnv, PROTOTYPE_STAGE: 'publish' } });
      const publication = JSON.parse(
        await fs.readFile(path.join(output, 'publication.json'), 'utf8'),
      );
      published.push(...publication.references);
      assert.equal(publication.references.length, 4);
      assert.doesNotMatch(JSON.stringify(publication), /accessKey|secretAccessKey|credential/i);
      const publicationRequest = await readVerifiedPublicationResult(
        {
          schemaVersion: 2,
          commandId: baseEnv.PROTOTYPE_COMMAND_ID,
          jobId: owner.jobId,
          turnId: baseEnv.PROTOTYPE_TURN_ID,
          tenantId: owner.tenantId,
          expectedRevision: 1,
          attemptId: baseEnv.PROTOTYPE_ATTEMPT_ID,
          executionId: owner.executionId,
          stage: 'publish',
          pipelineStep: 5,
          fenceToken: 1,
        },
        output,
      );
      assert.equal(publicationRequest.target, 'review_ready');
      assert.deepEqual(publicationRequest.artifacts.map((artifact) => artifact.kind).sort(), [
        'checkpoint',
        'html',
        'qa_evidence',
        'sources_zip',
      ]);

      const sources = publication.references.find((entry) => entry.kind === 'sources_zip');
      await fs.rm(output, { recursive: true, force: true });
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.mkdir(workspace);
      await fs.writeFile(
        inputPath,
        JSON.stringify({ reference: sources, owner, format: 'zip', destination: 'restored' }),
        { mode: 0o600 },
      );
      await runStageCommand('transfer', {
        env: { ...baseEnv, PROTOTYPE_STAGE: 'transfer', PROTOTYPE_PIPELINE_STEP: '3' },
      });
      assert.equal(
        await fs.readFile(path.join(workspace, 'restored/src/index.js'), 'utf8'),
        'export default true',
      );
      assert.deepEqual(await store.readVerified(sources, owner), files['sources.zip']);
    } finally {
      await Promise.all(
        published.map((reference) => client.deleteObject({ bucket, key: reference.objectKey })),
      );
      client.destroy();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
