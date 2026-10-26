const { logger } = require('@librechat/data-schemas');
const {
  loadDefaultModels,
  loadConfigModels,
  loadConfigModelCapabilities,
} = require('~/server/services/Config');

const getModelsConfig = (req) => loadModels(req);

async function loadModels(req) {
  const defaultModelsConfig = await loadDefaultModels(req);
  const customModelsConfig = await loadConfigModels(req);
  return { ...defaultModelsConfig, ...customModelsConfig };
}

async function modelController(req, res) {
  try {
    const modelConfig = await loadModels(req);
    res.send(modelConfig);
  } catch (error) {
    logger.error('Error fetching models:', error);
    res.status(500).send({ error: error.message });
  }
}

async function modelCapabilitiesController(req, res) {
  try {
    res.send(await loadConfigModelCapabilities(req));
  } catch (error) {
    logger.error('Error fetching model capabilities:', error);
    res.status(500).send({ error: error.message });
  }
}

module.exports = { modelController, modelCapabilitiesController, loadModels, getModelsConfig };
