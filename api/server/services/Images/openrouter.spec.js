const axios = require('axios');
const { getUserKeyValues } = require('~/models');
const { normalizeModels, perImagePrice, generateImage } = require('./openrouter');
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('~/models', () => ({ getUserKeyValues: jest.fn() }));

const image = 'data:image/png;base64,aGVsbG8=';
const model = (id, pricing = {}, modalities = ['text', 'image']) => ({
  id,
  pricing,
  architecture: { output_modalities: modalities },
});
const req = {
  user: { id: 'test' },
  body: { imageModel: 'chosen' },
  config: {
    endpoints: {
      custom: [{ name: 'OpenRouter', apiKey: 'user_provided', baseURL: 'https://example.test/v1' }],
    },
  },
};
function mockCatalog(rows, prices) {
  axios.get.mockImplementation(async (url) => {
    if (url.endsWith('/models/user')) return { data: { data: rows } };
    const id = url.split('/images/models/')[1]?.replace('/endpoints', '');
    return {
      data: {
        endpoints: [
          {
            provider_tag: 'test-provider',
            pricing:
              prices[id] == null
                ? []
                : [{ billable: 'output_image', unit: 'image', cost_usd: prices[id] }],
          },
        ],
      },
    };
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockReset();
  axios.post.mockReset();
});

it('only compares prices explicitly charged per generated image', () => {
  expect(
    perImagePrice({
      endpoints: [
        {
          pricing: [
            { billable: 'input_image', unit: 'image', cost_usd: 0.001 },
            { billable: 'output_image', unit: 'token', cost_usd: 0.00001 },
          ],
        },
        {
          provider_tag: 'test-provider',
          pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.03 }],
        },
        {
          provider_tag: 'variant-provider',
          pricing: [{ billable: 'output_image', unit: 'image', variant: '4k', cost_usd: 0.001 }],
        },
      ],
    }),
  ).toEqual({ amount: 0.03, provider: 'test-provider' });
  expect(
    perImagePrice({
      endpoints: [{ pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.00001 }] }],
    }),
  ).toBeNull();
  expect(normalizeModels([model('input-only-price', { image: '0.000001' })])[0].price).toBeNull();
});

it('only includes models declaring image output and excludes routers', () => {
  const rows = normalizeModels([
    model('valid'),
    model('vision', {}, ['text']),
    model('openrouter/auto'),
    { id: 'legacy', architecture: { modality: 'text+image->image' } },
    { id: 'legacy-vision', architecture: { modality: 'text+image->text' } },
  ]);
  expect(rows.map((m) => m.id)).toEqual(['legacy', 'valid']);
});

it('tries the saved model then two different models ordered by per-image price', async () => {
  getUserKeyValues.mockResolvedValue({ apiKey: 'retry-key' });
  mockCatalog([model('chosen'), model('cheap'), model('next'), model('unknown')], {
    chosen: 0.5,
    cheap: 0.01,
    next: 0.1,
  });
  axios.post
    .mockRejectedValueOnce(new Error('timeout'))
    .mockResolvedValueOnce({ data: { choices: [{ message: {} }] } })
    .mockResolvedValueOnce({
      data: { choices: [{ message: { images: [{ image_url: { url: image } }] } }] },
    });
  const result = await generateImage({ req, prompt: 'cat' });
  expect(result.model).toBe('next');
  expect(axios.post.mock.calls.map((call) => call[1].model)).toEqual(['chosen', 'cheap', 'next']);
  expect(axios.get).toHaveBeenCalledWith(
    'https://example.test/v1/models/user',
    expect.objectContaining({ params: { output_modalities: 'image' } }),
  );
});

it('chooses a model with a known per-image price over an unknown one', async () => {
  getUserKeyValues.mockResolvedValue({ apiKey: 'default-key' });
  mockCatalog([model('unknown'), model('cheap')], { cheap: 0.02 });
  axios.post.mockResolvedValue({
    data: { choices: [{ message: { images: [{ image_url: { url: image } }] } }] },
  });
  expect(
    (await generateImage({ req: { ...req, body: { imageModel: 'invalid' } }, prompt: 'cat' }))
      .model,
  ).toBe('cheap');
});

it('does not try further models after a balance or credential error', async () => {
  getUserKeyValues.mockResolvedValue({ apiKey: 'balance-key' });
  mockCatalog([model('first'), model('second')], { first: 0.01, second: 0.02 });
  axios.post.mockRejectedValue({ response: { status: 402 } });
  expect(await generateImage({ req: { ...req, body: {} }, prompt: 'cat' })).toBeNull();
  expect(axios.post).toHaveBeenCalledTimes(1);
});

it('generates an image-only model using the image endpoint', async () => {
  getUserKeyValues.mockResolvedValue({ apiKey: 'image-only-key' });
  mockCatalog([model('provider/image', {}, ['image'])], {});
  axios.post.mockResolvedValue({ data: { data: [{ b64_json: 'YQ==' }] } });
  expect((await generateImage({ req: { ...req, body: {} }, prompt: 'cat' })).url).toBe(
    'data:image/png;base64,YQ==',
  );
  expect(axios.post).toHaveBeenCalledWith(
    'https://example.test/v1/images',
    { model: 'provider/image', prompt: 'cat' },
    expect.any(Object),
  );
});
