import type { Connection } from 'mongoose';

export const GUIDE_MEDIA_COLLECTION = 'guidemedias';

/** Creates the media ordering index when Mongoose auto-indexing is disabled. */
export async function ensureGuideMediaIndexes(connection: Connection): Promise<void> {
  const collection = connection.db!.collection(GUIDE_MEDIA_COLLECTION);
  const exists = await connection.db!.listCollections({ name: GUIDE_MEDIA_COLLECTION }).hasNext();
  const indexes = exists ? await collection.listIndexes().toArray() : [];
  if (!indexes.some((index) => Object.keys(index.key).length === 1 && index.key.createdAt === -1)) {
    await collection.createIndex({ createdAt: -1 });
  }
  await collection.createIndex({ key: 1 }, { name: 'key_1', unique: true });
}
