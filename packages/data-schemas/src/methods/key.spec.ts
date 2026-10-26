import { ErrorTypes } from 'librechat-data-provider';
import { decrypt } from '~/crypto';
import logger from '~/config/winston';
import { createKeyMethods } from './key';

jest.mock('~/crypto', () => ({
  encrypt: jest.fn(),
  decrypt: jest.fn(),
}));

jest.mock('~/config/winston', () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
  },
}));

describe('key methods', () => {
  it('does not log malformed decrypted credential contents through getUserKeyValues', async () => {
    const canary = 'sk-or-malformed-canary-never-log';
    const lean = jest.fn().mockResolvedValue({ value: 'encrypted-value' });
    const findOne = jest.fn().mockReturnValue({ lean });
    const mongoose = {
      models: { Key: { findOne } },
    } as unknown as typeof import('mongoose');
    jest.mocked(decrypt).mockResolvedValue(`${canary}{`);

    await expect(
      createKeyMethods(mongoose).getUserKeyValues({ userId: 'user-1', name: 'OpenRouter' }),
    ).rejects.toThrow(JSON.stringify({ type: ErrorTypes.INVALID_USER_KEY }));

    expect(JSON.stringify(jest.mocked(logger.error).mock.calls)).not.toContain(canary);
    expect(logger.error).toHaveBeenCalledWith('[getUserKeyValues]', {
      errorClass: 'SyntaxError',
      code: undefined,
    });
  });
});
