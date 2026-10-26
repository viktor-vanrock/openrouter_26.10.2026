import {
  DEFAULT_WEB_SEARCH_MODEL,
  filterToolsCapableModels,
  filterWebSearchCapableModels,
  isToolsCapableModel,
  supportsNativeWebSearch,
} from './models';

describe('native web search model support', () => {
  it('identifies supported models by their full OpenRouter model ID', () => {
    expect(supportsNativeWebSearch('perplexity/sonar')).toBe(true);
    expect(supportsNativeWebSearch('google/gemini-2.0-flash-001')).toBe(true);
    expect(supportsNativeWebSearch('openai/gpt-4o')).toBe(false);
  });

  it('filters a provider model list without changing its order', () => {
    expect(
      filterWebSearchCapableModels([
        'openai/gpt-4o',
        'perplexity/sonar',
        'google/gemini-2.0-flash-001',
      ]),
    ).toEqual(['perplexity/sonar', 'google/gemini-2.0-flash-001']);
  });

  it('uses Perplexity Sonar as the default web search model', () => {
    expect(DEFAULT_WEB_SEARCH_MODEL).toBe('perplexity/sonar');
  });
});

describe('tool-capable model support', () => {
  const models = [
    { id: 'tools-model', supported_parameters: ['tools'] },
    { id: 'functions-model', supported_parameters: ['function_calling'] },
    { id: 'plain-model', supported_parameters: ['temperature'] },
    { id: 'unknown-model' },
  ];

  it('accepts both OpenRouter tool capability names', () => {
    expect(isToolsCapableModel(models[0])).toBe(true);
    expect(isToolsCapableModel(models[1])).toBe(true);
    expect(isToolsCapableModel(models[2])).toBe(false);
    expect(isToolsCapableModel(models[3])).toBe(false);
  });

  it('filters models without changing their order', () => {
    expect(filterToolsCapableModels(models)).toEqual(models.slice(0, 2));
  });
});
