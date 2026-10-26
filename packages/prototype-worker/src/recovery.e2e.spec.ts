import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalLeaseStore, LocalPrototypeQueue } from './redis/local';
import { PvcPrototypeStorage } from './storage/pvc';
import { PrototypeWorker } from './worker';

const digest = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');

describe('local prototype recovery', () => {
  it('reclaims a failed attempt and publishes exactly one readable review artifact', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-recovery-'));
    try {
      const html = Buffer.from('<main>Recovered preview</main>');
      const capturedLogs: string[] = [];
      const source = path.join(root, 'preview-source.html');
      await fs.writeFile(source, html);
      const storage = new PvcPrototypeStorage(root);
      const queue = new LocalPrototypeQueue();
      let now = 0;
      const leases = new LocalLeaseStore(100, () => now);
      let attempts = 0;
      const command = {
        schemaVersion: 1 as const,
        commandId: 'command_1', kind: 'start_turn' as const, jobId: 'job_recovery',
        turnId: 'turn_1', tenantId: 'tenant_1', modelId: 'fake/model', expectedRevision: 1,
        executionId: 'execution_1', checkpointRevision: null, attachmentManifest: [],
        createdAt: '2026-09-11T09:00:00.000Z',
      };
      queue.publishCommand(command);

      const sourceA = queue.source('worker_a');
      const claimed = await sourceA.next();
      expect(claimed).not.toBeNull();
      attempts += 1;
      await sourceA.close();
      now = 101;

      const sourceB = queue.source('worker_b');
      const workerB = new PrototypeWorker({
        workerId: 'worker_b', source: sourceB, queue, leases,
        execute: async (_command, signal) => {
          attempts += 1;
          capturedLogs.push('fake execution started');
          if (signal.aborted) throw new Error('aborted');
          const artifact = await storage.saveArtifact({
            jobId: 'job_recovery', revision: 1, kind: 'html', source, sha256: digest(html),
          });
          return {
            type: 'review_ready',
            payload: { prototypeSlug: 'recovered-preview', objectKey: artifact.objectKey },
          };
        },
      });
      const recovered = await sourceB.next();
      await workerB.handleCommand(recovered!.streamId, recovered!.command);

      expect(queue.events).toHaveLength(1);
      expect(attempts).toBe(2);
      expect(queue.events[0].type).toBe('review_ready');
      const object = await storage.openObject(String(queue.events[0].payload.objectKey));
      const chunks: Buffer[] = [];
      for await (const chunk of object) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(html);
      expect(JSON.stringify(queue.events)).not.toContain('secret-job-token');
      expect(capturedLogs.join('\n')).not.toContain('secret-job-token');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
