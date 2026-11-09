import type { Connection } from 'mongoose';

export async function ensureReleaseIndexes(connection: Connection): Promise<void> {
  const database = connection.db!;
  const ensureIndex = async (
    collectionName: string,
    key: Record<string, 1 | -1>,
    unique = false,
  ) => {
    const collection = database.collection(collectionName);
    const exists = await database.listCollections({ name: collectionName }).hasNext();
    const indexes = exists ? await collection.listIndexes().toArray() : [];
    const matching = indexes.find(
      (index) =>
        JSON.stringify(index.key) === JSON.stringify(key) && Boolean(index.unique) === unique,
    );
    if (!matching) await collection.createIndex(key, unique ? { unique: true } : {});
  };

  await ensureIndex('releases', { isPublished: 1, publishedAt: -1, _id: -1 });
  await ensureIndex('releases', { createdAt: -1, _id: -1 });
  await ensureIndex('userreleasestates', { userId: 1 }, true);
}
