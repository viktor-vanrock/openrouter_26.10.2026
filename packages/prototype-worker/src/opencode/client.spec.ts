import { OpenCodeExecutionClient, OpenCodeStageError, normalizeOpenCodeRuntime } from './client';

jest.mock('node:fs/promises', () => ({ realpath: jest.fn(async (value: string) => value) }));

describe('OpenCodeExecutionClient', () => {
  it('auto-approves local tools only when explicitly enabled', async () => {
    const createRuntime = jest.fn(async () => ({
      session: {
        create: jest.fn(async () => ({ data: { id: 'local_session' } })),
      },
    }));
    const client = new OpenCodeExecutionClient({ createRuntime, localAutoApprove: true });
    await client.createSession('/tmp/local-job', 'fixed/model', {
      baseUrl: 'http://localhost/v1',
      token: 'synthetic-token',
    });
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 0,
        config: expect.objectContaining({
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
        }),
      }),
    );
  });

  it('uses an ephemeral port so concurrent local OpenCode sessions do not collide', async () => {
    const createRuntime = jest.fn(async () => ({
      session: {
        create: jest.fn(async () => ({ data: { id: 'local_session' } })),
      },
    }));
    const client = new OpenCodeExecutionClient({ createRuntime });

    await client.createSession('/tmp/local-job', 'fixed/model', {
      baseUrl: 'http://localhost/v1',
      token: 'synthetic-token',
    });

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ port: 0 }));
  });

  it('keeps external workspace access denied even when local tools are auto-approved', async () => {
    const createRuntime = jest.fn(async () => ({
      session: {
        create: jest.fn(async () => ({ data: { id: 'local_session' } })),
      },
    }));
    const client = new OpenCodeExecutionClient({ createRuntime, localAutoApprove: true });
    await client.createSession('/tmp/local-job', 'fixed/model', {
      baseUrl: 'http://localhost/v1',
      token: 'synthetic-token',
    });

    const config = createRuntime.mock.calls[0][0] as {
      config: { permission: { external_directory: string; bash: Record<string, string> } };
    };
    expect(config.config.permission.external_directory).toBe('deny');
    expect(config.config.permission.bash['*npm run dev*']).toBe('deny');
    expect(config.config.permission.bash['*npm start*']).toBe('deny');
    expect(config.config.permission.bash['*vite*']).toBe('deny');
  });

  it('uses the canonical workspace path for the session and subsequent turns', async () => {
    const fs = await import('node:fs/promises');
    (fs.realpath as jest.Mock).mockResolvedValueOnce('/private/tmp/local-job');
    const create = jest.fn(async () => ({ data: { id: 'local_session' } }));
    const createRuntime = jest.fn(async () => ({ session: { create } }));
    const client = new OpenCodeExecutionClient({ createRuntime });

    const session = await client.createSession('/tmp/local-job', 'fixed/model', {
      baseUrl: 'http://localhost/v1',
      token: 'synthetic-token',
    });

    expect(create).toHaveBeenCalledWith({
      query: { directory: '/private/tmp/local-job' },
      body: { title: 'Prototype fixed/model' },
    });
    expect(session.workspace).toBe('/private/tmp/local-job');
  });

  it('classifies an OpenCode process startup failure without leaking server output', async () => {
    const createRuntime = jest.fn(async () => {
      throw new Error('Server exited with code 1\nServer output: Unexpected error\nsecret-canary');
    });
    const client = new OpenCodeExecutionClient({ createRuntime });

    await expect(
      client.createSession('/tmp/local-job', 'fixed/model', {
        baseUrl: 'http://localhost/v1',
        token: 'synthetic-token',
      }),
    ).rejects.toMatchObject({
      name: 'OpenCodeStageError',
      code: 'OPENCODE_PROCESS_EXIT',
      stage: 'process_start',
      retryable: false,
      message: 'OpenCode process exited before the local server was ready (exit code 1).',
    });
    try {
      await client.createSession('/tmp/local-job', 'fixed/model', {
        baseUrl: 'http://localhost/v1',
        token: 'synthetic-token',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodeStageError);
      expect(JSON.stringify(error)).not.toContain('secret-canary');
    }
  });

  it('classifies server readiness timeout as a transient startup failure', async () => {
    const client = new OpenCodeExecutionClient({
      createRuntime: jest.fn(async () => {
        throw new Error('Timeout waiting for server to start after 5000ms');
      }),
    });

    await expect(
      client.createSession('/tmp/local-job', 'fixed/model', {
        baseUrl: 'http://localhost/v1',
        token: 'synthetic-token',
      }),
    ).rejects.toMatchObject({
      code: 'OPENCODE_SERVER_READY_TIMEOUT',
      stage: 'server_ready',
      retryable: true,
    });
  });

  it('classifies session creation and first-turn failures by stage', async () => {
    const runtime = {
      event: {
        subscribe: jest.fn(async () => ({
          stream: (async function* () {
            yield {
              type: 'session.error',
              properties: { sessionID: 'session_1', error: { data: { message: 'bad model' } } },
            };
          })(),
        })),
      },
      session: {
        create: jest.fn(async () => ({ error: { message: 'unavailable' } })),
        promptAsync: jest.fn(async () => ({ data: {} })),
        abort: jest.fn(),
      },
    };
    const client = new OpenCodeExecutionClient({ createRuntime: jest.fn(async () => runtime) });
    await expect(
      client.createSession('/tmp/local-job', 'fixed/model', {
        baseUrl: 'http://localhost/v1',
        token: 'synthetic-token',
      }),
    ).rejects.toMatchObject({ code: 'OPENCODE_SESSION_CREATE_FAILED', stage: 'session_create' });

    runtime.session.create.mockResolvedValue({ data: { id: 'session_1' } });
    const session = await client.createSession('/tmp/local-job', 'fixed/model', {
      baseUrl: 'http://localhost/v1',
      token: 'synthetic-token',
    });
    await expect(client.runTurn(session, 'requirements', jest.fn())).rejects.toMatchObject({
      code: 'OPENCODE_FIRST_TURN_FAILED',
      stage: 'first_turn',
    });
  });
  it('normalizes the real SDK createOpencode result to its client surface', async () => {
    const sdkClient = { session: { create: jest.fn() } };
    const server = { close: jest.fn() };
    const runtime = normalizeOpenCodeRuntime({ client: sdkClient, server });

    expect(runtime.session).toBe(sdkClient.session);
    expect(runtime.server).toBe(server);
  });

  it('fixes the model/proxy configuration and disables interactive questions', async () => {
    async function* stream() {
      yield {
        type: 'message.updated',
        properties: { info: { id: 'assistant_1', role: 'assistant', sessionID: 'session_1' } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session_1',
          part: { messageID: 'assistant_1', type: 'text', text: 'WAITING_FOR_CLARIFICATION' },
        },
      };
      yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
    }
    const createRuntime = jest.fn(async () => ({
      event: { subscribe: jest.fn(async () => ({ stream: stream() })) },
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        promptAsync: jest.fn(async () => ({ data: {} })),
      },
    }));
    const client = new OpenCodeExecutionClient({ createRuntime, inactivityTimeoutMs: 1000 });
    const session = await client.createSession('/tmp/job_1', 'openai/gpt-5-codex', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'secret-job-token',
    });
    await client.runTurn(session, 'requirements', jest.fn());

    expect(createRuntime).toHaveBeenCalledWith({
      port: 0,
      config: {
        provider: {
          openrouter: {
            options: { baseURL: 'http://proxy.internal/v1', apiKey: 'secret-job-token' },
          },
        },
      },
    });
    expect(session.runtime.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'session_1' },
      query: { directory: '/tmp/job_1' },
      body: {
        model: { providerID: 'openrouter', modelID: 'openai/gpt-5-codex' },
        parts: [
          {
            type: 'text',
            text: expect.stringMatching(/WAITING_FOR_CLARIFICATION[\s\S]*requirements$/),
          },
        ],
        tools: { question: false },
      },
    });
  });

  it('keeps dependency installation and checks under backend control in local mode', async () => {
    async function* stream() {
      yield {
        type: 'message.updated',
        properties: { info: { id: 'assistant_1', role: 'assistant', sessionID: 'session_1' } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session_1',
          part: { messageID: 'assistant_1', type: 'text', text: 'WAITING_FOR_CLARIFICATION' },
        },
      };
      yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
    }
    const promptAsync = jest.fn(async () => ({ data: {} }));
    const runtime = {
      event: { subscribe: jest.fn(async () => ({ stream: stream() })) },
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        promptAsync,
      },
    };
    const client = new OpenCodeExecutionClient({
      createRuntime: jest.fn(async () => runtime),
      localAutoApprove: true,
    });
    const session = await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'synthetic-token',
    });
    await client.runTurn(session, 'requirements', jest.fn());

    const request = promptAsync.mock.calls[0][0] as { body: { system: string } };
    expect(request.body.system).toContain('Do not run npm, npx, install, type-check, lint, build');
    expect(request.body.system).toContain(
      'the backend owns dependencies, bootstrap, checks, build',
    );
    expect(request.body.system).toContain('src/app/main.tsx');
    expect(request.body.system).toContain('UI-kit API snapshot embedded in AGENTS.md');
    expect(request.body.system).toContain('Do not call the remote Storybook MCP from this runtime');
    expect(request.body.system).toContain('DataTable columns use { key, header, cell: (item)');
    expect(request.body.system).toContain('ModalTrigger');
    expect(request.body.system).toContain('SearchInput onChange receives the value string');
    expect(request.body.system).toContain('role=dialog element must not exist or be visible');
    expect(request.body.system).toContain('never emit PROTOTYPE_READY');
  });

  it('aborts a locally stalled turn after the inactivity deadline', async () => {
    jest.useFakeTimers();
    const abort = jest.fn(async () => ({ data: true }));
    const runtime = {
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        promptAsync: jest.fn(() => new Promise(() => undefined)),
        abort,
      },
    };
    const client = new OpenCodeExecutionClient({
      createRuntime: jest.fn(async () => runtime),
      inactivityTimeoutMs: 1000,
    });
    const session = await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'secret-job-token',
    });

    const turn = client.runTurn(session, 'requirements', jest.fn());
    const assertion = turn.catch((error) => error as Error);
    await jest.advanceTimersByTimeAsync(1000);

    expect((await assertion).message).toContain('inactivity timeout');
    expect(abort).toHaveBeenCalledWith({
      path: { id: 'session_1' },
      query: { directory: '/tmp/job_1' },
    });
    jest.useRealTimers();
  });

  it('fails rather than turning an empty OpenCode response into a clarification request', async () => {
    const runtime = {
      event: {
        subscribe: jest.fn(async () => ({
          stream: (async function* () {
            yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
          })(),
        })),
      },
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        promptAsync: jest.fn(async () => ({ data: {} })),
        abort: jest.fn(),
      },
    };
    const client = new OpenCodeExecutionClient({ createRuntime: jest.fn(async () => runtime) });
    const session = await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'secret-job-token',
    });

    await expect(client.runTurn(session, 'requirements', jest.fn())).rejects.toThrow(
      'without an assistant response',
    );
  });

  it('waits for session idle and returns only assistant text from the scoped event stream', async () => {
    async function* stream() {
      yield {
        type: 'message.updated',
        properties: { info: { id: 'assistant_1', role: 'assistant', sessionID: 'session_1' } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'other',
          part: { messageID: 'assistant_1', type: 'text', text: 'ignore' },
        },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session_1',
          part: { messageID: 'assistant_1', type: 'text', text: 'answer' },
        },
      };
      yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
    }
    const runtime = {
      event: { subscribe: jest.fn(async () => ({ stream: stream() })) },
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        promptAsync: jest.fn(async () => ({ data: {} })),
        abort: jest.fn(),
      },
    };
    const client = new OpenCodeExecutionClient({ createRuntime: jest.fn(async () => runtime) });
    const session = await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'secret-job-token',
    });

    await expect(client.runTurn(session, 'requirements', jest.fn())).resolves.toBe('answer');
    expect(runtime.event.subscribe).toHaveBeenCalledWith({ query: { directory: '/tmp/job_1' } });
  });

  it('times out while waiting for idle even after prompt submission succeeds', async () => {
    jest.useFakeTimers();
    async function* neverIdle(): AsyncGenerator<unknown> {
      yield* [];
      await new Promise(() => undefined);
    }
    const abort = jest.fn(async () => ({ data: true }));
    const runtime = {
      event: { subscribe: jest.fn(async () => ({ stream: neverIdle() })) },
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        promptAsync: jest.fn(async () => ({ data: {} })),
        abort,
      },
    };
    const client = new OpenCodeExecutionClient({
      createRuntime: jest.fn(async () => runtime),
      inactivityTimeoutMs: 1000,
    });
    const session = await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'secret-job-token',
    });

    const assertion = client
      .runTurn(session, 'requirements', jest.fn())
      .catch((error) => error as Error);
    await jest.advanceTimersByTimeAsync(1000);
    expect((await assertion).message).toContain('inactivity timeout');
    expect(abort).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('preserves the inactivity timeout as the rejection reason when abort rejects', async () => {
    jest.useFakeTimers();
    const abort = jest.fn(async () => {
      throw new Error('Aborted');
    });
    const runtime = {
      event: {
        subscribe: jest.fn(async () => ({
          stream: (async function* (): AsyncGenerator<unknown> {
            yield* [];
            await new Promise(() => undefined);
          })(),
        })),
      },
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        promptAsync: jest.fn(async () => ({ data: {} })),
        abort,
      },
    };
    const client = new OpenCodeExecutionClient({
      createRuntime: jest.fn(async () => runtime),
      inactivityTimeoutMs: 1000,
    });
    const session = await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'secret-job-token',
    });

    const assertion = client
      .runTurn(session, 'requirements', jest.fn())
      .catch((error) => error as Error);
    await jest.advanceTimersByTimeAsync(1000);
    expect((await assertion).message).toContain('inactivity timeout');
    expect(abort).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('extends the inactivity deadline when scoped assistant progress arrives', async () => {
    jest.useFakeTimers();
    async function* activeTurn() {
      yield {
        type: 'message.updated',
        properties: { info: { id: 'assistant_1', role: 'assistant', sessionID: 'session_1' } },
      };
      await new Promise((resolve) => setTimeout(resolve, 900));
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session_1',
          part: { messageID: 'assistant_1', type: 'text', text: 'working' },
        },
      };
      await new Promise((resolve) => setTimeout(resolve, 900));
      yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
    }
    const runtime = {
      event: { subscribe: jest.fn(async () => ({ stream: activeTurn() })) },
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        promptAsync: jest.fn(async () => ({ data: {} })),
        abort: jest.fn(),
      },
    };
    const client = new OpenCodeExecutionClient({
      createRuntime: jest.fn(async () => runtime),
      inactivityTimeoutMs: 1000,
    });
    const session = await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'secret-job-token',
    });

    const result = client.runTurn(session, 'requirements', jest.fn());
    const assertion = result;
    await jest.advanceTimersByTimeAsync(1800);
    await expect(assertion).resolves.toBe('working');
    expect(runtime.session.abort).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('refreshes an expiring in-memory proxy token before creating a session', async () => {
    const refreshToken = jest.fn(async () => ({
      token: 'refreshed-job-token',
      expiresAt: Date.now() + 60_000,
    }));
    const createRuntime = jest.fn(async () => ({
      session: { create: jest.fn(async () => ({ data: { id: 'session_1' } })) },
    }));
    const client = new OpenCodeExecutionClient({ createRuntime, refreshBeforeMs: 10_000 });

    await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'expiring-token',
      expiresAt: Date.now() + 1_000,
      refreshToken,
    });

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 0,
        config: {
          provider: {
            openrouter: {
              options: {
                baseURL: 'http://proxy.internal/v1',
                apiKey: 'refreshed-job-token',
              },
            },
          },
        },
      }),
    );
  });

  it('fails closed when an expiring token cannot be refreshed', async () => {
    const createRuntime = jest.fn();
    const client = new OpenCodeExecutionClient({ createRuntime, refreshBeforeMs: 10_000 });

    await expect(
      client.createSession('/tmp/job_1', 'fixed/model', {
        baseUrl: 'http://proxy.internal/v1',
        token: 'expiring-token',
        expiresAt: Date.now() + 1_000,
        refreshToken: jest.fn(async () => {
          throw new Error('lease revoked');
        }),
      }),
    ).rejects.toThrow('lease revoked');
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('removes the in-memory proxy credential when a session is disposed', async () => {
    const runtime = {
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        delete: jest.fn(async () => ({ data: true })),
      },
    };
    const client = new OpenCodeExecutionClient({ createRuntime: jest.fn(async () => runtime) });
    const session = await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'secret-job-token',
    });

    expect(session).not.toHaveProperty('token');
    await client.disposeSession(session);

    expect(runtime.session.delete).toHaveBeenCalledWith({
      path: { id: 'session_1' },
      query: { directory: '/tmp/job_1' },
    });
    expect(JSON.stringify(session)).not.toContain('secret-job-token');
  });

  it('aborts a session through the public client seam', async () => {
    const abort = jest.fn(async () => ({ data: true }));
    const runtime = {
      session: {
        create: jest.fn(async () => ({ data: { id: 'session_1' } })),
        abort,
      },
    };
    const client = new OpenCodeExecutionClient({ createRuntime: jest.fn(async () => runtime) });
    const session = await client.createSession('/tmp/job_1', 'fixed/model', {
      baseUrl: 'http://proxy.internal/v1',
      token: 'secret-job-token',
    });

    await client.cancelSession(session);

    expect(abort).toHaveBeenCalledWith({
      path: { id: 'session_1' },
      query: { directory: '/tmp/job_1' },
    });
  });

  it('rejects an empty refreshed token before creating the runtime', async () => {
    const createRuntime = jest.fn();
    const client = new OpenCodeExecutionClient({ createRuntime, refreshBeforeMs: 10_000 });

    await expect(
      client.createSession('/tmp/job_1', 'fixed/model', {
        baseUrl: 'http://proxy.internal/v1',
        token: 'expiring-token',
        expiresAt: Date.now() + 1_000,
        refreshToken: jest.fn(async () => ({ token: '', expiresAt: Date.now() + 60_000 })),
      }),
    ).rejects.toThrow('refresh is invalid');
    expect(createRuntime).not.toHaveBeenCalled();
  });
});
