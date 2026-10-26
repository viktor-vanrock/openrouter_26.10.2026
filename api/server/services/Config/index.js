const appConfig = require('./app');
const mcpToolsCache = require('./mcp');
const { config } = require('./EndpointService');
const getCachedTools = require('./getCachedTools');
const loadCustomConfig = require('./loadCustomConfig');
const loadConfigModels = require('./loadConfigModels');
const { loadConfigModelCapabilities } = loadConfigModels;
const loadDefaultModels = require('./loadDefaultModels');
const getEndpointsConfig = require('./getEndpointsConfig');
const loadAsyncEndpoints = require('./loadAsyncEndpoints');

module.exports = {
  config,
  loadCustomConfig,
  loadConfigModels,
  loadConfigModelCapabilities,
  loadDefaultModels,
  loadAsyncEndpoints,
  ...appConfig,
  ...getCachedTools,
  ...mcpToolsCache,
  ...getEndpointsConfig,
};
