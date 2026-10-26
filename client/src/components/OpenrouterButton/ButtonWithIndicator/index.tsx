import { TooltipAnchor } from '@librechat/client';
import { OpenrouterError } from '../types';

interface Props {
  handleClick: () => void;
  error: OpenrouterError;
}

export const ButtonWithIndicator = ({ handleClick, error }: Props) => {
  const hasError = !!error?.code;

  return (
    <TooltipAnchor
      description="Лимиты"
      role="button"
      tabIndex={0}
      aria-label="Статистика"
      onClick={handleClick}
      className={`my-1 flex h-9 w-full max-w-[70vw] items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-sm transition-colors ${
        hasError
          ? 'border border-red-500 bg-red-50 text-red-600 hover:bg-red-100'
          : 'border border-border-light bg-presentation text-text-primary hover:bg-surface-active-alt'
      } `}
    >
      <div>{error?.message || 'Лимиты'}</div>
    </TooltipAnchor>
  );
};
