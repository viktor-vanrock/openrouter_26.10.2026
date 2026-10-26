import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  validatePipelineInput,
  pipelineIdentity,
  decodePipelineResult,
  digest,
  REACT_FSD_BUILD_PROFILE,
} from './pipeline-contract.js';
import { verifySourceManifest } from './source-manifest.js';
import { safeDiagnostics } from './pipeline-diagnostics.js';
import { commandLogContext, errorLogFields } from './service-log.js';
import JSZip from 'jszip';
import { inspectZipArchive } from '@librechat/prototype-worker';

/** Gateway build adapter. Mongo-backed callers persist intents before every ambiguous POST. */
export class GatewayPipelineClient {
  constructor({
    gateway,
    image,
    directory,
    log = () => undefined,
    persist,
    repository,
    limits = { cpus: 2, memoryMb: 2048, storageMb: 4096, timeoutMs: 600_000 },
  }) {
    if (repository && typeof persist !== 'function')
      throw new Error('GATEWAY_DURABLE_STORAGE_REQUIRED');
    Object.assign(this, { gateway, image, directory, log, persist, repository, limits });
  }

  async run(input, { signal, timeoutMs = this.limits.timeoutMs, command } = {}) {
    const started = Date.now();
    const log = (event, fields = {}) =>
      this.log(event, { ...commandLogContext(command), executionId: input.executionId, ...fields });
    log('gateway.start');
    if (this.limits.browserQaRequired === true) input = { ...input, validation: 'browser' };
    input = validatePipelineInput(input);
    const multi = input.profile === REACT_FSD_BUILD_PROFILE;
    const runId = `gateway_${randomUUID().replaceAll('-', '')}`;
    const root = path.join(this.directory, runId);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const state = {
      runId,
      inputDigest: pipelineIdentity(input).inputDigest,
      executionId: input.executionId,
      image: this.image,
      startedAt: new Date().toISOString(),
      phase: 'create_intent',
      sandboxId: null,
      sessionId: null,
      offsets: { stdout: 0, stderr: 0 },
    };
    let ledgerRevision = 0;
    if (this.repository) {
      const intent = await this.repository.begin(command, state);
      if (!intent.created) {
        const error = new Error('GATEWAY_EXECUTION_RECOVERY_REQUIRED');
        error.writersStopped = false;
        throw error;
      }
      ledgerRevision = intent.record.ledgerRevision;
    }
    const save = async ({ requireActive = true } = {}) => {
      if (this.repository) {
        const updated = await this.repository.update(
          command,
          ledgerRevision,
          {
            phase: state.phase,
            sandboxId: state.sandboxId,
            sessionId: state.sessionId,
            stdoutOffset: state.offsets.stdout,
            stderrOffset: state.offsets.stderr,
            ...(state.snapshotRefs ? { snapshotRefs: state.snapshotRefs } : {}),
            ...(state.cleanup ? { cleanup: state.cleanup } : {}),
            ...(state.errorCode ? { errorCode: state.errorCode } : {}),
          },
          { requireActive },
        );
        ledgerRevision = updated.ledgerRevision;
      }
      await fs.writeFile(path.join(root, 'execution.json'), JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
    };
    await fs.writeFile(path.join(root, 'input.json'), JSON.stringify(input), { mode: 0o600 });
    await save();
    const deadline = Date.now() + timeoutMs;
    let heartbeat;
    let heartbeating = false;
    let writersStopped = false;
    let verifiedDownloaded = false;
    let savedDurably = false;
    try {
      // A failed/ambiguous create is recorded and never blindly repeated.
      const created = await this.gateway.request('POST', '/sandboxes', {
        body: {
          image: this.image,
          cpus: this.limits.cpus,
          memory_mb: this.limits.memoryMb,
          storage_mb: this.limits.storageMb,
          name: runId,
          labels: { tool: 'chatrouter-prototype', run: runId },
        },
        signal,
      });
      state.sandboxId = created.id;
      state.phase = 'starting';
      await save();
      log('gateway.created', { sandboxId: created.id });
      const base = `/sandboxes/${created.id}`;
      let ready = false;
      while (Date.now() < deadline - 180_000) {
        signal?.throwIfAborted();
        const status = await this.gateway.request('GET', `${base}?wait=10`, {
          timeoutMs: 20_000,
          signal,
        });
        state.phase = status.state;
        await save();
        log('gateway.state', { sandboxId: state.sandboxId, state: status.state });
        if (status.state === 'failed') throw new Error('GATEWAY_SANDBOX_FAILED');
        if (status.state === 'ready') {
          ready = true;
          break;
        }
      }
      if (!ready) throw new Error('GATEWAY_START_DEADLINE');
      heartbeat = setInterval(async () => {
        if (heartbeating) return;
        heartbeating = true;
        try {
          await this.gateway.request('GET', base);
        } catch (error) {
          log('gateway.heartbeat_failed', errorLogFields(error));
        } finally {
          heartbeating = false;
        }
      }, 20_000);
      await this.gateway.request('PUT', `${base}/files?path=%2Frun%2Finput%2Finput.json`, {
        body: Buffer.from(JSON.stringify(input)),
        signal,
      });
      state.phase = 'session_intent';
      await save();
      const session = await this.gateway.request('POST', `${base}/sessions`, {
        body: {
          argv: ['node', '/opt/prototype/runner/build.mjs'],
          cwd: '/opt/prototype/runner',
          env: {},
        },
        signal,
      });
      state.sessionId = session.id;
      state.phase = 'running';
      await save();
      log('gateway.session_started', { sandboxId: state.sandboxId, sessionId: session.id });
      const sessionPath = `${base}/sessions/${session.id}`;
      const live = new AbortController();
      const follow = async (stream) => {
        let remainder = '';
        while (!live.signal.aborted) {
          try {
            await this.gateway.request(
              'GET',
              `${sessionPath}/logs?stream=${stream}&offset=${state.offsets[stream]}&follow=1`,
              {
                raw: true,
                maxBytes: 1_000_000,
                timeoutMs: 20_000,
                signal: live.signal,
                onChunk: (bytes) => {
                  state.offsets[stream] += bytes.length;
                  remainder += bytes.toString('utf8');
                  const lines = remainder.split('\n');
                  remainder = lines.pop();
                  for (const line of safeDiagnostics(
                    lines.filter((value) => !value.startsWith('PROTOTYPE_PIPELINE_RESULT=')),
                  )) {
                    log('gateway.log', {
                      sandboxId: state.sandboxId,
                      sessionId: state.sessionId,
                      stream,
                      line,
                    });
                  }
                },
              },
            );
          } catch {
            if (!live.signal.aborted) await delay(500);
          }
        }
      };
      const readers = ['stdout', 'stderr'].map(follow);
      let result;
      try {
        while (Date.now() < deadline) {
          signal?.throwIfAborted();
          const status = await this.gateway.request('GET', sessionPath, { signal });
          await save();
          if (!status.running) {
            result = status;
            break;
          }
          await delay(1000, undefined, { signal });
        }
      } finally {
        live.abort();
        await Promise.allSettled(readers);
      }
      if (!result) throw new Error('GATEWAY_BUILD_DEADLINE');
      log('gateway.session_finished', {
        sandboxId: state.sandboxId,
        sessionId: state.sessionId,
        exitCode: result.exit_code,
      });
      // This flag means the trusted fixed build runner drained its managed children,
      // never a claim that DELETE proves whole-Pod/cgroup termination.
      const bytes = await this.gateway.request(
        'GET',
        `${base}/files?path=%2Frun%2Foutput%2Fresult.json`,
        { raw: true, maxBytes: 64000, signal },
      );
      const manifest = JSON.parse(bytes);
      writersStopped = manifest.managedWritersStopped === true;
      if (result.exit_code !== 0 || manifest.passed !== true) {
        const error = new Error('PIPELINE_EXECUTION_FAILED');
        error.failureCode = manifest.code || 'PROTOTYPE_BUILD_FAILED';
        error.diagnostics = safeDiagnostics(manifest.diagnostics);
        throw error;
      }
      if (
        !writersStopped ||
        manifest.executionId !== input.executionId ||
        manifest.inputDigest !== state.inputDigest
      ) {
        throw new Error('GATEWAY_RESULT_IDENTITY_INVALID');
      }
      const names = { html: 'preview.html', sourcesZip: 'sources.zip', qaEvidence: 'qa.json' };
      const artifacts = {};
      for (const [kind, name] of Object.entries(names)) {
        const content = await this.gateway.request(
          'GET',
          `${base}/files?path=${encodeURIComponent(`/run/output/${name}`)}`,
          {
            raw: true,
            maxBytes: multi && kind === 'sourcesZip' ? 5 * 1024 * 1024 : 3_000_000,
            signal,
          },
        );
        if (digest(content) !== manifest.digests[kind])
          throw new Error('GATEWAY_ARTIFACT_DIGEST_INVALID');
        await fs.writeFile(path.join(root, name), content, { mode: 0o600 });
        artifacts[kind] = { base64: content.toString('base64'), digest: digest(content) };
      }
      const envelope = {
        executionId: input.executionId,
        inputDigest: state.inputDigest,
        profile: input.profile,
        artifacts,
      };
      if (Buffer.byteLength(JSON.stringify(envelope)) > (multi ? 12 * 1024 * 1024 : 4_000_000))
        throw new Error('PIPELINE_OUTPUT_TOO_LARGE');
      const snapshot = decodePipelineResult(input, envelope);
      const evidence = JSON.parse(snapshot.qaEvidence);
      if (
        evidence.htmlDigest !== snapshot.digests.html ||
        evidence.sourcesDigest !== snapshot.digests.sourcesZip
      ) {
        throw new Error('GATEWAY_EVIDENCE_DIGEST_INVALID');
      }
      await inspectZipArchive(snapshot.sourcesZip, {
        maxArchiveBytes: multi ? 5 * 1024 * 1024 : 3_000_000,
        maxExpandedBytes: 20 * 1024 * 1024,
        maxFiles: multi ? 600 : 1000,
        maxPathBytes: 1024,
        maxCompressionRatio: 100,
        maxDurationMs: 10_000,
      });
      const zip = await JSZip.loadAsync(snapshot.sourcesZip);
      if (multi) {
        const sources = {};
        for (const file of input.sourceManifest.files) {
          const entry = zip.file(file.path);
          if (!entry) throw new Error('GATEWAY_SOURCE_BINDING_INVALID');
          sources[file.path] = await entry.async('string');
        }
        verifySourceManifest(input.sourceManifest, sources);
        if (
          !evidence.fixedFiles ||
          !evidence.fixedSources ||
          digest(JSON.stringify(evidence.fixedFiles)) !== input.sourceManifest.templateDigest
        ) {
          throw new Error('GATEWAY_CONFIG_BINDING_INVALID');
        }
        for (const [name, expected] of Object.entries({
          ...evidence.fixedFiles,
          ...evidence.fixedSources,
        })) {
          const entry = zip.file(name);
          if (!entry || digest(await entry.async('nodebuffer')) !== expected)
            throw new Error('GATEWAY_CONFIG_BINDING_INVALID');
        }
        const expectedSources = new Set([
          ...Object.keys(sources),
          ...Object.keys(evidence.fixedSources),
          'source-manifest.json',
        ]);
        if (
          Object.values(zip.files).some((entry) => !entry.dir && !expectedSources.has(entry.name))
        ) {
          throw new Error('GATEWAY_SOURCE_BINDING_INVALID');
        }
        if (
          JSON.stringify(JSON.parse(await zip.file('source-manifest.json')?.async('string'))) !==
          JSON.stringify(input.sourceManifest)
        ) {
          throw new Error('GATEWAY_SOURCE_BINDING_INVALID');
        }
      } else if ((await zip.file('src/app/App.tsx')?.async('string')) !== input.source)
        throw new Error('GATEWAY_SOURCE_BINDING_INVALID');
      const forbidden = Object.values(zip.files).some(
        (entry) =>
          /(^|\/)(?:\.env|\.npmrc|\.git|node_modules)(\/|$)/.test(entry.name) ||
          (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name),
      );
      if (forbidden) throw new Error('GATEWAY_ARCHIVE_REJECTED');
      verifiedDownloaded = true;
      const references = await this.persist?.({ input, snapshot, execution: state, command });
      if (this.repository && (!Array.isArray(references) || references.length !== 3)) {
        throw new Error('GATEWAY_DURABLE_SNAPSHOT_INVALID');
      }
      state.snapshotRefs = references;
      savedDurably = true;
      state.phase = 'downloaded_verified';
      state.digests = snapshot.digests;
      await save();
      log('gateway.finished', { elapsedMs: Date.now() - started, writersStopped });
      return snapshot;
    } catch (error) {
      log('gateway.failed', {
        ...errorLogFields(error),
        sandboxId: state.sandboxId,
        sessionId: state.sessionId,
        elapsedMs: Date.now() - started,
      });
      state.phase = 'failed_or_unknown';
      state.errorCode = /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)
        ? error.message
        : 'GATEWAY_OPERATION_FAILED';
      await save({ requireActive: false });
      error.writersStopped = writersStopped;
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (state.sandboxId) {
        // Keep verified output recoverable if the durable upload failed. Cleanup debt is explicit.
        if (this.repository && verifiedDownloaded && !savedDurably) {
          state.cleanup = 'publication_pending';
          await save({ requireActive: false });
        } else {
          if (state.sessionId)
            await this.gateway
              .request('DELETE', `/sandboxes/${state.sandboxId}/sessions/${state.sessionId}`)
              .catch(() => undefined);
          try {
            await this.gateway.request('DELETE', `/sandboxes/${state.sandboxId}`);
            state.cleanup = 'delete_acknowledged';
          } catch {
            state.cleanup = 'delete_unknown';
          }
          state.finishedAt = new Date().toISOString();
          await save({ requireActive: false });
        }
        log('gateway.cleanup', {
          sandboxId: state.sandboxId,
          sessionId: state.sessionId,
          cleanup: state.cleanup,
        });
      }
    }
  }
}
