const { evaluateModel, listRecommendedModels } = require('./PrototypeModelPolicy');

const policy = {
  version: 'policy-v1',
  recommendedPatterns: ['openai/gpt-*-codex*', 'literal/model[1]'],
  blockedPatterns: ['blocked/*', 'openai/gpt-secret-*'],
  requireToolCalling: true,
  unknownModelPolicy: 'warn',
};

describe('PrototypeModelPolicy', () => {
  it('does not warn about the chat-selected model when no recommendations are configured', () => {
    expect(evaluateModel({ modelId: 'provider/chat-selected', providerCapabilities: {},
      policy: { version: 'chat', blockedPatterns: [], requireToolCalling: false } })).toMatchObject({
      allowed: true, recommendation: 'recommended',
    });
  });
  it.each([
    [
      'recommended model',
      { modelId: 'openai/gpt-5-codex', providerCapabilities: { toolCalling: true } },
      { allowed: true, recommendation: 'recommended', policyVersion: 'policy-v1' },
    ],
    [
      'compatible unknown model',
      { modelId: 'provider/unknown', providerCapabilities: { toolCalling: true } },
      { allowed: true, recommendation: 'not_recommended', policyVersion: 'policy-v1' },
    ],
    [
      'tool-incompatible model',
      { modelId: 'provider/text-only', providerCapabilities: { toolCalling: false } },
      { allowed: false, code: 'PROTOTYPE_MODEL_UNSUPPORTED', policyVersion: 'policy-v1' },
    ],
    [
      'blocked model before capability evaluation',
      { modelId: 'blocked/text-only', providerCapabilities: { toolCalling: false } },
      { allowed: false, code: 'PROTOTYPE_MODEL_BLOCKED', policyVersion: 'policy-v1' },
    ],
  ])('evaluates a %s', (_name, input, expected) => {
    expect(evaluateModel({ ...input, policy })).toEqual(expect.objectContaining(expected));
  });

  it('treats policy patterns as escaped globs rather than regular expressions', () => {
    expect(evaluateModel({
      modelId: 'literal/model1', providerCapabilities: { toolCalling: true }, policy,
    })).toMatchObject({ allowed: true, recommendation: 'not_recommended' });
    expect(evaluateModel({
      modelId: 'literal/model[1]', providerCapabilities: { toolCalling: true }, policy,
    })).toMatchObject({ allowed: true, recommendation: 'recommended' });
  });

  it('lists available recommended models once in deterministic order', () => {
    expect(listRecommendedModels({
      availableModelIds: ['openai/gpt-5-codex', 'provider/unknown', 'openai/gpt-4-codex', 'openai/gpt-5-codex'],
      policy,
    })).toEqual(['openai/gpt-4-codex', 'openai/gpt-5-codex']);
  });
});
