import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { Pin, PinOff } from 'lucide-react';

interface Props {
  isFavorite: boolean;
  onClick: (e: React.MouseEvent) => void;
}

export const PinnedButton = ({ isFavorite, onClick }: Props) => {
  const localize = useLocalize();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isFavorite ? localize('com_ui_unpin') : localize('com_ui_pin')}
      className={cn(
        'rounded-md p-1 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring-primary',
        isFavorite
          ? 'visible'
          : 'invisible group-focus-within:visible group-hover:visible group-data-[active-item]:visible',
      )}
    >
      {isFavorite ? (
        <PinOff className="h-4 w-4 text-text-secondary" aria-hidden="true" />
      ) : (
        <Pin className="h-4 w-4 text-text-secondary" aria-hidden="true" />
      )}
    </button>
  );
};
