import { ImagePlus } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';

export default function ImageGenerateButton({
  eligible,
  text,
  disabled,
  model,
  description,
  onGenerate,
}: {
  eligible: boolean;
  text?: string;
  disabled: boolean;
  model: string;
  description: string;
  onGenerate: () => void;
}) {
  if (!eligible) return null;
  return (
    <TooltipAnchor
      description={`Сгенерировать изображение — ${model} — ${description}`}
      render={
        <button
          type="button"
          aria-label="Сгенерировать изображение"
          disabled={disabled || !text?.trim()}
          onClick={onGenerate}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-border-light px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ImagePlus className="size-4" aria-hidden="true" />
          Сгенерировать изображение
        </button>
      }
    />
  );
}
