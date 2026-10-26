import { ApiResponse, OpenRouterKeyResponseData } from 'librechat-data-provider/dist/types';
import { ApiError } from '~/components/OpenrouterButton/utils';

export async function fetchOpenrouterBalance(token: string) {
  const response = await fetch('/api/openrouter/balance', {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  const result: ApiResponse<OpenRouterKeyResponseData> = await response.json();
  if (!response.ok) {
    throw new ApiError(result.error || 'Ошибка API', response.status);
  } else {
    return result;
  }
}
