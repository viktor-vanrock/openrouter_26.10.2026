import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DependencyInstaller,
  OfflineBuildQaRunner,
  PublicationAdapter,
  OpenCodeExecutionClient,
  S3ArtifactStore,
  TransferAdapter,
  artifactDigest,
  buildCheckpointArchive,
  interpretTurn,
} from '@librechat/prototype-worker';
import { StageS3Client } from './s3-client.js';
import { prepareFixedWorkspace, verifyFixedWorkspace } from './fixed-template.js';

const STAGES = new Set(['generation', 'transfer', 'dependency_preparation', 'build_qa', 'publish']);
const PIPELINE_STAGES = [
  'generation',
  'transfer',
  'dependency_preparation',
  'transfer',
  'build_qa',
  'publish',
];
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,256}$/;

function assertNoSensitiveKeys(value, stage) {
  const forbidden = /authorization|cookie|credential|token|signed.?url|transcript|user.?source/i;
  const visit = (entry) => {
    if (Array.isArray(entry)) return entry.forEach(visit);
    if (!entry || typeof entry !== 'object') return;
    for (const [key, child] of Object.entries(entry)) {
      if (forbidden.test(key)) throw new Error('PROTOTYPE_STAGE_INPUT_SENSITIVE');
      if (stage !== 'transfer' && key === 'objectKey')
        throw new Error('PROTOTYPE_STAGE_INPUT_SENSITIVE');
      visit(child);
    }
  };
  visit(value);
}

function resolveBelow(root, value) {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('PROTOTYPE_STAGE_PATH_INVALID');
  const target = path.resolve(root, value);
  if (target !== root && !target.startsWith(`${root}${path.sep}`))
    throw new Error('PROTOTYPE_STAGE_PATH_INVALID');
  return target;
}

function archiveLimits(input) {
  const limits = input.archiveLimits ?? {};
  return {
    maxArchiveBytes: limits.maxArchiveBytes ?? 100_000_000,
    maxExpandedBytes: limits.maxExpandedBytes ?? 500_000_000,
    maxFiles: limits.maxFiles ?? 100_000,
    maxPathBytes: limits.maxPathBytes ?? 1_024,
    maxCompressionRatio: limits.maxCompressionRatio ?? 100,
    maxDurationMs: limits.maxDurationMs ?? 60_000,
  };
}

async function loadStorage(env, createClient) {
  const credentialsPath = runtimePath(
    env,
    'PROTOTYPE_STORAGE_CREDENTIALS_PATH',
    '/run/prototype-storage/credentials.json',
  );
  const stat = await fs.stat(credentialsPath);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0)
    throw new Error('PROTOTYPE_STORAGE_CREDENTIAL_PERMISSIONS');
  const config = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  if (
    (config.endpoint !== undefined && typeof config.endpoint !== 'string') ||
    typeof config.region !== 'string' ||
    typeof config.bucket !== 'string' ||
    typeof config.accessKeyId !== 'string' ||
    typeof config.secretAccessKey !== 'string' ||
    typeof config.forcePathStyle !== 'boolean'
  )
    throw new Error('PROTOTYPE_STORAGE_CONFIGURATION_INVALID');
  const client = createClient({
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
  });
  return { client, store: new S3ArtifactStore(client, config.bucket) };
}

async function loadModelCredentials(env) {
  const credentialsPath = runtimePath(
    env,
    'PROTOTYPE_MODEL_CREDENTIALS_PATH',
    '/run/prototype-model/credentials.json',
  );
  const stat = await fs.stat(credentialsPath);
  if (!stat.isFile() || (stat.mode & 0o022) !== 0)
    throw new Error('PROTOTYPE_MODEL_CREDENTIAL_PERMISSIONS');
  const config = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  if (typeof config.baseUrl !== 'string' || typeof config.token !== 'string') {
    throw new Error('PROTOTYPE_MODEL_CONFIGURATION_INVALID');
  }
  return config;
}

function identity(env, stage) {
  const result = {
    jobId: env.PROTOTYPE_JOB_ID,
    turnId: env.PROTOTYPE_TURN_ID,
    commandId: env.PROTOTYPE_COMMAND_ID,
    expectedRevision: Number(env.PROTOTYPE_EXPECTED_REVISION),
    attemptId: env.PROTOTYPE_ATTEMPT_ID,
    executionId: env.PROTOTYPE_EXECUTION_ID,
    fenceToken: Number(env.PROTOTYPE_FENCE_TOKEN),
    pipelineStep: Number(env.PROTOTYPE_PIPELINE_STEP),
    stage,
  };
  if (
    ![result.jobId, result.turnId, result.commandId, result.attemptId, result.executionId].every(
      (value) => SAFE_ID.test(value ?? ''),
    ) ||
    !Number.isSafeInteger(result.expectedRevision) ||
    result.expectedRevision < 0 ||
    !Number.isSafeInteger(result.fenceToken) ||
    result.fenceToken < 1 ||
    !Number.isSafeInteger(result.pipelineStep) ||
    result.pipelineStep < 0 ||
    result.pipelineStep > 5 ||
    PIPELINE_STAGES[result.pipelineStep] !== stage
  ) {
    throw new Error('PROTOTYPE_STAGE_IDENTITY_INVALID');
  }
  return result;
}

function runtimePath(env, name, fallback) {
  const value = path.resolve(env[name] ?? fallback);
  if (env.NODE_ENV === 'production' && value !== fallback && !value.startsWith('/run/prototype/')) {
    throw new Error('PROTOTYPE_STAGE_PATH_INVALID');
  }
  return value;
}

async function writeOutput(outputRoot, name, bytes) {
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(outputRoot, name);
  const temporary = `${destination}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, destination);
}

export async function writeStageFailure(stage, error, env = process.env) {
  if (!STAGES.has(stage)) throw new Error('PROTOTYPE_STAGE_UNSUPPORTED');
  const stageIdentity = identity(env, stage);
  const outputRoot = runtimePath(env, 'PROTOTYPE_STAGE_OUTPUT_PATH', '/run/prototype/output');
  const workspace = runtimePath(env, 'PROTOTYPE_WORKSPACE_PATH', '/workspace');
  const rawCode = error instanceof Error ? error.message : 'PROTOTYPE_EXECUTION_FAILED';
  const code =
    rawCode === 'PROTOTYPE_BUILD_FAILED'
      ? 'PROTOTYPE_BUILD_FAILED'
      : ['PROTOTYPE_QA_FAILED', 'PROTOTYPE_QA_NETWORK_REFERENCE'].includes(rawCode)
        ? 'PROTOTYPE_QA_FAILED'
        : 'PROTOTYPE_EXECUTION_FAILED';
  const rawDiagnostics =
    Array.isArray(error?.diagnostics) && error.diagnostics.length > 0 ? error.diagnostics : [code];
  const diagnostics = rawDiagnostics
    .slice(0, 20)
    .map((entry) => String(entry).split(workspace).join('<workspace>').slice(0, 2_048));
  const result = {
    ...stageIdentity,
    type: 'failed',
    code,
    message:
      code === 'PROTOTYPE_BUILD_FAILED'
        ? 'Offline build failed.'
        : code === 'PROTOTYPE_QA_FAILED'
          ? 'Offline QA failed.'
          : 'Stage execution failed.',
    retryable: stage === 'build_qa' && code !== 'PROTOTYPE_EXECUTION_FAILED',
    diagnostics,
  };
  await writeOutput(outputRoot, 'failure.json', Buffer.from(`${JSON.stringify(result)}\n`));
  return result;
}

export async function runStageCommand(
  stage,
  {
    env = process.env,
    installer = new DependencyInstaller(),
    buildQa = new OfflineBuildQaRunner(),
    generationClient = new OpenCodeExecutionClient({ inactivityTimeoutMs: 5 * 60_000 }),
    createS3Client = (config) => new StageS3Client(config),
    fixedTemplateRoot = '/opt/prototype/template',
  } = {},
) {
  if (!STAGES.has(stage) || (env.PROTOTYPE_STAGE && env.PROTOTYPE_STAGE !== stage)) {
    throw new Error('PROTOTYPE_STAGE_UNSUPPORTED');
  }
  const stageIdentity = identity(env, stage);
  const inputPath = runtimePath(env, 'PROTOTYPE_STAGE_INPUT_PATH', '/run/prototype/input.json');
  const outputRoot = runtimePath(env, 'PROTOTYPE_STAGE_OUTPUT_PATH', '/run/prototype/output');
  const workspace = runtimePath(env, 'PROTOTYPE_WORKSPACE_PATH', '/workspace');
  const inputStat = await fs.stat(inputPath);
  if (!inputStat.isFile() || (inputStat.mode & 0o022) !== 0)
    throw new Error('PROTOTYPE_STAGE_INPUT_PERMISSIONS');
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  assertNoSensitiveKeys(input, stage);
  const fixedTemplate =
    env.PROTOTYPE_FIXED_TEMPLATE === '1' && ['generation', 'build_qa'].includes(stage);
  const fixedOptions = {
    root: fixedTemplateRoot,
    templateDigest: input.templateDigest,
    toolchainDigest: input.toolchainDigest,
  };
  if (fixedTemplate) {
    if (!DIGEST.test(input.templateDigest) || !DIGEST.test(input.toolchainDigest)) {
      throw new Error('PROTOTYPE_FIXED_PROFILE_MISMATCH');
    }
    await prepareFixedWorkspace(workspace, fixedOptions);
  }

  if (stage === 'generation') {
    if (
      typeof input.modelId !== 'string' ||
      typeof input.prompt !== 'string' ||
      input.prompt.length === 0
    ) {
      throw new Error('PROTOTYPE_GENERATION_INPUT_INVALID');
    }
    let prompt = input.prompt;
    if (input.repair !== undefined) {
      if (
        !input.repair ||
        !Number.isSafeInteger(input.repair.ordinal) ||
        input.repair.ordinal < 1 ||
        input.repair.ordinal > 2 ||
        !Array.isArray(input.repair.diagnostics) ||
        input.repair.diagnostics.length < 1 ||
        input.repair.diagnostics.length > 20 ||
        input.repair.diagnostics.some(
          (entry) => typeof entry !== 'string' || entry.length < 1 || entry.length > 2_048,
        )
      ) {
        throw new Error('PROTOTYPE_REPAIR_INPUT_INVALID');
      }
      prompt = `${prompt}\n\nTrusted build/QA diagnostics for repair ${input.repair.ordinal}/2:\n${input.repair.diagnostics
        .map((entry) => `- ${entry}`)
        .join(
          '\n',
        )}\nFix only the reported issues, preserve the approved dependency set, and finish with PROTOTYPE_CODE_DONE.`;
    }
    const proxy = await loadModelCredentials(env);
    const session = await generationClient.createSession(workspace, input.modelId, proxy);
    let text;
    try {
      text = await generationClient.runTurn(session, prompt, () => undefined);
    } finally {
      await generationClient.disposeSession(session);
    }
    if (fixedTemplate) await verifyFixedWorkspace(workspace, fixedOptions);
    let outcome;
    const codeDone = text
      .trim()
      .match(/(?:^|\n)PROTOTYPE_CODE_DONE:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/i);
    if (codeDone) {
      outcome = {
        type: 'code_done',
        prototypeSlug: codeDone[1].toLowerCase(),
        summary: text.slice(0, codeDone.index).trim().slice(0, 2_048),
      };
    } else {
      const interpreted = interpretTurn(text);
      if (interpreted.kind !== 'waiting')
        throw new Error('PROTOTYPE_GENERATION_PREMATURE_PUBLICATION');
      outcome = {
        type: 'waiting',
        reason: interpreted.waitingReason,
        prompt: interpreted.text.slice(0, 2_048),
      };
    }
    const checkpointPath = path.join(outputRoot, 'checkpoint.tar.zst');
    await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await buildCheckpointArchive(workspace, checkpointPath);
    const checkpoint = await fs.readFile(checkpointPath);
    const result = {
      ...stageIdentity,
      ...outcome,
      checkpointDigest: artifactDigest(checkpoint),
      checkpointSize: checkpoint.length,
    };
    await writeOutput(outputRoot, 'result.json', Buffer.from(`${JSON.stringify(result)}\n`));
    return result;
  }

  if (stage === 'transfer') {
    const { client, store } = await loadStorage(env, createS3Client);
    try {
      if (!input.reference || !input.owner || !['zip', 'tar_zstd'].includes(input.format)) {
        throw new Error('PROTOTYPE_TRANSFER_INPUT_INVALID');
      }
      const destination = resolveBelow(workspace, input.destination ?? 'restored');
      const transfer = new TransferAdapter(store, archiveLimits(input));
      if (input.format === 'zip')
        await transfer.restoreZip(input.reference, input.owner, destination);
      else await transfer.restoreTarZstd(input.reference, input.owner, destination);
      const result = {
        ...stageIdentity,
        kind: 'restored_workspace',
        format: input.format,
        restoredDigest: input.reference.digest,
      };
      await writeOutput(outputRoot, 'result.json', Buffer.from(`${JSON.stringify(result)}\n`));
      return result;
    } finally {
      client.destroy?.();
    }
  }

  if (stage === 'dependency_preparation') {
    if (!input.manifest || !input.lockfile || typeof input.gatewayUrl !== 'string')
      throw new Error('PROTOTYPE_INSTALL_INPUT_INVALID');
    const bundle = await installer.install({
      manifest: input.manifest,
      lockfile: input.lockfile,
      gatewayUrl: input.gatewayUrl,
      destination: path.join(workspace, 'install'),
      timeoutMs: input.timeoutMs ?? 120_000,
      maxBundleBytes: input.maxBundleBytes ?? 250_000_000,
    });
    const result = {
      ...stageIdentity,
      kind: 'dependency_bundle',
      size: bundle.length,
      bundleDigest: artifactDigest(bundle),
    };
    await writeOutput(outputRoot, 'dependencies.zip', bundle);
    await writeOutput(outputRoot, 'result.json', Buffer.from(`${JSON.stringify(result)}\n`));
    return result;
  }

  if (stage === 'publish') {
    if (
      !input.owner ||
      !['review_ready', 'completed'].includes(input.target) ||
      !Number.isSafeInteger(input.checkpointRevision) ||
      input.checkpointRevision < 0 ||
      !DIGEST.test(input.templateDigest) ||
      !DIGEST.test(input.toolchainDigest)
    ) {
      throw new Error('PROTOTYPE_PUBLICATION_INPUT_INVALID');
    }
    const checkpoint = await fs.readFile(resolveBelow(workspace, input.checkpointPath));
    const html = await fs.readFile(resolveBelow(workspace, input.htmlPath));
    const sourcesZip = await fs.readFile(resolveBelow(workspace, input.sourcesPath));
    const qaEvidence = await fs.readFile(resolveBelow(workspace, input.qaEvidencePath));
    const checkpointDigest = artifactDigest(checkpoint);
    if (checkpointDigest !== input.checkpointDigest)
      throw new Error('PROTOTYPE_ARTIFACT_DIGEST_MISMATCH');
    const snapshot = {
      html,
      sourcesZip,
      qaEvidence,
      digests: {
        html: artifactDigest(html),
        sourcesZip: artifactDigest(sourcesZip),
        qaEvidence: artifactDigest(qaEvidence),
      },
    };
    for (const [key, digest] of Object.entries(snapshot.digests)) {
      if (digest !== input.digests?.[key]) throw new Error('PROTOTYPE_ARTIFACT_DIGEST_MISMATCH');
    }
    const { client, store } = await loadStorage(env, createS3Client);
    try {
      const references = await new PublicationAdapter(store).publish({
        owner: input.owner,
        snapshot,
        checkpoint,
        checkpointDigest,
        templateDigest: input.templateDigest,
        toolchainDigest: input.toolchainDigest,
      });
      await writeOutput(
        outputRoot,
        'publication.json',
        Buffer.from(
          `${JSON.stringify({
            ...stageIdentity,
            target: input.target,
            checkpoint: { revision: input.checkpointRevision, digest: checkpointDigest },
            templateDigest: input.templateDigest,
            toolchainDigest: input.toolchainDigest,
            references,
          })}\n`,
        ),
      );
      const result = {
        ...stageIdentity,
        kind: 'verified_publication',
        artifactCount: references.length,
      };
      await writeOutput(outputRoot, 'result.json', Buffer.from(`${JSON.stringify(result)}\n`));
      return result;
    } finally {
      client.destroy?.();
    }
  }

  if (!DIGEST.test(input.templateDigest) || !DIGEST.test(input.toolchainDigest))
    throw new Error('PROTOTYPE_BUILD_INPUT_INVALID');
  const snapshot = await buildQa.execute({
    workspace,
    timeoutMs: input.timeoutMs ?? 120_000,
    templateDigest: input.templateDigest,
    toolchainDigest: input.toolchainDigest,
  });
  await writeOutput(outputRoot, 'preview.html', snapshot.html);
  await writeOutput(outputRoot, 'sources.zip', snapshot.sourcesZip);
  await writeOutput(outputRoot, 'qa.json', snapshot.qaEvidence);
  const snapshotDigest = artifactDigest(
    Buffer.from(
      JSON.stringify({
        html: snapshot.digests.html,
        sourcesZip: snapshot.digests.sourcesZip,
        qaEvidence: snapshot.digests.qaEvidence,
      }),
    ),
  );
  const result = {
    ...stageIdentity,
    kind: 'verified_snapshot',
    digests: snapshot.digests,
    snapshotDigest,
  };
  await writeOutput(outputRoot, 'result.json', Buffer.from(`${JSON.stringify(result)}\n`));
  return result;
}
