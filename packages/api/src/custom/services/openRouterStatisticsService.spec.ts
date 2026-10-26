const CANARY = 'sk-or-canary-never-log';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    isAxiosError: jest.fn((error) => error.isAxiosError === true),
  },
}));

jest.mock('../utils', () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    code?: string;

    constructor(message: string, statusCode = 500, code?: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  },
  logger: { warn: jest.fn() },
}));

import service, { getOpenRouterBalanceSnapshot } from './openRouterStatisticsService';
import axios from 'axios';
import { logger } from '../utils';

const makeAxiosError = (params: { status: number; headers: Record<string, string> }) => ({
  isAxiosError: true,
  message: 'upstream unavailable',
  response: { status: params.status, data: { error: 'upstream unavailable' } },
  config: { url: 'https://upstream.example/auth/key', headers: params.headers },
});

describe('OpenRouterBalanceService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redacts Authorization when balance upstream fails', async () => {
    jest.mocked(axios.get).mockRejectedValue(
      makeAxiosError({
        status: 502,
        headers: { Authorization: `Bearer ${CANARY}` },
      }),
    );

    await expect(service.getBalance(CANARY)).rejects.toMatchObject({ code: 'API_ERROR' });

    const logs = JSON.stringify((logger.warn as jest.Mock).mock.calls);
    expect(logs).not.toContain(CANARY);
    expect(logs).not.toContain('Authorization');
  });

  it('supports an injected fixed gateway and bounded timeout for internal balance lookups', async () => {
    jest.mocked(axios.get).mockResolvedValue({
      data: { data: { limit_remaining: 2.5 } },
    } as never);

    await expect(
      getOpenRouterBalanceSnapshot({
        apiKey: CANARY,
        timeoutMs: 20000,
        baseUrl: 'https://gateway.internal/v1/',
      }),
    ).resolves.toMatchObject({ limit_remaining: 2.5 });
    expect(axios.get).toHaveBeenCalledWith(
      'https://gateway.internal/v1/auth/key',
      expect.objectContaining({ timeout: 10000 }),
    );
  });

  it('requires the internal caller to provide a fixed gateway URL', async () => {
    await expect(
      getOpenRouterBalanceSnapshot({ apiKey: CANARY, baseUrl: '' }),
    ).rejects.toThrow('gateway');
    expect(axios.get).not.toHaveBeenCalled();
  });
});
