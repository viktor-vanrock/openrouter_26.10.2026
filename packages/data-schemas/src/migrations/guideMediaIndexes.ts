import type { Connection } from 'mongoose';

export const GUIDE_MEDIA_COLLECTION = 'guidemedias';

/** Creates the media ordering index when Mongoose auto-indexing is disabled. */
export async function ensureGuideMediaIndexes(connection: Connection): Promise<void> {
  const collection = connection.db!.collection(GUIDE_MEDIA_COLLECTION);
  await collection.createIndex({ createdAt: -1 }, { name: 'guide_media_created_at_desc' });
  await collection.createIndex({ key: 1 }, { name: 'key_1', unique: true });
}
