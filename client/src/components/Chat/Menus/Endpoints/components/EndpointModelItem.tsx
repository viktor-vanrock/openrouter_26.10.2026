import React from 'react';
import { VisuallyHidden } from '@ariakit/react';
import { CheckCircle2, EarthIcon, Pin, PinOff } from 'lucide-react';
import { isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type { Endpoint } from '~/common';
import { useFavorites, useLocalize, useIsActiveItem } from '~/hooks';
import { useModelSelectorContext } from '../ModelSelectorContext';
import { CustomMenuItem as MenuItem } from '../CustomMenu';
import { cn } from '~/utils';
import { PinnedButton } from './PinedButton';
import { FixedSizeList as List } from 'react-window';

interface EndpointModelItemProps {
  modelId: string | null;
  endpoint: Endpoint;
}

export function EndpointModelItem({ modelId, endpoint }: EndpointModelItemProps) {
  const localize = useLocalize();
  const { handleSelectModel, selectedValues } = useModelSelectorContext();
  const {
    endpoint: selectedEndpoint,
    model: selectedModel,
    modelSpec: selectedSpec,
  } = selectedValues;
  const isSelected =
    !selectedSpec && selectedEndpoint === endpoint.value && selectedModel === modelId;
  const { isFavoriteModel, toggleFavoriteModel, isFavoriteAgent, toggleFavoriteAgent } =
    useFavorites();

  const { ref: itemRef } = useIsActiveItem<HTMLDivElement>();

  let isGlobal = false;
  let modelName = modelId;
  const avatarUrl = endpoint?.modelIcons?.[modelId ?? ''] || null;

  if (endpoint && modelId && isAgentsEndpoint(endpoint.value) && endpoint.agentNames?.[modelId]) {
    modelName = endpoint.agentNames[modelId];

    const modelInfo = endpoint?.models?.find((m) => m.name === modelId);
    isGlobal = modelInfo?.isGlobal ?? false;
  } else if (
    endpoint &&
    modelId &&
    isAssistantsEndpoint(endpoint.value) &&
    endpoint.assistantNames?.[modelId]
  ) {
    modelName = endpoint.assistantNames[modelId];
  }

  const isAgent = isAgentsEndpoint(endpoint.value);
  const isFavorite = isAgent
    ? isFavoriteAgent(modelId ?? '')
    : isFavoriteModel(modelId ?? '', endpoint.value);

  const handleFavoriteToggle = () => {
    if (!modelId) {
      return;
    }

    if (isAgent) {
      toggleFavoriteAgent(modelId);
    } else {
      toggleFavoriteModel({ model: modelId, endpoint: endpoint.value });
    }
  };

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleFavoriteToggle();
  };

  const renderAvatar = () => {
    const isAgentOrAssistant =
      isAgentsEndpoint(endpoint.value) || isAssistantsEndpoint(endpoint.value);
    const showEndpointIcon = isAgentOrAssistant && endpoint.icon;

    const getContent = () => {
      if (avatarUrl) {
        return <img src={avatarUrl} alt={modelName ?? ''} className="h-full w-full object-cover" />;
      }
      if (showEndpointIcon) {
        return endpoint.icon;
      }
      return null;
    };

    const content = getContent();
    if (!content) {
      return null;
    }

    return (
      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
        {content}
      </div>
    );
  };

  return (
    <MenuItem
      ref={itemRef}
      onClick={() => handleSelectModel(endpoint, modelId ?? '')}
      aria-selected={isSelected || undefined}
      className="group flex w-[98%] w-full cursor-pointer items-center justify-between rounded-lg pl-[12px] text-sm"
    >
      <div className="flex w-full min-w-0 items-center gap-2 py-1">
        {renderAvatar()}
        <span className="truncate">{modelName}</span>
        {isGlobal && <EarthIcon className="ml-1 size-4 text-surface-submit" />}
      </div>
      <PinnedButton isFavorite={isFavorite} onClick={handleFavoriteClick} />
      {isSelected && (
        <>
          <CheckCircle2 className="mr-1 size-5 shrink-0 text-text-primary" aria-hidden="true" />
          <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
        </>
      )}
    </MenuItem>
  );
}

const Row = ({ data, index, style }: any) => {
  const { items, indexSuffix } = data;
  const item = items[index];

  return (
    <div style={style}>
      <EndpointModelItem
        key={`${item.endpoint.value}${indexSuffix}-${item.modelId}-${index}`}
        modelId={item.modelId}
        endpoint={item.endpoint}
      />
    </div>
  );
};

export function renderEndpointModels(
  endpoint: Endpoint | null,
  models: Array<{ name: string; isGlobal?: boolean }>,
  filteredModels?: string[],
  endpointIndex?: number,
) {
  const modelsToRender = filteredModels || models.map((model) => model.name);
  const indexSuffix = endpointIndex != null ? `-${endpointIndex}` : '';

  if (!endpoint) return null;

  const items = modelsToRender.map((modelId) => ({
    modelId,
    endpoint,
  }));

  return (
    <List
      height={420}
      width={390}
      itemCount={items.length}
      itemSize={40}
      itemData={{
        items,
        indexSuffix,
      }}
    >
      {Row}
    </List>
  );
}
