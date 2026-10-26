import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrototypeCommand } from './contracts';
import { interpretTurn } from './execution/interpret';
import { LocalLeaseStore, LocalPrototypeQueue } from './redis/local';
import { PvcPrototypeStorage } from './storage/pvc';
import { PrototypeWorker } from './worker';
import { materializeAttachments } from './attachments';
import { buildCheckpointArchive, buildSourcesArchive, readBuiltPreview } from './execution/artifacts';
import crypto from 'node:crypto';

export function createLocalPipeline(input: {
  storageRoot: string;
  workerId: string;
  runTurn(command: PrototypeCommand, workspace: string, signal: AbortSignal): Promise<string>;
  openAttachment?(fileId: string): Promise<NodeJS.ReadableStream>;
}) {
  const queue = new LocalPrototypeQueue();
  const leases = new LocalLeaseStore();
  const source = queue.source(input.workerId);
  const storage = new PvcPrototypeStorage(input.storageRoot);
  const activeExecutions = new Map<string, AbortController>();
  const workerFor = (workerId: string, commandSource?: typeof source) => new PrototypeWorker({
    workerId,
    source: commandSource,
    queue,
    leases,
    abortExecution: async (jobId, executionId) => {
      activeExecutions.get(`${jobId}:${executionId}`)?.abort();
    },
    execute: async (command, signal) => {
      const executionKey = `${command.jobId}:${command.executionId}`;
      const executionController = new AbortController();
      const abort = () => executionController.abort();
      signal.addEventListener('abort', abort, { once: true });
      activeExecutions.set(executionKey, executionController);
      const workspace = path.join(input.storageRoot, 'local-workspaces', command.executionId);
      await fs.mkdir(path.dirname(workspace), { recursive: true });
      await fs.mkdir(workspace, { recursive: false });
      let checkpointSource: string | undefined;
      try {
        if (command.checkpointRevision != null) {
          await fs.rmdir(workspace);
          await storage.restoreWorkspace({
            jobId: command.jobId,
            checkpointRevision: command.checkpointRevision,
            destination: workspace,
          });
        }
        if (command.attachmentManifest.length > 0) {
          if (!input.openAttachment) throw new Error('Attachment reader is unavailable');
          await materializeAttachments({
            workspace,
            manifest: command.attachmentManifest,
            openAttachment: input.openAttachment,
          });
        }
        const result = interpretTurn(await input.runTurn(command, workspace, executionController.signal));
        checkpointSource = path.join(input.storageRoot, 'local-workspaces', `${command.executionId}.tar.zst`);
        await buildCheckpointArchive(workspace, checkpointSource);
        const checkpointBytes = await fs.readFile(checkpointSource);
        const checkpoint = await storage.saveCheckpoint({
          jobId: command.jobId,
          revision: command.expectedRevision,
          source: checkpointSource,
          sha256: crypto.createHash('sha256').update(checkpointBytes).digest('hex'),
        });
        await fs.rm(checkpointSource, { force: true });
        checkpointSource = undefined;
        if (result.kind === 'waiting') {
          return {
            type: 'waiting',
            payload: { waitingReason: result.waitingReason, text: result.text, checkpoint },
          };
        }
        let preview;
        let sources;
        if (result.kind === 'review') {
          const previewBytes = await readBuiltPreview(workspace).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          });
          if (previewBytes) {
            const previewSource = path.join(workspace, 'dist', 'index.html');
            const stored = await storage.saveArtifact({
              jobId: command.jobId,
              revision: command.expectedRevision,
              kind: 'html',
              source: previewSource,
              sha256: crypto.createHash('sha256').update(previewBytes).digest('hex'),
            });
            preview = stored;
          }
        }
        if (result.kind === 'completed') {
          const archive = await buildSourcesArchive(workspace);
          const archiveSource = path.join(workspace, 'sources.zip');
          await fs.writeFile(archiveSource, archive);
          sources = await storage.saveArtifact({
            jobId: command.jobId,
            revision: command.expectedRevision,
            kind: 'sources_zip',
            source: archiveSource,
            sha256: crypto.createHash('sha256').update(archive).digest('hex'),
          });
        }
        return {
          type: result.kind === 'review' ? 'review_ready' : 'completed',
          payload: {
            prototypeSlug: result.prototypeSlug,
            summary: result.text,
            checkpoint,
            ...(preview ? { preview } : {}),
            ...(sources ? { sources } : {}),
          },
        };
      } finally {
        signal.removeEventListener('abort', abort);
        if (activeExecutions.get(executionKey) === executionController) activeExecutions.delete(executionKey);
        if (checkpointSource) await fs.rm(checkpointSource, { force: true });
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  });
  const worker = workerFor(input.workerId, source);
  return {
    submit(command: PrototypeCommand) { queue.publishCommand(command); },
    async runOnce() {
      const item = await source.next();
      if (item) await worker.processCommand(item.streamId, item.command);
    },
    async runCommand(workerId: string, streamId: string, command: PrototypeCommand) {
      await workerFor(workerId).handleCommand(streamId, command);
    },
    events: () => [...queue.events],
  };
}
