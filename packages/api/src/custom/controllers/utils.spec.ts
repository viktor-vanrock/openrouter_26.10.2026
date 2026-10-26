const CANARY = 'sk-or-canary-never-log';

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
  logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

import { resolveOpenRouterCredential } from './utils';
import { logger } from '../utils';

describe('resolveOpenRouterCredential', () => {
  const getUserKeyValues = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    getUserKeyValues.mockResolvedValue({ apiKey: CANARY });
  });

  it('does not log encrypted records or decrypted key fragments', async () => {
    await expect(
      resolveOpenRouterCredential({ getUserKeyValues } as never, 'user-1'),
    ).resolves.toBe(CANARY);

    const logs = JSON.stringify(
      [logger.debug, logger.error, logger.warn].flatMap(
        (method) => (method as jest.Mock).mock.calls,
      ),
    );
    expect(logs).not.toContain(CANARY);
  });
});
