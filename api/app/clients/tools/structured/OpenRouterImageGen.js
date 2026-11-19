const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { StructuredTool } = require('@librechat/agents/langchain/tools');
const { ContentTypes } = require('librechat-data-provider');
const { generateImage, FAILURE } = require('~/server/services/Images/openrouter');

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

class OpenRouterImageGen extends StructuredTool {
  constructor(fields = {}) {
    super(fields);
    this.name = 'openrouter_image_gen';
    this.description =
      'Generate an actual image from the user’s request using the configured OpenRouter image model. Call this for requests to create or draw a new image; do not use it when the user asks for code that draws an image. If the tool reports a failure, tell the user that generation failed and do not claim an image was created.';
    this.schema = schema;
    this.req = fields.req;
    this.userId = fields.userId;
    this.responseFormat = 'content_and_artifact';
  }

  async _call({ prompt }, _runManager, config) {
    const result = await generateImage({ req: this.req, prompt, signal: config?.signal });
    if (!result) {
      return [[{ type: ContentTypes.TEXT, text: FAILURE }], {}];
    }
    const imageUrl = result.url;
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
