import fs from 'node:fs/promises';
import path from 'node:path';
import { runAsSystem } from '@librechat/data-schemas';
import { PublicationAdapter, S3ArtifactStore, artifactDigest } from '@librechat/prototype-worker';
import { LocalLiveModel } from './local-live-model.js';
import { reactPrototypeSource } from './react-prototype.js';
import { reservePersonalModelRequest, settlePersonalModelRequest } from './local-model-budget.js';
import { localModelLimitUsd } from './local-model-settings.js';
import { REACT_BUILD_PROFILE } from './pipeline-contract.js';
import { buildCheckpointArchive } from '@librechat/prototype-worker';
import JSZip from 'jszip';
import { selectedPrototypeVariant, prototypeContext } from './prototype-dialogue.js';
import { safeDiagnostics } from './pipeline-diagnostics.js';
import { serviceLogger } from './local-log.js';
import { commandLogContext, errorLogFields } from './service-log.js';
import { repairUiKitSource } from './react-kit-repair.js';

const safeModelError = (error) =>
  /^LIVE_MODEL_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'LIVE_MODEL_UPSTREAM_UNAVAILABLE';
const modelMessages = {
  LIVE_MODEL_CONTENT_BLOCKED:
    'Запрос отклонён по правилам содержания. Сервис не создаёт прототипы с запрещённым содержанием.',
  LIVE_MODEL_REACT_INVALID: 'Не удалось подготовить рабочий прототип. Результат не опубликован.',
  LIVE_MODEL_PLAN_INVALID:
    'Не удалось подготовить уточнение или план. Создание прототипа ещё не началось.',
  LIVE_MODEL_PROMPT_TOO_LARGE:
    'История, исходник и системные инструкции превышают предел 1 МБ. Последняя рабочая версия сохранена; сократите требования этого хода.',
  LIVE_MODEL_DESIGN_VARIANTS_MISSING:
    'Модель не реализовала выбор вариантов дизайна. Результат не опубликован.',
  LIVE_MODEL_FINAL_VARIANT_INVALID:
    'Модель не убрала переключатель из финальной версии. Результат не опубликован.',
  LIVE_MODEL_BUDGET_ALREADY_RESERVED:
    'Этот запрос уже отправлялся. Нажмите «Повторить», чтобы начать новую попытку.',
  LIVE_MODEL_TIMEOUT:
    'Модель не ответила за отведённое время. Попробуйте повторить запрос или выберите другую модель.',
  LIVE_MODEL_UPSTREAM_UNAVAILABLE: 'Не удалось получить ответ модели. Попробуйте повторить запрос.',
  LIVE_MODEL_PROVIDER_FUNDS_REQUIRED:
    'Провайдер модели сообщает о недостатке средств. Пополните баланс или измените лимит ключа.',
  LIVE_MODEL_RATE_LIMITED: 'Провайдер временно ограничил запросы. Повторите попытку немного позже.',
  LIVE_MODEL_OUTPUT_LIMIT: 'Модель достигла лимита ответа и не дописала прототип.',
  LIVE_MODEL_OUTPUT_INCOMPLETE: 'Модель не завершила создание прототипа.',
};

export class LocalReactStages {
  constructor({
    mongoose,
    models,
    methods,
    pipeline,
    storage,
    storageBucket = process.env.AWS_BUCKET_NAME,
    directory,
    gatewayUrl,
    createModel = (options) => new LocalLiveModel(options),
    budget = reservePersonalModelRequest,
    log,
    describeSource,
  }) {
    Object.assign(this, {
      mongoose,
      models,
      methods,
      pipeline,
      storage,
      directory,
      gatewayUrl,
      createModel,
      budget,
      describeSource,
    });
    this.abort = new AbortController();
    this.commandSignals = new Map();
    this.log = log ?? serviceLogger(directory);
    this.publication = storage
      ? new PublicationAdapter(new S3ArtifactStore(storage, storageBucket))
      : null;
  }

  async writeOutput(command, files, succeeded = true) {
    const outputRoot = path.join(this.directory, 'outputs', command.commandId);
    await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of Object.entries(files))
      await fs.writeFile(path.join(outputRoot, name), bytes, { mode: 0o600 });
    return { outputRoot, succeeded, writersStopped: true };
  }

  async active(command) {
    const job = await this.models.PrototypeJob.findOne({
      jobId: command.jobId,
      activeTurnId: command.turnId,
      activeCommandId: command.commandId,
      activeExecutionId: command.executionId,
      activeAttemptId: command.attemptId,
      activeStage: command.stage,
      revision: command.expectedRevision,
      fenceToken: command.fenceToken,
      accessRevokedAt: null,
      ...Object.fromEntries(
        ['userId', 'tenantId', 'modelId']
          .filter((key) => command[key] != null)
          .map((key) => [key, command[key]]),
      ),
    }).lean();
    return (
      job &&
      !['failed', 'canceled'].includes(job.status) &&
      job.activeTurnId === command.turnId &&
      job.activeCommandId === command.commandId &&
      job.activeExecutionId === command.executionId
    );
  }

  turnDirectory(command) {
    return path.join(this.directory, 'turns', command.turnId);
  }

  async saveModelMetrics(command, purpose, values, suffix = '') {
    const db = this.mongoose?.connection?.db;
    if (!db) return;
    await db.collection('prototypemodelmetrics').updateOne(
      { _id: `${command.commandId}:${purpose}${suffix}` },
      {
        $set: {
          jobId: command.jobId,
          turnId: command.turnId,
          commandId: command.commandId,
          purpose,
          ...values,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  modelCallbacks(command, purpose) {
    const context = commandLogContext(command);
    return {
      onEvent: (event, fields) => this.log(event, { ...fields, ...context, purpose }),
      authorizeQuote: async (quotedUpperUsd, estimate) => {
        await this.saveModelMetrics(command, purpose, {
          estimate,
          upperCostUsd: quotedUpperUsd,
          status: 'estimating',
        });
        await this.budget({ mongoose: this.mongoose, command, quotedUpperUsd, purpose });
        await this.saveModelMetrics(command, purpose, { status: 'running' });
        this.log('model.start', {
          ...context,
          purpose,
          code: purpose.toUpperCase(),
          upperCostUsd: quotedUpperUsd,
          inputTokens: estimate?.inputTokens,
          maxOutputTokens: estimate?.maxOutputTokens,
        });
      },
      onUsage: async (usage) => {
        const cost = Number.isFinite(usage?.cost) && usage.cost >= 0 ? usage.cost : null;
        await this.saveModelMetrics(command, purpose, {
          status: 'answered',
          actualCostUsd: cost,
          promptTokens:
            Number.isSafeInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0
              ? usage.prompt_tokens
              : null,
          completionTokens:
            Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0
              ? usage.completion_tokens
              : null,
        });
        await settlePersonalModelRequest({ mongoose: this.mongoose, command, purpose, usage });
        this.log('model.usage', {
          ...context,
          purpose,
          code: purpose.toUpperCase(),
          actualCostUsd: cost,
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
        });
      },
    };
  }

  async execute(command) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.abort.signal]);
    this.commandSignals.set(command.commandId, signal);
    let checking = false;
    const watch = this.models?.PrototypeJob
      ? setInterval(async () => {
          if (checking || signal.aborted) return;
          checking = true;
          try {
            if (Date.parse(command.deadlineAt) <= Date.now() || !(await this.active(command)))
              controller.abort();
          } catch {
            controller.abort();
          } finally {
            checking = false;
          }
        }, 500)
      : null;
    watch?.unref();
    try {
      return await this.executeActive(command);
    } finally {
      clearInterval(watch);
      this.commandSignals.delete(command.commandId);
    }
  }

  async executeActive(command) {
    const started = Date.now();
    const context = commandLogContext(command);
    this.log('stage.start', context);
    const cached = path.join(this.directory, 'outputs', command.commandId);
    for (const name of [
      'failure.json',
      command.stage === 'publish' ? 'publication.json' : 'result.json',
    ]) {
      try {
        await fs.access(path.join(cached, name));
        this.log('stage.cached', { ...context, elapsedMs: Date.now() - started });
        return { outputRoot: cached, succeeded: name !== 'failure.json', writersStopped: true };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const root = this.turnDirectory(command);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    try {
      const output = await this.run(command, root);
      this.log('stage.finished', { ...context, elapsedMs: Date.now() - started });
      return output;
    } catch (error) {
      if (this.abort.signal.aborted || !(await this.active(command))) {
        this.log('stage.aborted', {
          ...context,
          ...errorLogFields(error),
          elapsedMs: Date.now() - started,
        });
        throw error;
      }
      if (command.stage === 'build_qa' && error.writersStopped !== true) {
        this.log('stage.failed', {
          ...context,
          ...errorLogFields(error),
          writersStopped: false,
          elapsedMs: Date.now() - started,
        });
        throw error;
      }
      const modelCode = safeModelError(error);
      const diagnostics = safeDiagnostics(error.diagnostics);
      const code =
        command.stage === 'generation'
          ? modelCode
          : (error.failureCode ?? 'PIPELINE_EXECUTION_FAILED');
      if (
        command.stage === 'generation' &&
        typeof error.rawSource === 'string' &&
        Buffer.byteLength(error.rawSource) <= 200_000 &&
        /^[a-zA-Z0-9_.:-]{1,256}$/.test(command.commandId)
      ) {
        // Private diagnostic evidence, excluded from durable workspace/public artifact allowlists.
        try {
          await fs.writeFile(
            path.join(root, `rejected-model-${command.commandId}.txt`),
            error.rawSource,
            { mode: 0o600, flag: 'wx' },
          );
          this.log('model.response_saved', context);
        } catch (captureError) {
          if (captureError.code !== 'EEXIST')
            this.log('model.response_save_failed', {
              ...context,
              ...errorLogFields(captureError, 'PROTOTYPE_RESPONSE_CAPTURE_FAILED'),
            });
        }
      }
      if (command.stage === 'generation' && this.mongoose?.connection?.db) {
        await this.mongoose.connection.db.collection('prototypemodelmetrics').updateMany(
          {
            jobId: command.jobId,
            commandId: command.commandId,
            status: { $in: ['estimating', 'running', 'answered'] },
          },
          { $set: { status: 'failed', updatedAt: new Date() } },
        );
      }
      this.log('stage.failed', {
        ...context,
        ...errorLogFields(error),
        elapsedMs: Date.now() - started,
        code,
        diagnostics,
      });
      return this.writeOutput(
        command,
        {
          'failure.json': JSON.stringify({
            ...command,
            type: 'failed',
            code:
              command.stage === 'build_qa'
                ? ['PROTOTYPE_QA_FAILED', 'PROTOTYPE_QA_INFRASTRUCTURE_FAILED'].includes(code)
                  ? code
                  : 'PROTOTYPE_BUILD_FAILED'
                : 'PROTOTYPE_EXECUTION_FAILED',
            message:
              command.stage === 'generation'
                ? modelCode === 'LIVE_MODEL_BUDGET_EXCEEDED'
                  ? `Достигнут лимит $${localModelLimitUsd()} на этот запрос с учётом повторных попыток.`
                  : (modelMessages[modelCode] ??
                    'Не удалось создать прототип. Проверьте выбранную модель и подключение к ней.')
                : code === 'PROTOTYPE_QA_INFRASTRUCTURE_FAILED'
                  ? 'Проверка интерфейса временно недоступна. Результат не опубликован; повторите попытку позже.'
                  : 'Не удалось подготовить прототип к просмотру. Результат не опубликован.',
            retryable:
              command.stage === 'build_qa' &&
              ['PROTOTYPE_QA_FAILED', 'PROTOTYPE_BUILD_FAILED'].includes(code) &&
              diagnostics.length > 0,
            diagnostics: diagnostics.length
              ? diagnostics.map((value) => value.slice(0, 2000))
              : [code],
          }),
        },
        false,
      );
    }
  }

  async run(command, root) {
    const sourcePath = path.join(root, 'App.tsx');
    if (command.stage === 'generation') {
      let source;
      if (command.repair) {
        source = await this.repairSource(command, root);
      } else
        try {
          source = reactPrototypeSource(await fs.readFile(sourcePath, 'utf8'));
          const repaired = repairUiKitSource(source);
          if (repaired.changed) {
            await fs.writeFile(path.join(root, 'App.before-kit-repair.tsx'), source, {
              mode: 0o600,
            });
            source = repaired.source;
            await fs.writeFile(sourcePath, source, { mode: 0o600 });
            this.log('source.repaired', {
              ...commandLogContext(command),
              code: 'SOURCE_STATIC_REPAIR',
            });
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const turns = await this.models.PrototypeTurn.find({ jobId: command.jobId })
            .sort({ ordinal: 1 })
            .select('text turnId')
            .lean();
          const requirements = turns.map((turn) => turn.text).join('\n\nСледующее изменение:\n');
          const job = await this.models.PrototypeJob.findOne({ jobId: command.jobId }).lean();
          const acceptedTurns = new Set((job.versions ?? []).map((version) => version.turnId));
          let previousSource;
          for (const turn of [...turns].reverse()) {
            if (!acceptedTurns.has(turn.turnId) || turn.turnId === command.turnId) continue;
            const previousRoot = path.join(this.directory, 'turns', turn.turnId);
            try {
              // Only an accepted, built version can be the base for review edits.
              await fs.access(path.join(previousRoot, 'snapshot.json'));
              previousSource = await fs.readFile(path.join(previousRoot, 'App.tsx'), 'utf8');
              break;
            } catch (previousError) {
              if (previousError.code !== 'ENOENT') throw previousError;
            }
          }
          const chosenVariant =
            job.selectedVariant ??
            [...turns]
              .reverse()
              .filter((turn) => acceptedTurns.has(turn.turnId))
              .map((turn) => selectedPrototypeVariant(turn.text ?? ''))
              .find(Boolean) ??
            null;
          const planPath = path.join(root, 'plan.json');
          let plan;
          try {
            plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
          } catch (planError) {
            if (planError.code !== 'ENOENT') throw planError;
          }
          if (plan?.schemaVersion === 1 && plan.framework === 'react' && !plan.reason)
            plan.reason = 'plan_approval';
          // Older accepted plans did not persist the approval flag. A reserved
          // code request proves that this turn already passed plan approval.
          if (
            plan?.reason === 'plan_approval' &&
            !plan.approved &&
            command.commandId.startsWith('retry_') &&
            this.mongoose?.connection?.db
          ) {
            const priorCode = await this.mongoose.connection.db
              .collection('prototypemodelreservations')
              .findOne({
                jobId: command.jobId,
                purpose: 'code',
                $or: [{ turnId: command.turnId }, { _id: command.turnId }],
              });
            if (priorCode) {
              plan.approved = true;
              await fs.writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
            }
          }
          const values = await runAsSystem(() =>
            this.methods.getUserKeyValues({
              userId: command.userId,
              tenantId: command.tenantId,
              name: 'OpenRouter',
            }),
          );
          if (
            !values?.apiKey ||
            (values.baseURL && values.baseURL.replace(/\/$/, '') !== this.gatewayUrl)
          ) {
            throw new Error('Stored gateway credential is unavailable');
          }
          const model = this.createModel({
            key: values.apiKey,
            model: command.modelId,
            baseUrl: this.gatewayUrl,
            requireKeyLimit: false,
            signal: this.commandSignals.get(command.commandId) ?? this.abort.signal,
          });
          if (!previousSource && !command.commandId.startsWith('approve_') && !plan?.approved) {
            if (!plan) {
              const history = [];
              for (const turn of turns) {
                if (!turn.turnId || turn.turnId === command.turnId) continue;
                try {
                  history.push(
                    JSON.parse(
                      await fs.readFile(
                        path.join(this.directory, 'turns', turn.turnId, 'plan.json'),
                        'utf8',
                      ),
                    ).prompt,
                  );
                } catch (historyError) {
                  if (historyError.code !== 'ENOENT') throw historyError;
                }
              }
              const generated = await model.planPrototype(
                `${requirements}\n\nПредыдущие ответы агента:\n${history.join('\n\n')}`,
                this.modelCallbacks(command, 'plan'),
              );
              this.log('model.finished', { ...commandLogContext(command), code: 'PLAN' });
              if (!(await this.active(command))) throw new Error('Canceled planning');
              plan = { ...generated.plan, requirements, schemaVersion: 2 };
              await fs.writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
            }
            if (plan.reason === 'plan_approval' && typeof model.quoteReact === 'function') {
              try {
                const estimate = await model.quoteReact(
                  `${requirements}\n\nУтверждённый план:\n${plan.prompt}`,
                );
                await this.saveModelMetrics(
                  command,
                  'code',
                  { estimate, status: 'preview' },
                  ':preview',
                );
              } catch (error) {
                this.log('model.estimate_unavailable', {
                  ...commandLogContext(command),
                  ...errorLogFields(error),
                  code: safeModelError(error),
                });
              }
            }
            const checkpoint = Buffer.from(JSON.stringify(plan));
            return this.writeOutput(command, {
              'checkpoint.tar.zst': checkpoint,
              'result.json': JSON.stringify({
                ...command,
                type: 'waiting',
                reason: plan.reason,
                prompt: plan.prompt,
                checkpointDigest: artifactDigest(checkpoint),
                checkpointSize: checkpoint.length,
              }),
            });
          }
          if (!previousSource && plan?.reason !== 'plan_approval')
            throw new Error('A visible plan must be approved before coding');
          if (!previousSource && command.commandId.startsWith('approve_') && !plan.approved) {
            plan.approved = true;
            await fs.writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
          }
          const generated = await model.generateReact(
            prototypeContext(
              `${requirements}${plan ? `\n\nУтверждённый план:\n${plan.prompt}` : ''}`,
              previousSource,
            ),
            {
              finalVariant: chosenVariant,
              ...this.modelCallbacks(command, 'code'),
            },
          );
          this.log('model.finished', { ...commandLogContext(command), code: 'CODE' });
          if (!(await this.active(command))) throw new Error('Canceled generation');
          const repaired = repairUiKitSource(generated.source);
          source = repaired.source;
          if (repaired.changed)
            this.log('source.repaired', {
              ...commandLogContext(command),
              code: 'SOURCE_STATIC_REPAIR',
            });
          await fs.writeFile(path.join(root, 'review.json'), JSON.stringify({ chosenVariant }), {
            mode: 0o600,
          });
          await fs.writeFile(`${sourcePath}.tmp`, source, { mode: 0o600 });
          await fs.rename(`${sourcePath}.tmp`, sourcePath);
        }
      // Archive only source data with the same tar/zstd format as publication.
      const checkpointWorkspace = path.join(root, 'checkpoint-source');
      await fs.mkdir(path.join(checkpointWorkspace, 'src/app'), { recursive: true });
      await fs.writeFile(path.join(checkpointWorkspace, 'src/app/App.tsx'), source, {
        mode: 0o600,
      });
      if (this.describeSource) {
        const manifest = this.describeSource(command, { 'src/app/App.tsx': source });
        await fs.writeFile(
          path.join(checkpointWorkspace, 'source-manifest.json'),
          JSON.stringify(manifest),
          { mode: 0o600 },
        );
      }
      const checkpointPath = path.join(root, 'checkpoint.tar.zst');
      await buildCheckpointArchive(checkpointWorkspace, checkpointPath);
      const checkpoint = await fs.readFile(checkpointPath);
      await fs.writeFile(path.join(root, 'checkpoint'), checkpoint, { mode: 0o600 });
      return this.writeOutput(command, {
        'checkpoint.tar.zst': checkpoint,
        'result.json': JSON.stringify({
          ...command,
          type: 'code_done',
          checkpointDigest: artifactDigest(checkpoint),
          checkpointSize: checkpoint.length,
        }),
      });
    }
    if (command.stage === 'transfer')
      return this.writeOutput(command, {
        'result.json': JSON.stringify({
          ...command,
          kind: 'restored_workspace',
          restoredDigest: command.sourceDigest,
        }),
      });
    if (command.stage === 'dependency_preparation') {
      const archive = new JSZip();
      archive.file(
        'fixed-toolchain.json',
        JSON.stringify({
          profile: REACT_BUILD_PROFILE,
          dependencySource: 'immutable-image',
          installDuringExecution: false,
        }),
        { date: new Date(0) },
      );
      const bundle = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      return this.writeOutput(command, {
        'dependencies.zip': bundle,
        'result.json': JSON.stringify({
          ...command,
          kind: 'dependency_bundle',
          bundleDigest: artifactDigest(bundle),
          size: bundle.length,
        }),
      });
    }
    if (command.stage === 'build_qa') {
      const cancellation = new AbortController();
      const onStop = () => cancellation.abort();
      const authoritySignal = this.commandSignals.get(command.commandId) ?? this.abort.signal;
      authoritySignal.addEventListener('abort', onStop, { once: true });
      if (authoritySignal.aborted) cancellation.abort();
      let checking = false;
      const watch = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          if (!(await this.active(command))) cancellation.abort();
        } catch {
          cancellation.abort();
        } finally {
          checking = false;
        }
      }, 500);
      let snapshot;
      try {
        snapshot = await this.pipeline.run(
          {
            executionId: command.commandId,
            profile: REACT_BUILD_PROFILE,
            format: 'react',
            source: reactPrototypeSource(await fs.readFile(sourcePath, 'utf8')),
          },
          { signal: cancellation.signal, command },
        );
      } finally {
        clearInterval(watch);
        authoritySignal.removeEventListener('abort', onStop);
      }
      const evidence = JSON.parse(snapshot.qaEvidence);
      await fs.writeFile(
        path.join(root, 'snapshot.json'),
        JSON.stringify({
          html: snapshot.html.toString('base64'),
          sourcesZip: snapshot.sourcesZip.toString('base64'),
          qaEvidence: snapshot.qaEvidence.toString('base64'),
          digests: snapshot.digests,
          templateDigest: evidence.templateDigest,
          toolchainDigest: evidence.toolchainDigest,
        }),
        { mode: 0o600 },
      );
      this.log('build.verified', commandLogContext(command));
      return this.writeOutput(command, {
        'preview.html': snapshot.html,
        'sources.zip': snapshot.sourcesZip,
        'qa.json': snapshot.qaEvidence,
        'result.json': JSON.stringify({
          ...command,
          kind: 'verified_snapshot',
          digests: snapshot.digests,
          snapshotDigest: artifactDigest(Buffer.from(JSON.stringify(snapshot.digests))),
        }),
      });
    }
    if (command.stage === 'publish') {
      const value = JSON.parse(await fs.readFile(path.join(root, 'snapshot.json'), 'utf8'));
      const snapshot = Object.fromEntries(
        ['html', 'sourcesZip', 'qaEvidence'].map((key) => [key, Buffer.from(value[key], 'base64')]),
      );
      snapshot.digests = value.digests;
      const checkpoint = await fs.readFile(path.join(root, 'checkpoint'));
      const references = await this.publication.publish({
        owner: {
          tenantId: command.tenantId,
          jobId: command.jobId,
          executionId: command.executionId,
          revision: command.expectedRevision,
        },
        checkpoint,
        checkpointDigest: artifactDigest(checkpoint),
        snapshot,
        templateDigest: value.templateDigest,
        toolchainDigest: value.toolchainDigest,
      });
      return this.writeOutput(command, {
        'publication.json': JSON.stringify({
          ...command,
          target: 'review_ready',
          checkpoint: { revision: command.checkpoint.revision, digest: artifactDigest(checkpoint) },
          templateDigest: value.templateDigest,
          toolchainDigest: value.toolchainDigest,
          references,
        }),
      });
    }
    throw new Error('Unsupported local stage');
  }

  stop() {
    this.abort.abort();
  }

  async repairSource(command, root) {
    if (
      !Number.isSafeInteger(command.repair.ordinal) ||
      command.repair.ordinal < 1 ||
      command.repair.ordinal > 2 ||
      !Array.isArray(command.repair.diagnostics) ||
      !command.repair.diagnostics.length
    )
      throw new Error('PROTOTYPE_REPAIR_LIMIT');
    const filename = path.join(root, 'App.tsx');
    const db = this.mongoose?.connection?.db;
    if (!db) throw new Error('PROTOTYPE_REPAIR_STORE_REQUIRED');
    const receipts = db.collection('prototypecoderepairs');
    const identity = {
      jobId: command.jobId,
      turnId: command.turnId,
      modelId: command.modelId,
      userId: String(command.userId),
      tenantId: command.tenantId,
      expectedRevision: command.expectedRevision,
      attemptId: command.attemptId,
      stage: command.stage,
      executionId: command.executionId,
      fenceToken: command.fenceToken,
      ordinal: command.repair.ordinal,
    };
    if (!(await this.active(command))) throw new Error('PROTOTYPE_REPAIR_AUTHORITY_REVOKED');
    const previous = await receipts.findOne({ _id: command.commandId });
    if (previous && Object.keys(identity).some((key) => previous[key] !== identity[key]))
      throw new Error('PROTOTYPE_REPAIR_IDENTITY_CONFLICT');
    let source,
      repairKind = previous?.repairKind;
    if (previous) {
      source = reactPrototypeSource(previous.source);
      if (artifactDigest(Buffer.from(source)) !== previous.sourceDigest)
        throw new Error('PROTOTYPE_REPAIR_SOURCE_INVALID');
    } else {
      const failedSource = reactPrototypeSource(await fs.readFile(filename, 'utf8'));
      const staticRepair = repairUiKitSource(failedSource);
      if (staticRepair.changed) {
        source = staticRepair.source;
        repairKind = 'SOURCE_STATIC_REPAIR';
      } else {
        const turns = await this.models.PrototypeTurn.find({ jobId: command.jobId })
          .sort({ ordinal: 1 })
          .select('text turnId')
          .lean();
        const values = await runAsSystem(() =>
          this.methods.getUserKeyValues({
            userId: command.userId,
            tenantId: command.tenantId,
            name: 'OpenRouter',
          }),
        );
        if (
          !values?.apiKey ||
          (values.baseURL && values.baseURL.replace(/\/$/, '') !== this.gatewayUrl)
        )
          throw new Error('Stored gateway credential unavailable');
        const model = this.createModel({
          key: values.apiKey,
          model: command.modelId,
          baseUrl: this.gatewayUrl,
          requireKeyLimit: false,
          signal: this.commandSignals.get(command.commandId) ?? this.abort.signal,
        });
        let review;
        try {
          review = JSON.parse(await fs.readFile(path.join(root, 'review.json'), 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const diagnostics = safeDiagnostics(command.repair.diagnostics).join('\n').slice(0, 8000);
        const prompt = `${turns.map((turn) => turn.text).join('\n\n')}\n\nИсправь существующий черновик после проверки. Сохрани требования, действия и текущие варианты. Не добавляй сеть или зависимости.\nДиагностика проверки:\n${diagnostics}\n\nИсходник проверяемого черновика:\n\`\`\`tsx\n${failedSource}\n\`\`\``;
        const generated = await model.generateReact(prompt, {
          finalVariant:
            review?.chosenVariant ??
            (await this.models.PrototypeJob.findOne({ jobId: command.jobId }).lean())
              ?.selectedVariant,
          ...this.modelCallbacks(command, 'code'),
        });
        source = repairUiKitSource(reactPrototypeSource(generated.source)).source;
        repairKind = 'SOURCE_MODEL_REPAIR';
      }
      if (!(await this.active(command))) throw new Error('PROTOTYPE_REPAIR_AUTHORITY_REVOKED');
      // Durable response before scratch update. Reserved ambiguous provider calls are never replayed.
      await receipts.insertOne({
        _id: command.commandId,
        ...identity,
        source,
        repairKind,
        sourceDigest: artifactDigest(Buffer.from(source)),
        createdAt: new Date(),
      });
    }
    if (!(await this.active(command))) throw new Error('PROTOTYPE_REPAIR_AUTHORITY_REVOKED');
    try {
      await fs.writeFile(
        path.join(root, `App.before-repair-${command.repair.ordinal}.tsx`),
        await fs.readFile(filename),
        { mode: 0o600, flag: 'wx' },
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await fs.writeFile(`${filename}.tmp`, source, { mode: 0o600 });
    await fs.rename(`${filename}.tmp`, filename);
    this.log('source.repaired', { ...commandLogContext(command), code: repairKind });
    return source;
  }
}
