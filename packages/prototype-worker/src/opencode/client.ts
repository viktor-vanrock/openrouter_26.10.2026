export type ProxyCredentials = {
  baseUrl: string;
  token: string;
  expiresAt?: number;
  refreshToken?(): Promise<{ token: string; expiresAt: number }>;
};
import { waitForTurnIdle } from './events';
type RuntimeClient = {
  event?: { subscribe(input: unknown): Promise<{ stream: AsyncIterable<unknown> }> };
  session: {
    create(input: unknown): Promise<{ data?: { id?: string }; error?: unknown }>;
    delete?(input: unknown): Promise<unknown>;
    abort(input: unknown): Promise<unknown>;
    promptAsync(input: unknown): Promise<{ error?: unknown }>;
  };
  server?: { close(): void };
};
type RuntimeFactory = (input: unknown) => Promise<RuntimeClient>;

export type OpenCodeStage =
  'configuration' | 'process_start' | 'server_ready' | 'session_create' | 'first_turn' | 'turn';

export class OpenCodeStageError extends Error {
  constructor(
    public readonly code: string,
    public readonly stage: OpenCodeStage,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'OpenCodeStageError';
  }
}

function startupError(error: unknown): OpenCodeStageError {
  const message = error instanceof Error ? error.message : String(error);
  if (/Timeout waiting for server to start/i.test(message)) {
    return new OpenCodeStageError(
      'OPENCODE_SERVER_READY_TIMEOUT',
      'server_ready',
      true,
      'OpenCode local server did not become ready before the startup timeout.',
    );
  }
  const exitCode = message.match(/Server exited with code\s+(-?\d+)/i)?.[1];
  if (exitCode) {
    return new OpenCodeStageError(
      'OPENCODE_PROCESS_EXIT',
      'process_start',
      false,
      `OpenCode process exited before the local server was ready (exit code ${exitCode}).`,
    );
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EADDRINUSE' || code === 'EAGAIN' || code === 'EMFILE' || code === 'ENFILE') {
    return new OpenCodeStageError(
      `OPENCODE_PROCESS_${code}`,
      'process_start',
      true,
      `OpenCode process could not start (${code}).`,
    );
  }
  return new OpenCodeStageError(
    'OPENCODE_PROCESS_START_FAILED',
    'process_start',
    false,
    'OpenCode process could not start.',
  );
}

export function normalizeOpenCodeRuntime(runtime: unknown): RuntimeClient {
  const value = runtime as RuntimeClient & { client?: RuntimeClient };
  return value?.client ? { ...value.client, server: value.server } : value;
}

export async function createOpenCodeRuntime(input: unknown): Promise<RuntimeClient> {
  const { createOpencode } = await import('@opencode-ai/sdk');
  const runtime = await createOpencode(input as Parameters<typeof createOpencode>[0]);
  return normalizeOpenCodeRuntime(runtime);
}

export type OpenCodeSession = {
  id: string;
  workspace: string;
  modelId: string;
  runtime: RuntimeClient;
  firstTurnCompleted?: boolean;
};

const REQUIRED_MARKERS = `When waiting for user input, end with exactly WAITING_FOR_CLARIFICATION or WAITING_FOR_PLAN_APPROVAL. After writing implementation source, end with PROTOTYPE_CODE_DONE:<slug>; never emit PROTOTYPE_READY yourself because only backend checks can establish review readiness. When finalized, end with PROTOTYPE_FINALIZED:<slug>.`;

export class OpenCodeExecutionClient {
  constructor(
    private readonly options: {
      createRuntime?: RuntimeFactory;
      inactivityTimeoutMs?: number;
      refreshBeforeMs?: number;
      localAutoApprove?: boolean;
    },
  ) {}

  async createSession(
    workspace: string,
    modelId: string,
    proxy: ProxyCredentials,
  ): Promise<OpenCodeSession> {
    if (!modelId || !proxy.baseUrl || !proxy.token) {
      throw new OpenCodeStageError(
        'OPENCODE_CONFIGURATION_INVALID',
        'configuration',
        false,
        'OpenCode configuration is incomplete.',
      );
    }
    let token = proxy.token;
    if (
      proxy.expiresAt != null &&
      proxy.expiresAt - Date.now() <= (this.options.refreshBeforeMs ?? 10_000)
    ) {
      if (!proxy.refreshToken) throw new Error('OpenCode proxy token refresh is unavailable');
      const refreshed = await proxy.refreshToken();
      if (
        typeof refreshed?.token !== 'string' ||
        refreshed.token.length === 0 ||
        !Number.isFinite(refreshed.expiresAt) ||
        refreshed.expiresAt <= Date.now()
      ) {
        throw new Error('OpenCode proxy token refresh is invalid');
      }
      token = refreshed.token;
    }
    const canonicalWorkspace = await import('node:fs/promises').then((fs) =>
      fs.realpath(workspace),
    );
    let runtime;
    try {
      runtime = await (this.options.createRuntime ?? createOpenCodeRuntime)({
        // The SDK defaults every server to 4096. A local UI job can overlap a
        // previous process that is still shutting down, so let OpenCode bind
        // an available ephemeral port instead of turning that overlap into a
        // permanent-looking process exit.
        port: 0,
        config: {
          ...(this.options.localAutoApprove
            ? {
                permission: {
                  bash: {
                    '*': 'allow',
                    '*npm run dev*': 'deny',
                    '*npm start*': 'deny',
                    '*vite*': 'deny',
                  },
                  edit: 'allow',
                  webfetch: 'allow',
                  external_directory: 'deny',
                  doom_loop: 'deny',
                },
              }
            : {}),
          provider: {
            openrouter: { options: { baseURL: proxy.baseUrl, apiKey: token } },
          },
        },
      });
    } catch (error) {
      throw startupError(error);
    }
    let created;
    try {
      created = await runtime.session.create({
        query: { directory: canonicalWorkspace },
        body: { title: `Prototype ${modelId}` },
      });
    } catch {
      runtime.server?.close?.();
      throw new OpenCodeStageError(
        'OPENCODE_SESSION_CREATE_FAILED',
        'session_create',
        false,
        'OpenCode local server started, but the agent session could not be created.',
      );
    }
    if (!created?.data?.id) {
      runtime.server?.close?.();
      throw new OpenCodeStageError(
        'OPENCODE_SESSION_CREATE_FAILED',
        'session_create',
        false,
        'OpenCode local server started, but the agent session could not be created.',
      );
    }
    return { id: created.data.id, workspace: canonicalWorkspace, modelId, runtime };
  }

  async disposeSession(session: OpenCodeSession): Promise<void> {
    await session.runtime.session.delete?.({
      path: { id: session.id },
      query: { directory: session.workspace },
    });
    session.runtime.server?.close?.();
  }

  async cancelSession(session: OpenCodeSession): Promise<void> {
    await session.runtime.session.abort({
      path: { id: session.id },
      query: { directory: session.workspace },
    });
  }

  async runTurn(
    session: OpenCodeSession,
    transcript: string,
    onProgress: (
      message: string,
      kind?: 'text' | 'reasoning' | 'tool' | 'status' | 'error',
    ) => void,
  ): Promise<string> {
    onProgress('OpenCode turn started');
    const subscription = session.runtime.event?.subscribe
      ? await session.runtime.event.subscribe({ query: { directory: session.workspace } })
      : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimeout: ((error: Error) => void) | undefined;
    const timeoutMs = this.options.inactivityTimeoutMs ?? 5 * 60 * 1000;
    const armTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Reject before aborting. OpenCode may answer the abort with a generic "Aborted"
        // error; the caller needs the actual reason for the failed turn.
        rejectTimeout?.(new Error(`OpenCode inactivity timeout after ${timeoutMs}ms`));
        void session.runtime.session
          .abort({
            path: { id: session.id },
            query: { directory: session.workspace },
          })
          .catch(() => undefined);
      }, timeoutMs);
    };
    const idle = subscription
      ? waitForTurnIdle(subscription.stream, session.id, onProgress, armTimeout)
      : null;
    const prompt = session.runtime.session.promptAsync({
      path: { id: session.id },
      query: { directory: session.workspace },
      body: {
        model: { providerID: 'openrouter', modelID: session.modelId },
        ...(this.options.localAutoApprove
          ? {
              system: `Your working directory is ${session.workspace}. Always set bash workdir to this absolute path, never / or another directory. Read template/ and create implementations only in the existing prototypes/<slug>/ inside this workspace. Do not modify files outside the workspace. Do not run npm, npx, install, type-check, lint, build, preview, export-html, open, or any development server, and do not edit package.json, package-lock.json, eslint config, build config, src/app/main.tsx, or src/app/providers/index.tsx: the backend owns dependencies, bootstrap, checks, build, browser validation, preview, and downloads. Use the verified UI-kit API snapshot embedded in AGENTS.md at docs/skills/use-uikit.md plus installed @ai-sber/uikit TypeScript declarations. Do not call the remote Storybook MCP from this runtime or ask the manager for another workflow. DataTable columns use { key, header, cell: (item) => item.field }; never use Header, render, row.original, or getValue. Prefer composable Table if DataTable types fail. SearchInput onChange receives the value string, while Input onChange receives an event. For simple select fields prefer SelectField; otherwise SelectItem requires SelectContent and Select needs SelectTrigger/SelectValue. Modal composition uses separately imported ModalTrigger, ModalContent, ModalHeader, ModalTitle, ModalBody and ModalFooter; never use Modal.Content or mismatched closing tags. Render dialogs conditionally or with ModalTrigger/a controlled Modal open prop: a role=dialog element must not exist or be visible before the trigger is clicked. Use local in-memory demo data, not service workers or external APIs, for standalone HTML. Complete the requested interactions and validation before emitting PROTOTYPE_CODE_DONE:<slug>; never emit PROTOTYPE_READY because only backend checks decide readiness. Do not emit readiness for a plan or an unchanged template. Respond in the user's language. If clarification has been answered, move on to plan approval; after approval implement immediately.`,
            }
          : {}),
        parts: [{ type: 'text', text: `${REQUIRED_MARKERS}\n\n${transcript}` }],
        tools: { question: false },
      },
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
      armTimeout();
    });
    let result: unknown;
    try {
      result = await Promise.race([idle ? Promise.all([prompt, idle]) : prompt, timeout]);
    } catch (error) {
      if (
        error instanceof OpenCodeStageError ||
        String((error as Error)?.message).includes('inactivity timeout')
      ) {
        throw error;
      }
      const firstTurn = !session.firstTurnCompleted;
      throw new OpenCodeStageError(
        firstTurn ? 'OPENCODE_FIRST_TURN_FAILED' : 'OPENCODE_TURN_FAILED',
        firstTurn ? 'first_turn' : 'turn',
        false,
        firstTurn ? 'OpenCode failed during the first model turn.' : 'OpenCode model turn failed.',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    const promptResult = idle ? (result as [{ error?: unknown }, string])[0] : result;
    if ((promptResult as { error?: unknown } | undefined)?.error) {
      const firstTurn = !session.firstTurnCompleted;
      throw new OpenCodeStageError(
        firstTurn ? 'OPENCODE_FIRST_TURN_FAILED' : 'OPENCODE_TURN_FAILED',
        firstTurn ? 'first_turn' : 'turn',
        false,
        firstTurn ? 'OpenCode failed during the first model turn.' : 'OpenCode model turn failed.',
      );
    }
    const text = idle ? (result as [unknown, string])[1] : '';
    if (!text.trim()) throw new Error('OpenCode finished without an assistant response');
    session.firstTurnCompleted = true;
    return text;
  }
}
