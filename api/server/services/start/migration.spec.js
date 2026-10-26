const mockEnsurePrototypeIndexes = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
  ensurePrototypeIndexes: (...args) => mockEnsurePrototypeIndexes(...args),
}));
jest.mock('@librechat/api', () => ({
  logAgentMigrationWarning: jest.fn(),
  logPromptMigrationWarning: jest.fn(),
  checkAgentPermissionsMigration: jest.fn().mockResolvedValue({}),
  checkPromptPermissionsMigration: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/models', () => ({ findRoleByIdentifier: jest.fn() }));

const mongoose = require('mongoose');
const { checkMigrations } = require('./migration');

describe('startup migrations', () => {
  it('runs the targeted prototype index migration through the startup seam', async () => {
    mockEnsurePrototypeIndexes.mockResolvedValue({ created: true, droppedLegacy: true });

    await checkMigrations();

    expect(mockEnsurePrototypeIndexes).toHaveBeenCalledWith(mongoose.connection);
  });

  it('fails startup when the required prototype index cannot be established', async () => {
    mockEnsurePrototypeIndexes.mockRejectedValue(new Error('prototype index migration failed'));

    await expect(checkMigrations()).rejects.toThrow('prototype index migration failed');
  });
});
