import { memo } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import { WandSparkles } from 'lucide-react';
import { cn } from '~/utils';
import store from '~/store';
import usePrototypeAvailability from '~/hooks/Prototype/usePrototypeAvailability';

function PrototypeModeBadge({
  conversationId,
  disabled,
}: {
  conversationId?: string | null;
  disabled?: boolean;
}) {
  const available = usePrototypeAvailability();
  const [active, setActive] = useRecoilState(
    store.prototypeModeByConvoId(conversationId ?? Constants.NEW_CONVO),
  );
  const pinned = useRecoilValue(store.prototypeModePinned);
  if (!available || (!active && !pinned)) return null;
  return (
    <button
      type="button"
      aria-label="Prototype mode"
      aria-pressed={active}
      disabled={disabled}
      onClick={() => setActive((value) => !value)}
      className={cn(
        'flex h-9 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors',
        active
          ? 'border-violet-500 bg-violet-500/15 text-violet-700 dark:text-violet-300'
          : 'border-border-light text-text-secondary hover:bg-surface-hover',
      )}
    >
      <WandSparkles className="size-4" aria-hidden="true" />
      Прототип
    </button>
  );
}
export default memo(PrototypeModeBadge);
