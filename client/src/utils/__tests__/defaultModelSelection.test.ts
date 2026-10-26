import { EModelEndpoint, LocalStorageKeys, getEndpointField } from 'librechat-data-provider';
import type {
  TEndpointsConfig,
  TModelsConfig,
  TPreset,
  TConversation,
} from 'librechat-data-provider';
import getDefaultEndpoint from '../getDefaultEndpoint';
import buildDefaultConvo from '../buildDefaultConvo';
import { mapEndpoints } from '../endpoints';
import { getDisplayValue } from '~/components/Chat/Menus/Endpoints/utils';

const endpointsConfig: TEndpointsConfig = {
  agents: { order: 1 },
  OpenRouter: { type: EModelEndpoint.custom, order: 9999 },
};
const modelsConfig: TModelsConfig = {
  OpenRouter: ['anthropic/claude-sonnet-4', 'openai/gpt-4o-mini', 'openai/gpt-4o'],
};

function resolveSelection(setup: Partial<TPreset> = {}, models = modelsConfig) {
  const endpoint = getDefaultEndpoint({ convoSetup: setup, endpointsConfig, modelsConfig: models });
  const conversation: TConversation = {
    conversationId: 'new',
    title: 'New Chat',
    createdAt: '',
    updatedAt: '',
    endpoint: null,
    endpointType: getEndpointField(endpointsConfig, endpoint, 'type'),
  };
  const result = buildDefaultConvo({
    endpoint,
    conversation,
    models: models[endpoint ?? ''] ?? [],
    lastConversationSetup: setup as TConversation,
  });
  return {
    ...result,
    display: getDisplayValue({
      localize: (key) => key,
      mappedEndpoints: [
        { value: 'agents', label: 'My Agents', hasModels: false, icon: null },
        { value: 'OpenRouter', label: 'OpenRouter', hasModels: true, icon: null },
      ],
      selectedValues: { endpoint: result.endpoint ?? '', model: result.model ?? '', modelSpec: '' },
      modelSpecs: [],
    }),
  };
}

describe('initial model selection without restricting available models', () => {
  beforeEach(() => localStorage.clear());

  it('selects GPT-4o before Agents for an empty browser, even when GPT-4o is not first', () => {
    expect(resolveSelection()).toMatchObject({
      endpoint: 'OpenRouter',
      model: 'openai/gpt-4o',
      display: 'openai/gpt-4o',
    });
  });

  it('falls back to Agents when GPT-4o is unavailable', () => {
    expect(resolveSelection({}, { OpenRouter: ['other/model'] })).toMatchObject({
      endpoint: 'agents',
    });
  });

  it('preserves a saved ordinary model', () => {
    localStorage.setItem(
      `${LocalStorageKeys.LAST_CONVO_SETUP}_0`,
      JSON.stringify({
        endpoint: 'OpenRouter',
        model: 'anthropic/claude-sonnet-4',
      }),
    );
    expect(resolveSelection()).toMatchObject({ model: 'anthropic/claude-sonnet-4' });
  });

  it('preserves an explicit model', () => {
    expect(resolveSelection({ endpoint: 'OpenRouter', model: 'openai/gpt-4o-mini' })).toMatchObject(
      { model: 'openai/gpt-4o-mini' },
    );
  });

  it('preserves a model stored in the per-provider preferences', () => {
    localStorage.setItem(
      LocalStorageKeys.LAST_MODEL,
      JSON.stringify({ OpenRouter: 'openai/gpt-4o-mini' }),
    );
    expect(resolveSelection()).toMatchObject({
      endpoint: 'OpenRouter',
      model: 'openai/gpt-4o-mini',
    });
  });

  it('allows an explicit switch to Agents even while GPT-4o is available', () => {
    expect(resolveSelection({ endpoint: EModelEndpoint.agents })).toMatchObject({
      endpoint: 'agents',
    });
  });

  it('supports the native OpenAI GPT-4o identifier', () => {
    expect(
      getDefaultEndpoint({
        convoSetup: {},
        endpointsConfig: { agents: { order: 0 }, openAI: { order: 1 } },
        modelsConfig: { openAI: ['gpt-4o-mini', 'gpt-4o'] },
      }),
    ).toBe(EModelEndpoint.openAI);
  });

  it('keeps a selected agent ahead of GPT-4o', () => {
    localStorage.setItem(
      `${LocalStorageKeys.LAST_CONVO_SETUP}_0`,
      JSON.stringify({
        endpoint: 'agents',
        agent_id: 'agent_chosen',
      }),
    );
    expect(resolveSelection()).toMatchObject({ endpoint: 'agents' });
  });

  it('replaces a previously empty My Agents state with GPT-4o', () => {
    localStorage.setItem(
      `${LocalStorageKeys.LAST_CONVO_SETUP}_0`,
      JSON.stringify({ endpoint: 'agents' }),
    );
    expect(resolveSelection()).toMatchObject({ endpoint: 'OpenRouter', model: 'openai/gpt-4o' });
  });

  it('retains every model and endpoint while allowing selection of each model', () => {
    const before = JSON.stringify({ endpointsConfig, modelsConfig });
    for (const model of modelsConfig.OpenRouter) {
      expect(resolveSelection({ endpoint: 'OpenRouter', model })).toMatchObject({ model });
    }
    expect(mapEndpoints(endpointsConfig)).toEqual(['agents', 'OpenRouter']);
    expect(JSON.stringify({ endpointsConfig, modelsConfig })).toBe(before);
  });
});
