function getOpenRouterImageConfig(env = process.env) {
  return {
    model: env.OPENROUTER_IMAGE_MODEL?.trim() || 'google/gemini-2.5-flash-image',
    description:
      env.OPENROUTER_IMAGE_MODEL_DESCRIPTION?.trim() ||
      'Google Gemini 2.5 Flash Image: создаёт изображения по тексту',
  };
}

function isDirectImageRequest(req) {
  return (
    req?.cookies?.developing === '1' &&
    req.body?.endpoint === 'OpenRouter' &&
    req.body?.image_generation_direct === true
  );
}

module.exports = { getOpenRouterImageConfig, isDirectImageRequest };
