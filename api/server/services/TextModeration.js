const axios = require('axios');
const { isEnabled } = require('@librechat/api');

/** Shared policy/provider for normal chat and server-resolved prototype requirements. */
async function isTextFlagged(text) {
  if (!isEnabled(process.env.OPENAI_MODERATION)) return false;
  const response = await axios.post(
    process.env.OPENAI_MODERATION_REVERSE_PROXY || 'https://api.openai.com/v1/moderations',
    { input: text },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_MODERATION_API_KEY}`,
      },
      timeout: 10000,
    },
  );
  const results = response?.data?.results;
  if (
    !Array.isArray(results) ||
    !results.length ||
    results.some((result) => typeof result?.flagged !== 'boolean')
  ) {
    throw new Error('Invalid moderation response');
  }
  return results.some((result) => result.flagged);
}

module.exports = { isTextFlagged };
