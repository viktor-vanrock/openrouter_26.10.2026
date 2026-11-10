const axios = require('axios');
const { getUserKeyValues } = require('~/models');
const OpenRouterImageGen = require('../OpenRouterImageGen');

jest.mock('axios', () => ({ post: jest.fn() }));
jest.mock('~/models', () => ({ getUserKeyValues: jest.fn() }));

const image = 'data:image/png;base64,aGVsbG8=';

function tool(endpoint, cookies = { developing: '1' }) {
  return new OpenRouterImageGen({
    userId: 'test-user',
    req: {
      cookies,
      config: { endpoints: { custom: [{ name: 'OpenRouter', ...endpoint }] } },
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  getUserKeyValues.mockResolvedValue({
    apiKey: 'user-test-key',
    baseURL: 'https://user.example/v1',
  });
  axios.post.mockResolvedValue({
    data: { choices: [{ message: { images: [{ image_url: { url: image } }] } }] },
  });
});

it('resolves environment references and keeps a configured server key', async () => {
  process.env.OPENROUTER_IMAGE_TEST_KEY = 'server-test-key';
  process.env.OPENROUTER_IMAGE_TEST_URL = 'https://server.example/v1';
  try {
    await tool({
      apiKey: '${OPENROUTER_IMAGE_TEST_KEY}',
      baseURL: '${OPENROUTER_IMAGE_TEST_URL}',
    })._call({ prompt: 'A cat' });
    expect(axios.post).toHaveBeenCalledWith(
      'https://server.example/v1/chat/completions',
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer server-test-key' }),
      }),
    );
  } finally {
    delete process.env.OPENROUTER_IMAGE_TEST_KEY;
    delete process.env.OPENROUTER_IMAGE_TEST_URL;
  }
});

it('uses user credentials and base URL when the endpoint requests them', async () => {
  await tool({ apiKey: 'user_provided', baseURL: 'user_provided' })._call({ prompt: 'A cat' });
  expect(axios.post).toHaveBeenCalledWith(
    'https://user.example/v1/chat/completions',
    expect.any(Object),
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer user-test-key' }),
    }),
  );
});

it('does not expose an Axios error containing credentials', async () => {
  axios.post.mockRejectedValue(
    Object.assign(new Error('private gateway details'), {
      config: { headers: { Authorization: 'Bearer private-test-key' } },
    }),
  );
  const result = tool({ apiKey: 'user_provided', baseURL: 'https://server.example/v1' })._call({
    prompt: 'A cat',
  });
  await expect(result).rejects.toThrow('Не удалось выполнить запрос на создание изображения');
});

it('never sends an image request without the cookie', async () => {
  await expect(
    tool({ apiKey: 'user_provided', baseURL: 'https://server.example/v1' }, {})._call({
      prompt: 'A cat',
    }),
  ).rejects.toThrow('unavailable');
  expect(axios.post).not.toHaveBeenCalled();
});
