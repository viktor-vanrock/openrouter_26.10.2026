const mongoose = require('mongoose');
const {
  logger,
  ensurePrototypeIndexes,
  ensureGuidePageIndexes,
} = require('@librechat/data-schemas');
const {
  logAgentMigrationWarning,
  logPromptMigrationWarning,
  checkAgentPermissionsMigration,
  checkPromptPermissionsMigration,
} = require('@librechat/api');
const { findRoleByIdentifier } = require('~/models');

/**
 * Check if permissions migrations are needed for shared resources
 * This runs at the end to ensure all systems are initialized
 */
async function checkMigrations() {
  await ensurePrototypeIndexes(mongoose.connection);
  await ensureGuidePageIndexes(mongoose.connection);
  // Keep startup compatible with a workspace whose data-schemas package has not yet
  // been rebuilt: server code resolves that package from its generated dist files.
  await mongoose.connection.db
    .collection('guidemedias')
    .createIndex({ createdAt: -1 }, { name: 'guide_media_created_at_desc' });
  await mongoose.connection.db
    .collection('guidemedias')
    .createIndex({ key: 1 }, { name: 'key_1', unique: true });
  try {
    const agentMigrationResult = await checkAgentPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      AgentModel: mongoose.models.Agent,
    });
    logAgentMigrationWarning(agentMigrationResult);
  } catch (error) {
    logger.error('Failed to check agent permissions migration:', error);
  }
  try {
    const promptMigrationResult = await checkPromptPermissionsMigration({
      mongoose,
      methods: {
        findRoleByIdentifier,
      },
      PromptGroupModel: mongoose.models.PromptGroup,
    });
    logPromptMigrationWarning(promptMigrationResult);
  } catch (error) {
    logger.error('Failed to check prompt permissions migration:', error);
  }
}

module.exports = {
  checkMigrations,
};
