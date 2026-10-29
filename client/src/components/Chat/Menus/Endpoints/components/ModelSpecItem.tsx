import React from 'react';
import { VisuallyHidden } from '@ariakit/react';
import { CheckCircle2, Pin, PinOff } from 'lucide-react';
import type { TModelSpec } from 'librechat-data-provider';
import { useFavorites, useLocalize, useIsActiveItem } from '~/hooks';
import { useModelSelectorContext } from '../ModelSelectorContext';
import { CustomMenuItem as MenuItem } from '../CustomMenu';
import SpecIcon from './SpecIcon';
import { cn } from '~/utils';
import { PinnedButton } from './PinedButton';
import ModelPriceLabel from '../ModelPriceLabel';

interface ModelSpecItemProps {
  spec: TModelSpec;
  isSelected: boolean;
}

export function ModelSpecItem({ spec, isSelected }: ModelSpecItemProps) {
  const localize = useLocalize();
  const { handleSelectSpec, endpointsConfig } = useModelSelectorContext();
  const { isFavoriteSpec, toggleFavoriteSpec } = useFavorites();
  const { showIconInMenu = true } = spec;

  const { ref: itemRef, isActive } = useIsActiveItem<HTMLDivElement>();

  const isFavorite = isFavoriteSpec(spec.name);

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFavoriteSpec(spec.name);
  };

  return (
    <MenuItem
      ref={itemRef}
      onClick={() => handleSelectSpec(spec)}
      aria-selected={isSelected || undefined}
      className="group flex w-full cursor-pointer items-center justify-between rounded-lg px-2 text-sm"
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 gap-2 px-1 py-1',
          spec.description ? 'items-start' : 'items-center',
        )}
      >
        {showIconInMenu && (
          <div className="flex-shrink-0">
            <SpecIcon currentSpec={spec} endpointsConfig={endpointsConfig} />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-left">{spec.label}</span>
          {spec.description && (
            <span className="break-words text-xs font-normal">{spec.description}</span>
          )}
        </div>
      </div>
      <ModelPriceLabel modelId={spec.preset.model} endpoint={spec.preset.endpoint} />
      {isSelected && (
        <>
          <CheckCircle2
            className="size-4 shrink-0 self-center text-text-primary"
            aria-hidden="true"
          />
          <VisuallyHidden>{localize('com_a11y_selected')}</VisuallyHidden>
        </>
      )}
      {!isSelected && <span className="size-4 shrink-0" aria-hidden="true" />}
      <PinnedButton onClick={handleFavoriteClick} isFavorite={isFavorite} />
    </MenuItem>
  );
}

export function renderModelSpecs(specs: TModelSpec[], selectedSpec: string) {
  if (!specs || specs.length === 0) {
    return null;
  }

  return specs.map((spec) => (
    <ModelSpecItem key={spec.name} spec={spec} isSelected={selectedSpec === spec.name} />
  ));
}
