import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import { getSavedImageModel, saveImageModel, useImageModels } from '~/hooks/useImageModels';
import { formatModelPrice } from '~/components/Chat/Menus/Endpoints/modelPricing';
import { useAuthContext, useLocalize } from '~/hooks';

export default function ImageSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
}) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { user } = useAuthContext();
  const { data, isLoading, isError } = useImageModels(user?.id);
  const [saved, setSaved] = useState(() => getSavedImageModel(user?.id));
  const selected = data?.models.some((model) => model.id === saved)
    ? saved
    : (data?.defaultModel ?? undefined);

  const formatPrice = (model: NonNullable<typeof data>['models'][number]) => {
    const parts: string[] = [];
    if (model.imagePrice != null) {
      parts.push(
        `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 }).format(model.imagePrice)} ${localize('com_image_price_per_image')}`,
      );
    }
    if (model.imageOutputPerMillion != null) {
      parts.push(
        `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(model.imageOutputPerMillion)} ${localize('com_image_price_per_million')}`,
      );
    }
    parts.push(formatModelPrice(model));
    return parts.filter(Boolean).join(' · ') || localize('com_image_price_unavailable');
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="min-h-[min(380px,85vh)] w-11/12 max-w-4xl grid-rows-[auto_1fr] bg-background text-text-primary sm:p-8">
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_nav_settings')}</OGDialogTitle>
        </OGDialogHeader>
        <div className="mt-5 space-y-3">
          <p className="text-sm font-medium">{localize('com_image_current_model')}:</p>
          {isLoading && (
            <p className="text-sm text-text-secondary">{localize('com_image_models_loading')}</p>
          )}
          {!isLoading && isError && (
            <p className="text-sm text-text-secondary">{localize('com_image_models_error')}</p>
          )}
          {!isLoading && !isError && !data?.models.length && (
            <p className="text-sm text-text-secondary">{localize('com_image_models_empty')}</p>
          )}
          {!isLoading && !isError && !!data?.models.length && (
            <select
              aria-label={localize('com_image_current_model')}
              value={selected ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                if (user?.id) saveImageModel(user.id, value);
                setSaved(value);
                void queryClient.invalidateQueries(['openrouter', 'image-models', user?.id]);
              }}
              className="h-12 w-full rounded-lg border border-border-light bg-white px-4 text-sm text-text-primary shadow-sm focus:outline-none focus:ring-2 focus:ring-ring dark:bg-[#202123]"
            >
              {data.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} — {formatPrice(model)}
                </option>
              ))}
            </select>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
