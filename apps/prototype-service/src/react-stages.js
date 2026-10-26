import fs from 'node:fs/promises';
import path from 'node:path';
import { artifactDigest } from '@librechat/prototype-worker';
import { LocalReactStages } from './local-react-stages.js';
import { deterministicLeaseId } from './stage-supervisor.js';
import { createSourceManifest } from './source-manifest.js';
import { commandLogContext, errorLogFields } from './service-log.js';
import { PrototypeContentGuard } from './prototype-content-guard.js';

/** Transitional direct generator; generated React executes only inside Gateway builds. */
export class ReactStages extends LocalReactStages {
  constructor({ generationBinding, checkContent, ...options }) {
    super({
      ...options,
      describeSource: (command, sources) =>
        createSourceManifest(sources, {
          engineId: generationBinding.engineId,
          profile: generationBinding.sourceProfile,
          modelId: command.modelId,
          revision: command.expectedRevision,
          rulesDigest: generationBinding.rulesDigest,
          templateDigest: generationBinding.templateDigest,
          toolchainDigest: generationBinding.toolchainDigest,
        }),
    });
    this.generationBinding = generationBinding;
    this.workspace = options.workspace;
    const guard = new PrototypeContentGuard({
      ...options,
      callbacks: (command, purpose) => this.modelCallbacks(command, purpose),
      active: (command) => this.active(command),
      signal: () => this.abort.signal,
    });
    this.checkContent = checkContent ?? ((command) => guard.check(command));
  }
  async execute(command) {
    const context = commandLogContext(command);
    if (command.stage === 'generation') {
      if (!this.generationBinding || typeof this.methods.pinPrototypeGeneration !== 'function') {
        throw new Error('PROTOTYPE_GENERATION_BINDING_REQUIRED');
      }
      const session = await this.mongoose.startSession();
      try {
        await session.withTransaction(() =>
          this.methods.pinPrototypeGeneration(
            {
              ...command,
              leaseId: deterministicLeaseId(command),
              generation: this.generationBinding,
            },
            session,
          ),
        );
      } catch (error) {
        if (error?.name !== 'PrototypeDomainError' || error.code !== 'PROTOTYPE_INVALID_STATE')
          throw error;
        // Pinning precedes model/build work. Preserve immutable pins and send a
        // durable failure through the existing fenced API instead of leaving a running job.
        const diagnostics = ['PROTOTYPE_GENERATION_BINDING_CONFLICT'];
        this.log('stage.failed', {
          ...context,
          ...errorLogFields(error),
          reason: 'generation_binding_conflict',
          writersStopped: true,
          diagnostics,
        });
        return this.writeOutput(
          command,
          {
            'failure.json': JSON.stringify({
              ...command,
              type: 'failed',
              code: 'PROTOTYPE_EXECUTION_FAILED',
              message:
                'Сервис прототипов обновлён с момента создания этой задачи. Начните новый прототип в новом чате.',
              retryable: false,
              diagnostics,
            }),
          },
          false,
        );
      } finally {
        await session.endSession();
      }
    }
    if (command.stage === 'generation') {
      try {
        await this.checkContent(command);
      } catch (error) {
        if (error.code === 'LIVE_MODEL_EXECUTION_STALE') throw error;
        const code = /^LIVE_MODEL_[A-Z_]+$/.test(error?.code ?? '')
          ? error.code
          : 'LIVE_MODEL_MODERATION_UNAVAILABLE';
        const blocked = code === 'LIVE_MODEL_CONTENT_BLOCKED';
        this.log('stage.failed', {
          ...context,
          code,
          reason: 'content_safety',
          writersStopped: true,
        });
        return this.writeOutput(
          command,
          {
            'failure.json': JSON.stringify({
              ...command,
              type: 'failed',
              code: 'PROTOTYPE_EXECUTION_FAILED',
              message: blocked
                ? 'Запрос отклонён по правилам содержания. Начните новый прототип с допустимыми требованиями. Последняя рабочая версия сохранена.'
                : 'Не удалось выполнить проверку содержания. Генерация не запускалась; последняя рабочая версия сохранена.',
              retryable: false,
              diagnostics: [code],
            }),
          },
          false,
        );
      }
    }
    if (this.workspace) {
      this.log('workspace.restore', context);
      const restored = await this.workspace.restore(command);
      if (restored) {
        this.log('workspace.restored', context);
        return restored;
      }
    }
    const output = await super.execute(command);
    if (this.workspace) {
      try {
        await this.workspace.save(
          command,
          this.turnDirectory(command),
          output.outputRoot,
          output.succeeded,
        );
        this.log('workspace.saved', { ...context, succeeded: output.succeeded });
      } catch (error) {
        this.log('workspace.failed', { ...context, ...errorLogFields(error) });
        throw error;
      }
    }
    return output;
  }
  async run(command, root) {
    if (command.stage === 'transfer') {
      const filename = command.pipelineStep === 1 ? 'checkpoint' : 'dependencies.zip';
      const bytes = await fs.readFile(path.join(root, filename));
      const actual = artifactDigest(bytes);
      if (actual !== command.sourceDigest) throw new Error('PROTOTYPE_TRANSFER_DIGEST_MISMATCH');
      return this.writeOutput(command, {
        'result.json': JSON.stringify({
          ...command,
          kind: 'restored_workspace',
          restoredDigest: actual,
        }),
      });
    }
    const result = await super.run(command, root);
    if (command.stage === 'dependency_preparation') {
      const bytes = await fs.readFile(path.join(result.outputRoot, 'dependencies.zip'));
      await fs.writeFile(path.join(root, 'dependencies.zip'), bytes, { mode: 0o600 });
    }
    return result;
  }
}
