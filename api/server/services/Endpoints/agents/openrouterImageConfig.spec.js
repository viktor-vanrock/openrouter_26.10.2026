const { getOpenRouterImageConfig, isDirectImageRequest } = require('./openrouterImageConfig');

describe('OpenRouter image configuration', () => {
  it('uses defaults for missing and blank values', () => {
    expect(getOpenRouterImageConfig({})).toEqual({
      model: 'google/gemini-2.5-flash-image',
      description: 'Google Gemini 2.5 Flash Image: создаёт изображения по тексту',
    });
    expect(getOpenRouterImageConfig({ OPENROUTER_IMAGE_MODEL: ' ' }).model)
      .toBe('google/gemini-2.5-flash-image');
  });

  it('uses configured values', () => {
    expect(getOpenRouterImageConfig({
      OPENROUTER_IMAGE_MODEL: ' example/model ',
      OPENROUTER_IMAGE_MODEL_DESCRIPTION: ' Художник ',
    })).toEqual({ model: 'example/model', description: 'Художник' });
  });

  it('requires the cookie, endpoint and direct flag', () => {
    const req = { cookies: { developing: '1' }, body: {
      endpoint: 'OpenRouter', image_generation_direct: true,
    } };
    expect(isDirectImageRequest(req)).toBe(true);
    expect(isDirectImageRequest({ ...req, cookies: {} })).toBe(false);
    expect(isDirectImageRequest({ ...req, body: { endpoint: 'OpenRouter', ephemeralAgent: { image_generation_direct: true } } })).toBe(false);
    expect(isDirectImageRequest({ ...req, body: { ...req.body, endpoint: 'other' } })).toBe(false);
    expect(isDirectImageRequest({ ...req, body: { endpoint: 'OpenRouter' } })).toBe(false);
  });
});
