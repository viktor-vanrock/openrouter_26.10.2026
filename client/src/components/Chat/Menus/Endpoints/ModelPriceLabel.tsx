import { useModelSelectorContext } from './ModelSelectorContext';
import { formatModelPrice } from './modelPricing';
import { hasDevelopingCookie } from '~/utils/developingCookie';

export default function ModelPriceLabel({
  modelId,
  endpoint,
}: {
  modelId?: string | null;
  endpoint?: string | null;
}) {
  const { modelPrices } = useModelSelectorContext();
  if (!hasDevelopingCookie() || endpoint !== 'OpenRouter' || !modelId) return null;
  const price = modelPrices?.[modelId];
  if (!price) return null;

  return (
    <span
      className="ml-auto shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-text-secondary"
      title="Стоимость: вход и выход за 1 млн токенов, запрос за одно обращение. Доллары США."
    >
      {formatModelPrice(price)}
    </span>
  );
}
