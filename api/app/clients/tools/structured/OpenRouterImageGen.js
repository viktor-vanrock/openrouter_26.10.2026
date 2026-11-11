const axios = require('axios');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { StructuredTool } = require('@librechat/agents/langchain/tools');
const { ContentTypes, extractEnvVariable } = require('librechat-data-provider');
const { getUserKeyValues } = require('~/models');
const {
  getOpenRouterImageConfig,
} = require('~/server/services/Endpoints/agents/openrouterImageConfig');

const schema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(10000)
      .describe('Detailed description of the image to generate.'),
  })
  .strict();

const displayMessage =
  "OpenRouter generated an image. The image is shown above; don't repeat its description.";

function imageUrlFromMessage(message) {
  const candidates = [
    ...(Array.isArray(message?.images) ? message.images : []),
    ...(Array.isArray(message?.content) ? message.content : []),
  ];
  for (const item of candidates) {
    const url = item?.image_url?.url ?? item?.url;
    if (
      typeof url === 'string' &&
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(url)
    ) {
      return url;
    }
  }
  return null;
}

class OpenRouterImageGen extends StructuredTool {
  constructor(fields = {}) {
    super(fields);
    this.name = 'openrouter_image_gen';
    this.description =
      'Generate an actual image from the user’s request using the configured OpenRouter image model. Call this for requests to create or draw a new image; do not use it when the user asks for code that draws an image.';
    this.schema = schema;
    this.req = fields.req;
    this.userId = fields.userId;
    this.model = getOpenRouterImageConfig().model;
    this.responseFormat = 'content_and_artifact';
  }

  async _call({ prompt }, _runManager, config) {
    const endpoint = this.req?.config?.endpoints?.custom?.find(
      (item) => item.name?.toLowerCase() === 'openrouter',
    );
    if (!endpoint?.baseURL) throw new Error('OpenRouter image generation is not configured.');

    let credentials;
    try {
      credentials = await getUserKeyValues({ userId: this.userId, name: endpoint.name });
    } catch {
      credentials = undefined;
    }
    const configuredApiKey = extractEnvVariable(endpoint.apiKey);
    const configuredBaseURL = extractEnvVariable(endpoint.baseURL);
    const apiKey = configuredApiKey === 'user_provided' ? credentials?.apiKey : configuredApiKey;
    if (!apiKey || apiKey === 'user_provided') {
      throw new Error(
        'Add your OpenRouter API key in the endpoint settings before generating images.',
      );
    }

    let baseURL;
    try {
      baseURL = new URL(
        configuredBaseURL === 'user_provided' ? credentials?.baseURL : configuredBaseURL,
      );
    } catch {
      throw new Error('OpenRouter image generation requires a valid HTTPS endpoint.');
    }
    if (
      baseURL.protocol !== 'https:' ||
      baseURL.username ||
      baseURL.password ||
      baseURL.search ||
      baseURL.hash
    ) {
      throw new Error('OpenRouter image generation requires a valid HTTPS endpoint.');
    }
    const url = `${baseURL.toString().replace(/\/+$/, '')}/chat/completions`;
    let response;
    try {
      response = await axios.post(
        url,
        {
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          modalities: ['image', 'text'],
          stream: false,
        },
        {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 180000,
          maxRedirects: 0,
          maxContentLength: 40 * 1024 * 1024,
          maxBodyLength: 32 * 1024,
          signal: config?.signal,
        },
      );
    } catch {
      if (config?.signal?.aborted) throw new Error('OpenRouter image generation was cancelled.');
      // Axios errors retain authorization headers and image data on their config/response.
      // Do not propagate that object into tool execution logs or model-visible errors.
      throw new Error('Не удалось выполнить запрос на создание изображения. Попробуйте позже.');
    }

    const message = response.data?.choices?.[0]?.message;
    const imageUrl = imageUrlFromMessage(message);
    if (!imageUrl) {
      const finishReason = response.data?.choices?.[0]?.finish_reason;
      throw new Error(
        `OpenRouter model did not return image data${finishReason ? ` (finish reason: ${finishReason})` : ''}.`,
      );
    }

    const id = randomUUID();
    return [
      [{ type: ContentTypes.TEXT, text: `${displayMessage}\ngenerated_image_id: "${id}"` }],
      {
        content: [{ type: ContentTypes.IMAGE_URL, image_url: { url: imageUrl } }],
        file_ids: [id],
      },
    ];
  }
}

module.exports = OpenRouterImageGen;
