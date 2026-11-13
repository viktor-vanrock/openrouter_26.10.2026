const { logger } = require('@librechat/data-schemas');
const { loadAgent: loadAgentFn } = require('@librechat/api');
const { isAgentsEndpoint, removeNullishValues, Constants } = require('librechat-data-provider');
const { getMCPServerTools } = require('~/server/services/Config');
const db = require('~/models');
const { getOpenRouterImageConfig, isDirectImageRequest } = require('./openrouterImageConfig');

const loadAgent = (params) => loadAgentFn(params, { getAgent: db.getAgent, getMCPServerTools });

const buildOptions = (req, endpoint, parsedBody, endpointType) => {
  const { spec, iconURL, agent_id, ...parsedParameters } = parsedBody;
  const directImage = isDirectImageRequest(req);
  const model_parameters = directImage
    ? { model: getOpenRouterImageConfig().model }
    : parsedParameters;
  if (directImage) {
    req.imageGenerationConversationParameters = { ...parsedParameters };
    req.imageGenerationConversationSpec = spec;
    req.body.ephemeralAgent = {};
    delete req.body.promptPrefix;
    delete req.body.manualSkills;
    delete req.body.files;
    delete req.body.addedConvo;
  }
  const agentPromise = loadAgent({
    req,
    spec: directImage ? undefined : spec,
    agent_id: isAgentsEndpoint(endpoint) ? agent_id : Constants.EPHEMERAL_AGENT_ID,
    endpoint,
    model_parameters,
  }).catch((error) => {
    logger.error(`[/agents/:${agent_id}] Error retrieving agent during build options step`, error);
    return undefined;
  });

  /** @type {import('librechat-data-provider').TConversation | undefined} */
  const addedConvo = req.body?.addedConvo;

  return removeNullishValues({
    spec: directImage ? undefined : spec,
    iconURL,
    endpoint,
    agent_id,
    endpointType,
    model_parameters,
    agent: agentPromise,
    addedConvo,
  });
};

module.exports = { buildOptions };
