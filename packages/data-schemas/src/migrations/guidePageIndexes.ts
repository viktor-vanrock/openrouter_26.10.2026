import type { Connection } from 'mongoose';

export const GUIDE_PAGE_COLLECTION = 'guidepages';
export const PUBLISHED_GUIDE_INDEX = 'one_published_guide';

/** Ensures that at most one guide page is published at a time. */
export async function ensureGuidePageIndexes(connection: Connection): Promise<void> {
  const collection = connection.db!.collection(GUIDE_PAGE_COLLECTION);
  await collection.createIndex(
    { isPublished: 1 },
    {
      name: PUBLISHED_GUIDE_INDEX,
      unique: true,
      partialFilterExpression: { isPublished: true },
    },
  );
}
