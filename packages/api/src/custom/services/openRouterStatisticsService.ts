import axios from 'axios';
import type { OpenRouterKeyResponseData, OpenRouterKeyResponse } from 'librechat-data-provider';
import { AppError, logger } from '../utils';

export async function getOpenRouterBalanceSnapshot({
  apiKey,
  timeoutMs = 10000,
  baseUrl,
}: {
  apiKey: string;
  timeoutMs?: number;
  baseUrl: string;
}): Promise<OpenRouterKeyResponseData> {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new Error('OpenRouter gateway URL is required');
  }
  const response = await axios.get<OpenRouterKeyResponse>(`${baseUrl.replace(/\/$/, '')}/auth/key`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'identity',
    },
    timeout: Math.min(Math.max(timeoutMs, 1), 10000),
    decompress: true,
  });
  return response.data.data;
}

class OpenRouterBalanceService {
  private readonly baseUrl = process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1';

  async getBalance(apiKey: string): Promise<OpenRouterKeyResponseData> {
    const url = `${this.baseUrl}/auth/key`;

    try {
      const response = await axios.get<OpenRouterKeyResponse>(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_REFERER || 'https://orch.crbrcloud.ru/', // ← правильный Referer
          'X-Title': process.env.OPENROUTER_TITLE || 'LibreChat',
          'Accept-Encoding': 'identity',
        },
        timeout: 10000,
        decompress: true,
      });

      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.warn('[OpenRouter] Balance lookup failed', {
          meta: {
            status: error.response?.status,
            code: error.code,
            requestId: error.response?.headers?.['x-request-id'],
          },
        });
        if (error.code === 'ECONNABORTED') {
          throw new AppError('Таймаут запроса к OpenRouter API', 504, 'TIMEOUT');
        }

        switch (error.response?.status) {
          case 401:
            throw new AppError('Невалидный OpenRouter API ключ', 401, 'INVALID_API_KEY');
          case 402:
            throw new AppError('Недостаточно средств', 402, 'INSUFFICIENT_FUNDS');
          case 429:
            throw new AppError('Превышен лимит запросов', 429, 'RATE_LIMIT');
          default:
            throw new AppError(
              `Ошибка OpenRouter API: ${error.message}`,
              error.response?.status || 502,
              'API_ERROR'
            );
        }
      }

      throw new AppError('Неизвестная ошибка при запросе к OpenRouter', 500);
    }
  }
}

export default new OpenRouterBalanceService();
