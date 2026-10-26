import { EModelEndpoint, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type {
  TPreset,
  TConversation,
  TEndpointsConfig,
  TModelsConfig,
} from 'librechat-data-provider';
import { getLocalStorageItems } from './localStorage';
import { getFallbackModel, mapEndpoints } from './endpoints';

type TConvoSetup = Partial<TPreset> | Partial<TConversation>;

type TDefaultEndpoint = {
  convoSetup: TConvoSetup;
  endpointsConfig: TEndpointsConfig;
  modelsConfig?: TModelsConfig;
};

const getEndpointFromSetup = (
  convoSetup: TConvoSetup | null,
  endpointsConfig: TEndpointsConfig,
): EModelEndpoint | null => {
  let { endpoint: targetEndpoint = '' } = convoSetup || {};
  targetEndpoint = targetEndpoint ?? '';
  if (targetEndpoint && endpointsConfig?.[targetEndpoint]) {
    return targetEndpoint as EModelEndpoint;
  } else if (targetEndpoint) {
    console.warn(`Illegal target endpoint ${targetEndpoint}`, endpointsConfig);
  }
  return null;
};

const getEndpointFromLocalStorage = (
  endpointsConfig: TEndpointsConfig,
  modelsConfig?: TModelsConfig,
) => {
  try {
    const { lastConversationSetup, lastSelectedModel } = getLocalStorageItems();
    const { endpoint } = lastConversationSetup ?? { endpoint: null };
    const isDefaultConfig = Object.values(endpointsConfig ?? {}).every((value) => !value);

    if (
      modelsConfig &&
      endpoint &&
      !lastConversationSetup?.model &&
      !lastConversationSetup?.agent_id &&
      !lastConversationSetup?.assistant_id &&
      !lastSelectedModel?.[endpoint]
    ) {
      return null;
    }

    if (isDefaultConfig && endpoint) {
      return endpoint;
    }

    return endpoint && endpointsConfig?.[endpoint] != null ? endpoint : null;
  } catch (error) {
    console.error(error);
    return null;
  }
};

const getDefinedEndpoint = (endpointsConfig: TEndpointsConfig, modelsConfig?: TModelsConfig) => {
  const endpoints = mapEndpoints(endpointsConfig);
  if (modelsConfig) {
    const gpt4oEndpoint = endpoints.find(
      (endpoint) =>
        !isAgentsEndpoint(endpoint) &&
        !isAssistantsEndpoint(endpoint) &&
        getFallbackModel(modelsConfig[endpoint] ?? []),
    );
    if (gpt4oEndpoint) {
      return gpt4oEndpoint;
    }
    if (endpoints.includes(EModelEndpoint.agents)) {
      return EModelEndpoint.agents;
    }
  }
  return endpoints.find((e) => Object.hasOwn(endpointsConfig ?? {}, e));
};

const getDefaultEndpoint = ({
  convoSetup,
  endpointsConfig,
  modelsConfig,
}: TDefaultEndpoint): EModelEndpoint | undefined => {
  return (
    getEndpointFromSetup(convoSetup, endpointsConfig) ||
    getEndpointFromLocalStorage(endpointsConfig, modelsConfig) ||
    getDefinedEndpoint(endpointsConfig, modelsConfig)
  );
};

export default getDefaultEndpoint;
