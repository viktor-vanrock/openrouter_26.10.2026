const { getReferencedQuotes, mergeQuotedText } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const denyRequest = require('./denyRequest');
const { isTextFlagged } = require('../services/TextModeration');

async function moderateText(req, res, next) {
  try {
    const { text } = req.body;
    const safeText = typeof text === 'string' ? text : '';
    const inputs = [];
    if (safeText.length > 0) {
      inputs.push(safeText);
    }
    const quotes = getReferencedQuotes(req.body.quotes);
    if (quotes != null) {
      inputs.push(...quotes);
      inputs.push(mergeQuotedText(safeText, quotes));
    }
    const input = inputs.length > 1 ? inputs : (inputs[0] ?? text);

    if (await isTextFlagged(input)) {
      const type = ErrorTypes.MODERATION;
      const errorMessage = { type };
      return await denyRequest(req, res, errorMessage);
    }
  } catch (error) {
    // Provider errors may contain the input and Authorization in axios.config.
    logger.error('Error in moderateText', { code: error?.code, status: error?.response?.status });
    const errorMessage = 'error in moderation check';
    return await denyRequest(req, res, errorMessage);
  }
  next();
}

module.exports = moderateText;
