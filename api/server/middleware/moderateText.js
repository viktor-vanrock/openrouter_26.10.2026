const { logger } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const denyRequest = require('./denyRequest');
const { isTextFlagged } = require('../services/TextModeration');

async function moderateText(req, res, next) {
  try {
    const { text } = req.body;
    if (await isTextFlagged(text)) {
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
