import React, { useMemo } from 'react';
import { TooltipAnchor } from '@librechat/client';
import { EModelEndpoint, EModelEndpointCustom, getConfigDefaults } from 'librechat-data-provider';
import type { ModelSelectorProps } from '~/common';
import {
  renderModelSpecs,
  renderEndpoints,
  renderSearchResults,
  renderCustomGroups,
} from './components';
import { useModelSelectorContext } from './ModelSelectorContext';
import { getSelectedIcon, getDisplayValue } from './utils';
import { CustomMenu as Menu } from './CustomMenu';
import DialogManager from './DialogManager';
import { useLocalize } from '~/hooks';
import { useCurrentKey } from '~/Providers';
import ModelPriceLabel from './ModelPriceLabel';

const defaultInterface = getConfigDefaults().interface;

function ModelSelectorContent() {
  const localize = useLocalize();

  const {
    // LibreChat
    agentsMap,
    modelSpecs,
    mappedEndpoints,
    endpointsConfig,
    // State
    searchValue,
    searchResults,
    selectedValues,
    // Functions
    setSearchValue,
    setSelectedValues,
    // Dialog
    keyDialogOpen,
    onOpenChange,
    keyDialogEndpoint,
  } = useModelSelectorContext();

  const { isOpenDealogSetKey } = useCurrentKey();
  const isKeyDialogOpen = keyDialogOpen || isOpenDealogSetKey;

  const selectedIcon = useMemo(
    () =>
      getSelectedIcon({
        mappedEndpoints: mappedEndpoints ?? [],
        selectedValues,
        modelSpecs,
        endpointsConfig,
      }),
    [mappedEndpoints, selectedValues, modelSpecs, endpointsConfig],
  );

  const selectedDisplayValue = useMemo(
    () =>
      getDisplayValue({
        localize,
        agentsMap,
        modelSpecs,
        selectedValues,
        mappedEndpoints,
      }),
    [localize, agentsMap, modelSpecs, selectedValues, mappedEndpoints],
  );

  const trigger = (
    <TooltipAnchor
      aria-label={localize('com_ui_select_model')}
      description={localize('com_ui_select_model')}
      render={
        <button
          className="my-1 flex h-9 w-full max-w-[70vw] items-center justify-center gap-2 rounded-xl border border-border-light bg-presentation px-3 py-2 text-sm text-text-primary hover:bg-surface-active-alt"
          aria-label={localize('com_ui_select_model')}
        >
          {/* {selectedIcon && React.isValidElement(selectedIcon) && (
            <div className="flex flex-shrink-0 items-center justify-center overflow-hidden">
              {selectedIcon}
            </div>
          )} */}
          <span className="min-w-0 flex-1 truncate text-left">{selectedDisplayValue}</span>
          <ModelPriceLabel
            modelId={
              selectedValues.modelSpec
                ? modelSpecs.find((spec) => spec.name === selectedValues.modelSpec)?.preset.model
                : selectedValues.model
            }
            endpoint={selectedValues.endpoint}
          />
        </button>
      }
    />
  );

  return (
    <div className="relative flex w-full max-w-md flex-col items-center gap-2">
      <Menu
        values={selectedValues}
        onValuesChange={(values: Record<string, any>) => {
          setSelectedValues({
            endpoint: values.endpoint || '',
            model: values.model || '',
            modelSpec: values.modelSpec || '',
          });
        }}
        onSearch={(value) => setSearchValue(value)}
        combobox={<input id="model-search" placeholder=" " />}
        comboboxLabel={localize('com_endpoint_search_models')}
        trigger={trigger}
      >
        <div className="w-full min-w-0 sm:min-w-[400px]" style={{ maxHeight: '420px' }}>
          {searchResults ? (
            renderSearchResults(searchResults, localize, searchValue)
          ) : (
            <>
              {/* Render ungrouped modelSpecs (no group field) */}
              {renderModelSpecs(
                modelSpecs?.filter((spec) => !spec.group) || [],
                selectedValues.modelSpec || '',
              )}
              {/* Render endpoints (will include grouped specs matching endpoint names) */}
              {renderEndpoints(mappedEndpoints ?? [])}
              {/* Render custom groups (specs with group field not matching any endpoint) */}
              {renderCustomGroups(modelSpecs || [], mappedEndpoints ?? [])}
            </>
          )}
        </div>
      </Menu>
      <DialogManager
        keyDialogOpen={isKeyDialogOpen}
        onOpenChange={onOpenChange}
        endpointsConfig={endpointsConfig || {}}
        keyDialogEndpoint={EModelEndpointCustom.openRouter}
      />
    </div>
  );
}

export default function ModelSelector({ startupConfig }: ModelSelectorProps) {
  const interfaceConfig = startupConfig?.interface ?? defaultInterface;
  const modelSpecs = startupConfig?.modelSpecs?.list ?? [];

  // Hide the selector when modelSelect is false and there are no model specs to show
  if (interfaceConfig.modelSelect === false && modelSpecs.length === 0) {
    return null;
  }

  return <ModelSelectorContent />;
}
