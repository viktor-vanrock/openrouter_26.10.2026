import type { Connection } from 'mongoose';
import logger from '~/config/winston';

const COLLECTION_NAME = 'prototypejobs';
const LEGACY_INDEX_NAME = 'originToolCallId_1';
const LEGACY_INDEX_KEY = { originToolCallId: 1 } as const;
const SCOPED_INDEX_NAME = 'tenantId_1_userId_1_originToolCallId_1';
const SCOPED_INDEX_KEY = { tenantId: 1, userId: 1, originToolCallId: 1 } as const;
const ACTIVE_CONVERSATION_INDEX_NAME = 'tenantId_1_conversationId_1';
const CONVERSATION_INDEX_NAME = 'prototype_conversation_lifetime_unique';
const CONVERSATION_INDEX_KEY = { tenantId: 1, conversationId: 1 } as const;

type ListedIndex = {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  partialFilterExpression?: unknown;
  collation?: unknown;
  expireAfterSeconds?: unknown;
};

function hasExactKey(index: ListedIndex, expected: Record<string, number>): boolean {
  if (index.key == null) {
    return false;
  }
  const actualEntries = Object.entries(index.key);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(
      ([field, direction], position) =>
        field === expectedEntries[position][0] && direction === expectedEntries[position][1],
    )
  );
}

function isExactLegacyIndex(index: ListedIndex): boolean {
  return (
    index.name === LEGACY_INDEX_NAME &&
    hasExactKey(index, LEGACY_INDEX_KEY) &&
    index.unique === true &&
    index.sparse == null &&
    index.partialFilterExpression == null &&
    index.collation == null &&
    index.expireAfterSeconds == null
  );
}

function isExactActiveConversationIndex(index: ListedIndex): boolean {
  return (
    index.name === ACTIVE_CONVERSATION_INDEX_NAME &&
    hasExactKey(index, CONVERSATION_INDEX_KEY) &&
    index.unique === true &&
    index.partialFilterExpression != null
  );
}

export interface PrototypeIndexMigrationResult {
  created: boolean;
  droppedLegacy: boolean;
  createdConversationIndex: boolean;
  droppedActiveConversationIndex: boolean;
}

/**
 * Ensures prototype origin idempotency is scoped to its tenant/user owner.
 *
 * The replacement index is created before removing the legacy constraint. The
 * legacy index is removed only when its generated name, key, uniqueness, and
 * relevant modifiers exactly match the former schema contract.
 */
export async function ensurePrototypeIndexes(
  connection: Connection,
): Promise<PrototypeIndexMigrationResult> {
  const collection = connection.db!.collection(COLLECTION_NAME);
  const before = (await collection.indexes().catch((error: { codeName?: string }) => {
    if (error.codeName === 'NamespaceNotFound') {
      return [];
    }
    throw error;
  })) as ListedIndex[];
  const scopedAlreadyExists = before.some(
    (index) => hasExactKey(index, SCOPED_INDEX_KEY) && index.unique === true,
  );
  const conversationAlreadyExists = before.some(
    (index) =>
      index.name === CONVERSATION_INDEX_NAME &&
      hasExactKey(index, CONVERSATION_INDEX_KEY) &&
      index.unique === true &&
      index.partialFilterExpression == null,
  );

  await collection.createIndex(SCOPED_INDEX_KEY, {
    name: SCOPED_INDEX_NAME,
    unique: true,
  });
  await collection.createIndex(CONVERSATION_INDEX_KEY, {
    name: CONVERSATION_INDEX_NAME,
    unique: true,
  });
  await collection.createIndex(
    { cleanupStatus: 1, cleanupNextAttemptAt: 1, updatedAt: 1 },
    { name: 'prototype_cleanup_retry' },
  );

  const legacy = before.find(isExactLegacyIndex);
  if (legacy?.name != null) {
    await collection.dropIndex(legacy.name);
    logger.info(
      `[PrototypeMigration] Dropped exact legacy index: ${COLLECTION_NAME}.${legacy.name}`,
    );
  }

  const activeConversationIndex = before.find(isExactActiveConversationIndex);
  if (activeConversationIndex?.name != null) {
    await collection.dropIndex(activeConversationIndex.name);
    logger.info(
      `[PrototypeMigration] Dropped active-only conversation index: ${COLLECTION_NAME}.${activeConversationIndex.name}`,
    );
  }

  return {
    created: !scopedAlreadyExists,
    droppedLegacy: legacy != null,
    createdConversationIndex: !conversationAlreadyExists,
    droppedActiveConversationIndex: activeConversationIndex != null,
  };
}

export {
  COLLECTION_NAME as PROTOTYPE_JOB_COLLECTION,
  LEGACY_INDEX_KEY as PROTOTYPE_LEGACY_ORIGIN_INDEX_KEY,
  SCOPED_INDEX_KEY as PROTOTYPE_SCOPED_ORIGIN_INDEX_KEY,
};
