const {
  createLoadConfigModels,
  createLoadConfigModelCapabilities,
  fetchModels,
  fetchModelInfo,
} = require('@librechat/api');
const { getAppConfig } = require('./app');
const db = require('~/models');

const loadConfigModels = createLoadConfigModels({
  getAppConfig,
  getUserKeyValues: db.getUserKeyValues,
  fetchModels,
});

const loadConfigModelCapabilities = createLoadConfigModelCapabilities({
  getAppConfig,
  getUserKeyValues: db.getUserKeyValues,
  fetchModels,
  fetchModelInfo,
});

module.exports = loadConfigModels;
module.exports.loadConfigModelCapabilities = loadConfigModelCapabilities;
