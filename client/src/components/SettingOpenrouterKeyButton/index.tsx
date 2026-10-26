import { TooltipAnchor } from '@librechat/client';
import { SettingsIcon } from 'lucide-react';
import { useModelSelectorContext } from '../Chat/Menus/Endpoints/ModelSelectorContext';

interface Props {
  isNeedButton?: boolean;
}

export const SettingOpenrouterKeyButton = ({ isNeedButton = true }: Props) => {
  const { setKeyDialogOpen } = useModelSelectorContext();

  const handleClick = () => setKeyDialogOpen(true);

  if (!isNeedButton) {
    return (
      <div
        style={{ width: '100%', height: '50px', display: 'flex', alignItems: 'center' }}
        onClick={() => handleClick()}
      >
        Настройка openrouter ключа
      </div>
    );
  }
  return (
    <TooltipAnchor
      description={'Изменить openRouter ключ'}
      role="button"
      tabIndex={0}
      aria-label="Статистика"
      onClick={handleClick}
      className={`my-1 flex h-9 w-9 max-w-[70vw] items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-border-light bg-presentation px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-active-alt`}
    >
      <button type="button">
        <SettingsIcon className="size-5 shrink-0" aria-hidden="true" />
      </button>
    </TooltipAnchor>
  );
};
