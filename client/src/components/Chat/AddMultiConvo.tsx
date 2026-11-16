import { PlusCircle } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import useMultiConvo from '~/hooks/Chat/useMultiConvo';
import { useLocalize } from '~/hooks';

interface Props {
  inNeedButton?: boolean;
}

function AddMultiConvo({ inNeedButton = true }: Props) {
  const localize = useLocalize();
  const { show, addConversation } = useMultiConvo();

  if (!show) {
    return null;
  }

  if (!inNeedButton) {
    return (
      <div
        style={{ width: '100%', height: '50px', display: 'flex', alignItems: 'center' }}
        onClick={addConversation}
      >
        Работать с несколькими моделями
      </div>
    );
  }

  return (
    <TooltipAnchor
      description={localize('com_ui_add_multi_conversation')}
      role="button"
      tabIndex={0}
      aria-label={localize('com_ui_add_multi_conversation')}
      onClick={addConversation}
      data-testid="add-multi-convo-button"
      className="inline-flex size-9 flex-shrink-0 items-center justify-center rounded-xl border border-border-light bg-presentation text-text-primary transition-all ease-in-out hover:bg-surface-tertiary disabled:pointer-events-none disabled:opacity-50 radix-state-open:bg-surface-tertiary"
    >
      <PlusCircle className="icon-sm" aria-hidden="true" />
    </TooltipAnchor>
  );
}

export default AddMultiConvo;
