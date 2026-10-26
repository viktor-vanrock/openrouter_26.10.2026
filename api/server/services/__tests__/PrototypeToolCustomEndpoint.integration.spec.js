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

async function startFakeOpenAI() {
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

    const message =
      requests.length === 1
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'create_prototype', arguments: '{"spec":"CRM"}' },
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
            finish_reason: requests.length === 1 ? 'tool_calls' : 'stop',
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

describe('prototype tool on an ordinary custom OpenRouter chat', () => {
  let fake;
  let loggedErrors;

  beforeEach(() => {
    loggedErrors = [];
    jest.spyOn(logger, 'error').mockImplementation((...args) => loggedErrors.push(args));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (fake?.server.listening) {
      fake.server.close();
      await once(fake.server, 'close');
    }
  });

  it('keeps create_prototype through production initialization, callbacks, and execution', async () => {
    // This drives the production composition used for ordinary custom-provider
    // chats: initializeAgent -> AgentClient -> createRun -> ON_TOOL_EXECUTE.
    fake = await startFakeOpenAI();
    const acceptToolCall = jest.fn().mockResolvedValue({ jobId: 'job_1' });
    const req = {
      user: { id: 'user_1', tenantId: 'tenant_1' },
      body: {
        conversationId: 'conversation_1',
        messageId: 'message_1',
        model: 'test-model',
      },
      config: {
        prototypeAgent: { enabled: true },
        endpoints: {
          agents: {
            allowedProviders: ['OpenRouter'],
            capabilities: [AgentCapabilities.tools],
          },
          custom: [
            {
              name: 'OpenRouter',
              apiKey: 'local-fake-key',
              baseURL: fake.baseURL,
              models: { default: ['test-model'], fetch: false },
            },
          ],
        },
        includedTools: ['create_prototype'],
      },
    };

    req.prototypeService = { acceptToolCall };
    const res = { write: jest.fn(), end: jest.fn(), headersSent: false };
    const endpointOption = require('~/server/services/Endpoints/agents').buildOptions(
      req,
      'OpenRouter',
      { model: 'resolved-model', streaming: false },
      'custom',
    );
    const selectedAgent = await endpointOption.agent;
    expect(selectedAgent.tools).toContain('create_prototype');
    const { client } = await initializeClient({
      req,
      res,
      signal: new AbortController().signal,
      endpointOption,
    });

    expect(client.options.agent.toolDefinitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'create_prototype' })]),
    );
    expect(client.options.agent.toolRegistry?.has('create_prototype')).toBe(true);

    client.conversationId = req.body.conversationId;
    client.responseMessageId = req.body.messageId;
    client.parentMessageId = 'parent_1';
    client.user = req.user.id;
    client.indexTokenCountMap = { 0: 8 };
    await client.chatCompletion({
      payload: [
        {
          text: 'Build a CRM prototype.',
          sender: 'User',
          isCreatedByUser: true,
          content: [{ type: 'text', text: 'Build a CRM prototype.' }],
          messageId: 'user_message_1',
          parentMessageId: 'parent_1',
          tokenCount: 8,
        },
      ],
    });

    expect(loggedErrors).toEqual([]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map((request) => request.path)).toEqual([
      '/v1/chat/completions',
      '/v1/chat/completions',
    ]);
    expect(fake.requests[0].body.tools[0].function.name).toBe('create_prototype');
    expect(fake.requests[0].body.tools[0].function.parameters).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: {
          spec: { type: 'string', minLength: 1, maxLength: 50000 },
        },
        additionalProperties: false,
        required: ['spec'],
      }),
    );
    expect(fake.requests[0].headers.authorization).toBe('Bearer local-fake-key');
    expect(fake.requests[0].headers.authorization).not.toContain('undefined');
    expect(acceptToolCall).toHaveBeenCalledTimes(1);
    expect(acceptToolCall).toHaveBeenCalledWith(
      {
        userId: 'user_1',
        tenantId: 'tenant_1',
        conversationId: 'conversation_1',
        messageId: 'message_1',
        modelId: 'resolved-model',
      },
      { spec: 'CRM' },
    );
    const toolMessages = fake.requests[1].body.messages.filter(({ role }) => role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].tool_call_id).toBe('call_1');
    const toolResult = Array.isArray(toolMessages[0].content)
      ? toolMessages[0].content.map(({ text }) => text).join('')
      : toolMessages[0].content;
    expect(JSON.parse(toolResult)).toEqual({
      accepted: true,
      job_id: 'job_1',
      status: 'queued',
      model_id: 'resolved-model',
    });
    expect(client.contentParts).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Prototype accepted.' })]),
    );
    expect(fake.requests).toHaveLength(2);
  });
});
