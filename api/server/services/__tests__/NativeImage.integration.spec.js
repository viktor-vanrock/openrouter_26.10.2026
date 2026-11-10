const http = require('http');
const { once } = require('events');
const { AgentCapabilities } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');

const mockApi = jest.requireActual('@librechat/api');

jest.mock('@librechat/api', () => ({
  ...mockApi,
  loadAgent: (...args) => mockApi.loadAgent(...args),
  createTokenCounter: jest.fn(() => () => 8),
  validateAgentModel: jest.fn().mockResolvedValue({ isValid: true }),
  loadSkillStates: jest.fn().mockResolvedValue({ skillStates: new Map() }),
  discoverConnectedAgents: jest.fn().mockResolvedValue({
    agentConfigs: new Map(),
    edges: [],
    skippedAgentIds: new Set(),
  }),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: jest.fn(async (req) => req.config.endpoints),
  getMCPServerTools: jest.fn().mockResolvedValue(null),
  getCachedTools: jest.fn().mockResolvedValue(null),
}));

jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: jest.fn(),
  findAccessibleResources: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/server/services/Files/process', () => ({
  ...jest.requireActual('~/server/services/Files/process'),
  saveBase64Image: jest.fn().mockResolvedValue({
    file_id: 'saved_image',
    filepath: '/test/image.png',
    type: 'image/png',
  }),
}));

jest.mock('~/models', () => ({
  getFiles: jest.fn().mockResolvedValue([]),
  getConvoFiles: jest.fn().mockResolvedValue([]),
  updateFilesUsage: jest.fn().mockResolvedValue([]),
  getUserKey: jest.fn(),
  getUserKeyValues: jest.fn(),
  getToolFilesByIds: jest.fn().mockResolvedValue([]),
  getMessages: jest.fn().mockResolvedValue([]),
  getUserById: jest.fn(),
  getCodeGeneratedFiles: jest.fn().mockResolvedValue([]),
  getUserCodeFiles: jest.fn().mockResolvedValue([]),
  listSkillsByAccess: jest.fn().mockResolvedValue([]),
  listAlwaysApplySkills: jest.fn().mockResolvedValue([]),
  getSkillByName: jest.fn(),
  getMultiplier: jest.fn().mockResolvedValue(1),
  getCacheMultiplier: jest.fn().mockResolvedValue(1),
  spendTokens: jest.fn().mockResolvedValue(),
  spendStructuredTokens: jest.fn().mockResolvedValue(),
  bulkInsertTransactions: jest.fn().mockResolvedValue(),
  updateBalance: jest.fn().mockResolvedValue(),
}));

jest.mock('~/config', () => ({
  getFlowStateManager: jest.fn(() => ({})),
  getMCPServersRegistry: jest.fn(() => ({ getServerConfig: jest.fn() })),
  getMCPManager: jest.fn(),
}));

const { initializeClient } = require('~/server/services/Endpoints/agents');

async function startFakeOpenAI({ noToolCall = false, nativeImage = false, toolName = 'create_prototype' } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let rawBody = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
      rawBody += chunk;
    }

    const body = JSON.parse(rawBody);
    requests.push({ headers: req.headers, path: req.url, body });

    if (requests.length === 2) {
      const toolMessages = body.messages.filter(({ role }) => role === 'tool');
      if (toolMessages.length !== 1 || toolMessages[0].tool_call_id !== 'call_1') {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing correlated tool response' } }));
        return;
      }
    }

    if (nativeImage && body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const common = { id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 1, model: 'resolved-model' };
      const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } };
      res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', images: [image] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }

    const message = nativeImage
      ? { role: 'assistant', content: null, images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }
      : noToolCall
      ? { role: 'assistant', content: 'Ready.' }
      : requests.length === 1
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function:
                  toolName === 'openrouter_image_gen'
                    ? { name: toolName, arguments: '{"prompt":"a tiger"}' }
                    : { name: toolName, arguments: '{"spec":"CRM"}' },
              },
            ],
          }
        : { role: 'assistant', content: 'Prototype accepted.' };

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl_${requests.length}`,
        object: 'chat.completion',
        created: 1,
        model: 'resolved-model',
        choices: [
          {
            index: 0,
            message,
            finish_reason: !noToolCall && !nativeImage && requests.length === 1 ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    requests,
    server,
    baseURL: `http://127.0.0.1:${port}/v1`,
  };
}

describe('OpenRouter image generation on an ordinary chat', () => {
  let fake;
  let loggedErrors;
  let previousImageModel;

  beforeEach(() => {
    previousImageModel = process.env.OPENROUTER_IMAGE_MODEL;
    delete process.env.OPENROUTER_IMAGE_MODEL;
    loggedErrors = [];
    jest.spyOn(logger, 'error').mockImplementation((...args) => loggedErrors.push(args));
  });

  afterEach(async () => {
    if (previousImageModel === undefined) delete process.env.OPENROUTER_IMAGE_MODEL;
    else process.env.OPENROUTER_IMAGE_MODEL = previousImageModel;
    jest.restoreAllMocks();
    if (fake?.server.listening) {
      fake.server.close();
      await once(fake.server, 'close');
    }
  });

  it('uses the configured artist and sends only the current message in direct mode', async () => {
    process.env.OPENROUTER_IMAGE_MODEL = 'resolved-model';
    fake = await startFakeOpenAI({ nativeImage: true });
    const req = {
      cookies: { developing: '1' },
      user: { id: 'user_1', tenantId: 'tenant_1' },
      body: { conversationId: 'conversation_1', messageId: 'message_1', model: 'selected-model',
        endpoint: 'OpenRouter', image_generation_direct: true },
      config: { endpoints: {
        agents: { allowedProviders: ['OpenRouter'], capabilities: [AgentCapabilities.tools] },
        custom: [{ name: 'OpenRouter', apiKey: 'local-fake-key', baseURL: fake.baseURL,
          models: { default: ['resolved-model', 'selected-model'], fetch: false } }],
      } },
    };
    const res = { write: jest.fn(), end: jest.fn(), headersSent: false };
    const endpointOption = require('~/server/services/Endpoints/agents').buildOptions(
      req, 'OpenRouter', { model: 'selected-model', streaming: true }, 'custom',
    );
    const { client } = await initializeClient({ req, res, signal: new AbortController().signal, endpointOption });
    client.conversationId = req.body.conversationId;
    client.responseMessageId = req.body.messageId;
    client.parentMessageId = 'parent_1';
    client.user = req.user.id;
    client.indexTokenCountMap = { 0: 8 };
    await client.chatCompletion({ payload: [{ role: 'user', content: 'Draw a tiger.' }] });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].body.model).toBe('resolved-model');
    expect(fake.requests[0].body.modalities).toEqual(['image', 'text']);
    expect(fake.requests[0].body.messages).toHaveLength(1);
    expect(fake.requests[0].body.messages[0].role).toBe('user');
    expect(fake.requests[0].body.messages[0].content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Draw a tiger.' })]),
    );
    expect(await Promise.all(client.artifactPromises)).toEqual([expect.objectContaining({ file_id: 'saved_image' })]);
  });

  it('rejects a direct OpenRouter image tool call without the developing cookie', async () => {
    const OpenRouterImageGen = require('~/app/clients/tools/structured/OpenRouterImageGen');
    const tool = new OpenRouterImageGen({ req: { cookies: {} }, userId: 'user_1', model: 'model' });
    await expect(tool._call({ prompt: 'A tiger' })).rejects.toThrow('image generation is unavailable');
  });

  it('does not add the OpenRouter image tool without the developing cookie', async () => {
    const agent = await mockApi.loadEphemeralAgent({
      req: { user: { id: 'user_1' }, cookies: {}, body: { ephemeralAgent: { image_generation: true } },
        config: { endpoints: { custom: [] } } },
      endpoint: 'OpenRouter', model_parameters: { model: 'model' },
    }, { getAgent: jest.fn(), getMCPServerTools: jest.fn() });
    expect(agent.tools).not.toContain('openrouter_image_gen');
    expect(agent.instructions ?? '').not.toContain('openrouter_image_gen');
  });

  it('passes the OpenRouter image tool to an ordinary chat model', async () => {
    fake = await startFakeOpenAI({ noToolCall: true });
    const req = {
      cookies: { developing: '1' },
      user: { id: 'user_1', tenantId: 'tenant_1' },
      body: {
        conversationId: 'conversation_1',
        messageId: 'message_1',
        model: 'resolved-model',
        ephemeralAgent: { image_generation: true },
      },
      config: {
        endpoints: {
          agents: { allowedProviders: ['OpenRouter'], capabilities: [AgentCapabilities.tools] },
          custom: [
            {
              name: 'OpenRouter',
              apiKey: 'local-fake-key',
              baseURL: fake.baseURL,
              models: { default: ['resolved-model'], fetch: false },
            },
          ],
        },
      },
    };
    const res = { write: jest.fn(), end: jest.fn(), headersSent: false };
    const endpointOption = require('~/server/services/Endpoints/agents').buildOptions(
      req,
      'OpenRouter',
      { model: 'resolved-model', streaming: false },
      'custom',
    );
    const { client } = await initializeClient({
      req,
      res,
      signal: new AbortController().signal,
      endpointOption,
    });

    expect(client.options.agent.toolDefinitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'openrouter_image_gen' })]),
    );
    client.conversationId = req.body.conversationId;
    client.responseMessageId = req.body.messageId;
    client.parentMessageId = 'parent_1';
    client.user = req.user.id;
    client.indexTokenCountMap = { 0: 8 };
    await client.chatCompletion({
      payload: [
        {
          text: 'Create a picture of a tiger.',
          sender: 'User',
          isCreatedByUser: true,
          content: [{ type: 'text', text: 'Create a picture of a tiger.' }],
          messageId: 'user_message_1',
          parentMessageId: 'parent_1',
          tokenCount: 8,
        },
      ],
    });

    expect(loggedErrors).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({ name: 'openrouter_image_gen' }),
        }),
      ]),
    );
    expect(JSON.stringify(fake.requests[0].body.messages)).toContain('openrouter_image_gen');
  });

  it('saves a native OpenRouter image returned by an ordinary chat model', async () => {
    fake = await startFakeOpenAI({ nativeImage: true });
    const req = {
      cookies: { developing: '1' },
      user: { id: 'user_1', tenantId: 'tenant_1' },
      body: {
        conversationId: 'conversation_1',
        messageId: 'message_1',
        model: 'resolved-model',
        endpoint: 'OpenRouter',
        ephemeralAgent: { image_generation: true },
      },
      config: {
        endpoints: {
          agents: { allowedProviders: ['OpenRouter'], capabilities: [AgentCapabilities.tools] },
          custom: [
            {
              name: 'OpenRouter',
              apiKey: 'local-fake-key',
              baseURL: fake.baseURL,
              models: { default: ['resolved-model'], fetch: false },
            },
          ],
        },
      },
    };
    const res = { write: jest.fn(), end: jest.fn(), headersSent: false };
    const endpointOption = require('~/server/services/Endpoints/agents').buildOptions(
      req,
      'OpenRouter',
      { model: 'resolved-model', streaming: false },
      'custom',
    );
    const { client } = await initializeClient({
      req,
      res,
      signal: new AbortController().signal,
      endpointOption,
    });

    expect(client.options.agent.toolDefinitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'openrouter_image_gen' })]),
    );
    client.conversationId = req.body.conversationId;
    client.responseMessageId = req.body.messageId;
    client.parentMessageId = 'parent_1';
    client.user = req.user.id;
    client.indexTokenCountMap = { 0: 8 };
    await client.chatCompletion({
      payload: [
        {
          text: 'Create a picture of a tiger.',
          sender: 'User',
          isCreatedByUser: true,
          content: [{ type: 'text', text: 'Create a picture of a tiger.' }],
          messageId: 'user_message_1',
          parentMessageId: 'parent_1',
          tokenCount: 8,
        },
      ],
    });

    expect(loggedErrors).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(require('~/server/services/Files/process').saveBase64Image).toHaveBeenCalledWith(
      'data:image/png;base64,aGVsbG8=', expect.objectContaining({ req }),
    );
    expect(await Promise.all(client.artifactPromises)).toEqual([expect.objectContaining({ file_id: 'saved_image' })]);
  });

  it('saves a native OpenRouter image returned over a stream', async () => {
    fake = await startFakeOpenAI({ nativeImage: true });
    const req = {
      cookies: { developing: '1' },
      user: { id: 'user_1', tenantId: 'tenant_1' },
      body: {
        conversationId: 'conversation_1',
        messageId: 'message_1',
        model: 'resolved-model',
        endpoint: 'OpenRouter',
      },
      config: {
        endpoints: {
          agents: { allowedProviders: ['OpenRouter'], capabilities: [AgentCapabilities.tools] },
          custom: [
            {
              name: 'OpenRouter',
              apiKey: 'local-fake-key',
              baseURL: fake.baseURL,
              models: { default: ['resolved-model'], fetch: false },
            },
          ],
        },
      },
    };
    const res = { write: jest.fn(), end: jest.fn(), headersSent: false };
    const endpointOption = require('~/server/services/Endpoints/agents').buildOptions(
      req,
      'OpenRouter',
      { model: 'resolved-model', streaming: true },
      'custom',
    );
    const { client } = await initializeClient({
      req,
      res,
      signal: new AbortController().signal,
      endpointOption,
    });

    client.conversationId = req.body.conversationId;
    client.responseMessageId = req.body.messageId;
    client.parentMessageId = 'parent_1';
    client.user = req.user.id;
    client.indexTokenCountMap = { 0: 8 };
    await client.chatCompletion({
      payload: [
        {
          text: 'Create a picture of a tiger.',
          sender: 'User',
          isCreatedByUser: true,
          content: [{ type: 'text', text: 'Create a picture of a tiger.' }],
          messageId: 'user_message_1',
          parentMessageId: 'parent_1',
          tokenCount: 8,
        },
      ],
    });

    expect(loggedErrors).toEqual([]);
    expect(fake.requests).toHaveLength(1);
    expect(require('~/server/services/Files/process').saveBase64Image).toHaveBeenCalledWith(
      'data:image/png;base64,aGVsbG8=', expect.objectContaining({ req }),
    );
    expect(await Promise.all(client.artifactPromises)).toEqual([expect.objectContaining({ file_id: 'saved_image' })]);
  });

  it('reports a streamed OpenRouter image save failure in the response', async () => {
    fake = await startFakeOpenAI({ nativeImage: true });
    require('~/server/services/Files/process').saveBase64Image.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const req = {
      cookies: { developing: '1' },
      user: { id: 'user_1', tenantId: 'tenant_1' },
      body: {
        conversationId: 'conversation_1',
        messageId: 'message_1',
        model: 'resolved-model',
        endpoint: 'OpenRouter',
        ephemeralAgent: { image_generation: true },
      },
      config: {
        endpoints: {
          agents: { allowedProviders: ['OpenRouter'], capabilities: [AgentCapabilities.tools] },
          custom: [
            {
              name: 'OpenRouter',
              apiKey: 'local-fake-key',
              baseURL: fake.baseURL,
              models: { default: ['resolved-model'], fetch: false },
            },
          ],
        },
      },
    };
    const res = { write: jest.fn(), end: jest.fn(), headersSent: false };
    const endpointOption = require('~/server/services/Endpoints/agents').buildOptions(
      req,
      'OpenRouter',
      { model: 'resolved-model', streaming: true },
      'custom',
    );
    const { client } = await initializeClient({
      req,
      res,
      signal: new AbortController().signal,
      endpointOption,
    });

    expect(client.options.agent.toolDefinitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'openrouter_image_gen' })]),
    );
    client.conversationId = req.body.conversationId;
    client.responseMessageId = req.body.messageId;
    client.parentMessageId = 'parent_1';
    client.user = req.user.id;
    client.indexTokenCountMap = { 0: 8 };
    await client.chatCompletion({
      payload: [
        {
          text: 'Create a picture of a tiger.',
          sender: 'User',
          isCreatedByUser: true,
          content: [{ type: 'text', text: 'Create a picture of a tiger.' }],
          messageId: 'user_message_1',
          parentMessageId: 'parent_1',
          tokenCount: 8,
        },
      ],
    });

    expect(loggedErrors.some((entry) => entry.includes('[OpenRouter image] save failed'))).toBe(true);
    expect(fake.requests).toHaveLength(1);
    expect(require('~/server/services/Files/process').saveBase64Image).toHaveBeenCalledWith(
      'data:image/png;base64,aGVsbG8=', expect.objectContaining({ req }),
    );
    const { initializeFakeClient } = require('~/app/clients/specs/FakeClient');
    const replyClient = initializeFakeClient('fake', { req }, []);
    replyClient.artifactPromises = client.artifactPromises;
    replyClient.saveMessageToDatabase = jest.fn().mockResolvedValue({});
    const response = await replyClient.sendMessage('Create a picture');
    expect(response.text).toContain('Изображение создано, но не удалось его сохранить');
    expect(response.attachments).toEqual([]);
    expect(replyClient.saveMessageToDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Изображение создано, но не удалось его сохранить') }),
      expect.anything(), null,
    );
  });

  it('executes an image tool call using the user key and attaches the returned image', async () => {
    fake = await startFakeOpenAI({ toolName: 'openrouter_image_gen' });
    const axios = require('axios');
    const imageRequest = jest.spyOn(axios, 'post').mockResolvedValue({
      data: {
        choices: [
          { message: { images: [{ image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] } },
        ],
      },
    });
    require('~/models').getUserKeyValues.mockResolvedValue({ apiKey: 'user-openrouter-key' });
    const req = {
      cookies: { developing: '1' },
      user: { id: 'user_1', tenantId: 'tenant_1' },
      body: {
        conversationId: 'conversation_1',
        messageId: 'message_1',
        model: 'resolved-model',
        ephemeralAgent: { image_generation: true },
      },
      config: {
        endpoints: {
          agents: { allowedProviders: ['OpenRouter'], capabilities: [AgentCapabilities.tools] },
          custom: [
            {
              name: 'OpenRouter',
              apiKey: 'local-fake-key',
              baseURL: fake.baseURL,
              models: { default: ['resolved-model'], fetch: false },
            },
          ],
        },
      },
    };
    const res = { write: jest.fn(), end: jest.fn(), headersSent: false };
    const endpointOption = require('~/server/services/Endpoints/agents').buildOptions(
      req,
      'OpenRouter',
      { model: 'resolved-model', streaming: false },
      'custom',
    );
    const { client } = await initializeClient({
      req,
      res,
      signal: new AbortController().signal,
      endpointOption,
    });
    // The fake LLM stays on loopback; the image transport is intercepted by axios.
    req.config.endpoints.custom[0].baseURL = 'https://openrouter.example/v1';
    req.config.endpoints.custom[0].apiKey = 'user_provided';
    client.conversationId = req.body.conversationId;
    client.responseMessageId = req.body.messageId;
    client.parentMessageId = 'parent_1';
    client.user = req.user.id;
    client.indexTokenCountMap = { 0: 8 };
    await client.chatCompletion({
      payload: [
        {
          text: 'Create a picture of a tiger.',
          sender: 'User',
          isCreatedByUser: true,
          content: [{ type: 'text', text: 'Create a picture of a tiger.' }],
          messageId: 'user_message_1',
          parentMessageId: 'parent_1',
          tokenCount: 8,
        },
      ],
    });

    expect(loggedErrors).toEqual([]);
    expect(fake.requests).toHaveLength(2);
    expect(imageRequest).toHaveBeenCalledWith(
      'https://openrouter.example/v1/chat/completions',
      expect.objectContaining({
        model: 'google/gemini-2.5-flash-image',
        messages: [{ role: 'user', content: 'a tiger' }],
        modalities: ['image', 'text'],
        stream: false,
      }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer user-openrouter-key' }) }),
    );
    expect(require('~/server/services/Files/process').saveBase64Image).toHaveBeenCalledWith(
      'data:image/png;base64,aGVsbG8=',
      expect.objectContaining({ req }),
    );
  });
});
