import axios from 'axios';
import { useQuery } from '@tanstack/react-query';
import { hasDevelopingCookie } from '~/utils/developingCookie';

export type ModelPrice = {
  promptPerMillion?: number;
  completionPerMillion?: number;
  requestPrice?: number;
};

type PricingResponse = {
  items: Array<ModelPrice & { id: string }>;
};

export function useModelPrices() {
  return useQuery({
    queryKey: ['openrouter', 'model-prices'],
    enabled: hasDevelopingCookie(),
    queryFn: async () => {
      const response = await axios.get<PricingResponse>('/api/openrouter/pricing');
      return Object.fromEntries(
        response.data.items.map(({ id, ...price }) => [id, price]),
      ) as Record<string, ModelPrice>;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
}

const money = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatModelPrice(price: ModelPrice): string {
  const tokenParts: string[] = [];
  if (price.promptPerMillion !== undefined)
    tokenParts.push(`вх ${money.format(price.promptPerMillion)}`);
  if (price.completionPerMillion !== undefined)
    tokenParts.push(`вых ${money.format(price.completionPerMillion)}`);
  const tokenPrice = tokenParts.length ? `${tokenParts.join(' · ')} $` : '';
  const requestPrice =
    price.requestPrice !== undefined ? `$${money.format(price.requestPrice)}/запрос` : '';
  return [tokenPrice, requestPrice].filter(Boolean).join(' + ');
}
