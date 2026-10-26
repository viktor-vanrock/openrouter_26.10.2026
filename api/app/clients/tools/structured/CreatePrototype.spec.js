const { zodToJsonSchema } = require('zod-to-json-schema');
const CreatePrototype = require('./CreatePrototype');

const makeReq = ({ userId = 'u1', tenantId = 't1', model = 'client/untrusted-model' } = {}) => ({
  user: { id: userId, tenantId },
  config: { prototypeAgent: { enabled: true } },
  body: { model },
});

describe('CreatePrototype', () => {
  it('derives identity from the request and model from resolved tool context', async () => {
    const prototypeService = {
      acceptToolCall: jest.fn().mockResolvedValue({ job_id: 'job_1' }),
    };
    const tool = new CreatePrototype({
      req: makeReq(),
      model: 'openai/gpt-codex',
      prototypeService,
      userId: 'untrusted-user',
      tenantId: 'untrusted-tenant',
    });

    await tool.invoke({ spec: '  Build a CRM  ' });

    expect(prototypeService.acceptToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', tenantId: 't1', modelId: 'openai/gpt-codex' }),
      { spec: 'Build a CRM' },
    );
  });

  it('serializes a strict schema that accepts only spec', () => {
    const schema = zodToJsonSchema(new CreatePrototype({ req: makeReq() }).schema);

    expect(schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['spec'],
      properties: {
        spec: { type: 'string', minLength: 1, maxLength: 50000 },
      },
    });
    expect(schema.properties).not.toHaveProperty('model');
  });

  it.each([{ spec: '   ' }, { spec: 'x'.repeat(50001) }, { spec: 'valid', model: 'x' }])(
    'rejects invalid tool input %#',
    async (input) => {
      const tool = new CreatePrototype({ req: makeReq() });

      await expect(tool.invoke(input)).rejects.toThrow(
        'Received tool input did not match expected schema',
      );
    },
  );
});

it.each([false, undefined, null, 'true', 1])(
  'rejects injected tool execution with disabled feature %s',
  async (enabled) => {
    const req = makeReq();
    req.config.prototypeAgent.enabled = enabled;
    const prototypeService = { acceptToolCall: jest.fn() };
    const tool = new CreatePrototype({ req, model: 'trusted/model', prototypeService });
    await expect(tool.invoke({ spec: 'Build a task manager' })).rejects.toMatchObject({
      code: 'PROTOTYPE_SERVICE_UNAVAILABLE',
    });
    expect(prototypeService.acceptToolCall).not.toHaveBeenCalled();
  },
);
