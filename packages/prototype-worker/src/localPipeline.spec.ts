import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createLocalPipeline } from './localPipeline';

describe('local prototype pipeline', () => {
  it('restores a workspace, runs a fake marked turn, and publishes one review event', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const pipeline = createLocalPipeline({
        storageRoot: root,
        workerId: 'worker_local',
        runTurn: jest.fn(async () => 'Summary\nPROTOTYPE_READY: crm'),
      });
      pipeline.submit({
        schemaVersion: 1, commandId: 'command_1', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_1', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 0,
        executionId: 'execution_1', checkpointRevision: null, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:00.000Z',
      });
      await pipeline.runOnce();
      expect(pipeline.events()).toEqual([
        expect.objectContaining({ type: 'review_ready', commandId: 'command_1' }),
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('restores a saved checkpoint before running the next local turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const seed = path.join(root, 'seed');
      const archive = path.join(root, 'checkpoint.tar.zst');
      await fs.mkdir(seed);
      await fs.writeFile(path.join(seed, 'context.txt'), 'restored context');
      const { execFileSync } = await import('node:child_process');
      execFileSync('tar', ['--zstd', '-cf', archive, '-C', seed, '.']);
      const bytes = await fs.readFile(archive);
      const crypto = await import('node:crypto');
      const { PvcPrototypeStorage } = await import('./storage/pvc');
      await new PvcPrototypeStorage(root).saveCheckpoint({
        jobId: 'job_local', revision: 1, source: archive,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
      const runTurn = jest.fn(async (_command, workspace) => {
        expect(await fs.readFile(path.join(workspace, 'context.txt'), 'utf8')).toBe('restored context');
        return 'Summary\nPROTOTYPE_READY: crm';
      });
      const pipeline = createLocalPipeline({ storageRoot: root, workerId: 'worker_local', runTurn });
      pipeline.submit({
        schemaVersion: 1, commandId: 'command_2', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_2', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 1,
        executionId: 'execution_2', checkpointRevision: 1, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:00.000Z',
      });
      await pipeline.runOnce();
      expect(runTurn).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('checkpoints a successful turn and restores it for the next turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const observed: string[] = [];
      const pipeline = createLocalPipeline({
        storageRoot: root,
        workerId: 'worker_local',
        runTurn: async (command, workspace) => {
          if (command.turnId === 'turn_checkpoint_1') {
            await fs.writeFile(path.join(workspace, 'context.txt'), 'created by first turn');
          } else {
            observed.push(await fs.readFile(path.join(workspace, 'context.txt'), 'utf8'));
          }
          return 'Question\nWAITING_FOR_CLARIFICATION';
        },
      });
      pipeline.submit({
        schemaVersion: 1, commandId: 'command_checkpoint_1', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_checkpoint_1', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 7,
        executionId: 'execution_checkpoint_1', checkpointRevision: null, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:00.000Z',
      });
      await pipeline.runOnce();

      expect(pipeline.events()[0]).toMatchObject({
        type: 'waiting',
        payload: {
          checkpoint: { objectKey: 'jobs/job_local/checkpoints/7/workspace.tar.zst' },
        },
      });

      pipeline.submit({
        schemaVersion: 1, commandId: 'command_checkpoint_2', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_checkpoint_2', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 8,
        executionId: 'execution_checkpoint_2', checkpointRevision: 7, attachmentManifest: [],
        createdAt: '2026-09-11T09:01:00.000Z',
      });
      await pipeline.runOnce();

      expect(observed).toEqual(['created by first turn']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('replays the same successful turn as an idempotent checkpoint publication', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const run = async (workerId: string, commandId: string, executionId: string) => {
        const pipeline = createLocalPipeline({
          storageRoot: root,
          workerId,
          runTurn: async (_command, workspace) => {
            await fs.writeFile(path.join(workspace, 'context.txt'), 'stable checkpoint');
            return 'Question\nWAITING_FOR_CLARIFICATION';
          },
        });
        pipeline.submit({
          schemaVersion: 1, commandId, kind: 'start_turn', jobId: 'job_local',
          turnId: 'turn_checkpoint_replay', tenantId: 'tenant_1', modelId: 'fake/model',
          expectedRevision: 12, executionId, checkpointRevision: null, attachmentManifest: [],
          createdAt: '2026-09-11T09:00:00.000Z',
        });
        await pipeline.runOnce();
        return pipeline.events()[0];
      };

      const first = await run('worker_a', 'command_checkpoint_a', 'execution_checkpoint_a');
      const replay = await run('worker_b', 'command_checkpoint_b', 'execution_checkpoint_b');

      expect(first.type).toBe('waiting');
      expect(replay.type).toBe('waiting');
      expect(replay.payload.checkpoint).toEqual(first.payload.checkpoint);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('materializes only command-manifest attachments before the turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const attachment = path.join(root, 'attachment.bin');
      await fs.writeFile(attachment, 'input');
      const runTurn = jest.fn(async (_command, workspace) => {
        expect(await fs.readFile(path.join(workspace, 'inputs/001-input.txt'), 'utf8')).toBe('input');
        return 'Question\nWAITING_FOR_PLAN_APPROVAL';
      });
      const pipeline = createLocalPipeline({
        storageRoot: root,
        workerId: 'worker_local',
        runTurn,
        openAttachment: async () => fs.open(attachment, 'r').then((handle) => handle.createReadStream()),
      });
      pipeline.submit({
        schemaVersion: 1, commandId: 'command_3', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_3', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 2,
        executionId: 'execution_3', checkpointRevision: null,
        attachmentManifest: [{ fileId: 'file_1', filename: 'input.txt', mimeType: 'text/plain', size: 5 }],
        createdAt: '2026-09-11T09:00:00.000Z',
      });
      await pipeline.runOnce();
      expect(pipeline.events()[0]).toMatchObject({
        type: 'waiting', payload: { waitingReason: 'plan_approval' },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('publishes a safe failed result and removes the workspace when a local turn fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const pipeline = createLocalPipeline({
        storageRoot: root,
        workerId: 'worker_local',
        runTurn: jest.fn(async () => {
          throw new Error('Bearer secret-token at /private/tmp/workspace');
        }),
      });
      pipeline.submit({
        schemaVersion: 1, commandId: 'command_4', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_4', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 3,
        executionId: 'execution_4', checkpointRevision: null, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:00.000Z',
      });
      await pipeline.runOnce();
      expect(pipeline.events()).toEqual([
        expect.objectContaining({
          type: 'failed',
          payload: { code: 'PROTOTYPE_EXECUTION_FAILED', message: 'Prototype execution failed' },
        }),
      ]);
      await expect(fs.stat(path.join(root, 'local-workspaces/execution_4'))).rejects.toThrow();
      expect(JSON.stringify(pipeline.events())).not.toContain('secret-token');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not publish a second result when an acknowledged command is submitted again', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const runTurn = jest.fn(async () => 'Summary\nPROTOTYPE_READY: crm');
      const pipeline = createLocalPipeline({ storageRoot: root, workerId: 'worker_local', runTurn });
      const command = {
        schemaVersion: 1 as const, commandId: 'command_repeat', kind: 'start_turn' as const,
        jobId: 'job_local', turnId: 'turn_repeat', tenantId: 'tenant_1', modelId: 'fake/model',
        expectedRevision: 4, executionId: 'execution_repeat', checkpointRevision: null,
        attachmentManifest: [], createdAt: '2026-09-11T09:00:00.000Z',
      };
      pipeline.submit(command);
      await pipeline.runOnce();
      pipeline.submit(command);
      await pipeline.runOnce();
      expect(runTurn).toHaveBeenCalledTimes(1);
      expect(pipeline.events()).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('cancels an active turn through the assembled local pipeline', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const started = Promise.withResolvers<void>();
      const pipeline = createLocalPipeline({
        storageRoot: root,
        workerId: 'worker_local',
        runTurn: async (_command, _workspace, signal) => {
          started.resolve();
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('turn aborted')), { once: true });
          });
        },
      });
      pipeline.submit({
        schemaVersion: 1, commandId: 'command_cancel_target', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_cancel_target', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 5,
        executionId: 'execution_cancel_target', checkpointRevision: null, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:00.000Z',
      });
      const running = pipeline.runOnce();
      await started.promise;

      pipeline.submit({
        schemaVersion: 1, commandId: 'command_cancel', kind: 'cancel_execution', jobId: 'job_local',
        turnId: 'turn_cancel_target', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 5,
        executionId: 'execution_cancel_target', checkpointRevision: null, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:01.000Z',
      });
      await pipeline.runOnce();
      await running;

      expect(pipeline.events()).toEqual([]);
      await expect(fs.stat(path.join(root, 'local-workspaces/execution_cancel_target'))).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('allows only one assembled local worker to publish for a job lease', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const release = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const pipeline = createLocalPipeline({
        storageRoot: root,
        workerId: 'worker_a',
        runTurn: async () => {
          started.resolve();
          await release.promise;
          return 'Summary\nPROTOTYPE_READY: crm';
        },
      });
      const command = {
        schemaVersion: 1, commandId: 'command_concurrent', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_concurrent', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 11,
        executionId: 'execution_concurrent', checkpointRevision: null, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:00.000Z',
      } as const;

      const first = pipeline.runCommand('worker_a', 'local-a', command);
      await started.promise;
      await expect(pipeline.runCommand('worker_b', 'local-b', command)).rejects.toThrow('lease');
      release.resolve();
      await first;

      expect(pipeline.events()).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('publishes a readable immutable HTML artifact with a review-ready result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const pipeline = createLocalPipeline({
        storageRoot: root,
        workerId: 'worker_local',
        runTurn: async (_command, workspace) => {
          await fs.mkdir(path.join(workspace, 'dist'));
          await fs.writeFile(path.join(workspace, 'dist/index.html'), '<main>local preview</main>');
          return 'Summary\nPROTOTYPE_READY: crm';
        },
      });
      pipeline.submit({
        schemaVersion: 1, commandId: 'command_preview', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_preview', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 5,
        executionId: 'execution_preview', checkpointRevision: null, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:00.000Z',
      });
      await pipeline.runOnce();
      expect(pipeline.events()[0]).toMatchObject({
        type: 'review_ready',
        payload: {
          prototypeSlug: 'crm',
          preview: {
            objectKey: 'jobs/job_local/artifacts/5/preview.html',
            size: 26,
          },
        },
      });
      expect(
        await fs.readFile(path.join(root, 'jobs/job_local/artifacts/5/preview.html'), 'utf8'),
      ).toBe('<main>local preview</main>');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('publishes a source archive with a completed result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const pipeline = createLocalPipeline({
        storageRoot: root,
        workerId: 'worker_local',
        runTurn: async (_command, workspace) => {
          await fs.mkdir(path.join(workspace, 'src'));
          await fs.writeFile(path.join(workspace, 'src/app.ts'), 'export const app = true;');
          return 'Approved\nPROTOTYPE_FINALIZED: crm';
        },
      });
      pipeline.submit({
        schemaVersion: 1, commandId: 'command_sources', kind: 'start_turn', jobId: 'job_local',
        turnId: 'turn_sources', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 6,
        executionId: 'execution_sources', checkpointRevision: null, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:00.000Z',
      });
      await pipeline.runOnce();
      expect(pipeline.events()[0]).toMatchObject({
        type: 'completed',
        payload: {
          sources: { objectKey: 'jobs/job_local/artifacts/6/sources.zip' },
        },
      });
      expect((await fs.stat(path.join(root, 'jobs/job_local/artifacts/6/sources.zip'))).size).toBeGreaterThan(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'preview',
      revision: 9,
      marker: 'Summary\nPROTOTYPE_READY: crm',
      objectKey: 'jobs/job_local/artifacts/9/preview.html',
      resultField: 'preview',
      prepare: async (workspace: string) => {
        await fs.mkdir(path.join(workspace, 'dist'));
        await fs.writeFile(path.join(workspace, 'dist/index.html'), '<main>digest preview</main>');
      },
    },
    {
      name: 'sources',
      revision: 10,
      marker: 'Approved\nPROTOTYPE_FINALIZED: crm',
      objectKey: 'jobs/job_local/artifacts/10/sources.zip',
      resultField: 'sources',
      prepare: async (workspace: string) => {
        await fs.mkdir(path.join(workspace, 'src'));
        await fs.writeFile(path.join(workspace, 'src/app.ts'), 'export const app = true;');
      },
    },
  ])('publishes an idempotent $name artifact with its verified digest', async (scenario) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-pipeline-'));
    try {
      const pipeline = createLocalPipeline({
        storageRoot: root,
        workerId: 'worker_local',
        runTurn: async (_command, workspace) => {
          await scenario.prepare(workspace);
          return scenario.marker;
        },
      });
      const command = {
        schemaVersion: 1 as const, commandId: `command_${scenario.name}_digest`, kind: 'start_turn' as const,
        jobId: 'job_local', turnId: `turn_${scenario.name}_digest`, tenantId: 'tenant_1',
        modelId: 'fake/model', expectedRevision: scenario.revision,
        executionId: `execution_${scenario.name}_digest`, checkpointRevision: null,
        attachmentManifest: [], createdAt: '2026-09-11T09:00:00.000Z',
      };
      pipeline.submit(command);
      await pipeline.runOnce();

      const bytes = await fs.readFile(path.join(root, scenario.objectKey));
      const artifact = pipeline.events()[0].payload[scenario.resultField] as {
        objectKey: string;
        size: number;
        sha256: string;
      };
      expect(artifact).toEqual({
        objectKey: scenario.objectKey,
        size: bytes.byteLength,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });

      pipeline.submit(command);
      await pipeline.runOnce();
      expect(pipeline.events()).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
