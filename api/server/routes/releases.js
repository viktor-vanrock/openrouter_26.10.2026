const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const {
  models,
  parseLimit,
  parseCursor,
  cursorFilter,
  encodeCursor,
  publicDto,
  lastSeenForUser,
} = require('~/server/services/releases/common');

const router = express.Router();
router.use(requireJwtAuth, (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

async function unreadCount(Release, lastSeenAt) {
  return Release.countDocuments({
    isPublished: true,
    publishedAt: { $gt: lastSeenAt, $lte: new Date() },
  });
}

router.get('/status', async (req, res) => {
  const { Release, UserReleaseState } = models();
  const now = new Date();
  const [lastSeenAt, latest] = await Promise.all([
    lastSeenForUser(req, UserReleaseState),
    Release.findOne({ isPublished: true, publishedAt: { $lte: now } })
      .sort({ publishedAt: -1, _id: -1 })
      .select('publishedAt')
      .lean(),
  ]);
  return res.json({
    unreadCount: await unreadCount(Release, lastSeenAt),
    latestPublishedAt: latest?.publishedAt ?? null,
  });
});

router.get('/unread', async (req, res) => {
  const limit = parseLimit(req.query.limit, 5, 20);
  if (!limit) return res.status(400).json({ message: 'Неверный limit' });
  const { Release, UserReleaseState } = models();
  const lastSeenAt = await lastSeenForUser(req, UserReleaseState);
  const filter = { isPublished: true, publishedAt: { $gt: lastSeenAt, $lte: new Date() } };
  const [rows, count] = await Promise.all([
    Release.find(filter)
      .sort({ publishedAt: -1, _id: -1 })
      .limit(limit)
      .select('_id title text publishedAt')
      .lean(),
    Release.countDocuments(filter),
  ]);
  return res.json({
    items: rows.map((row) => publicDto(row, lastSeenAt)),
    unreadCount: count,
    lastSeenAt,
  });
});

router.get('/', async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = parseCursor(req.query.cursor);
  if (!limit || cursor === false)
    return res.status(400).json({ message: 'Неверный limit или cursor' });
  const { Release, UserReleaseState } = models();
  const lastSeenAt = await lastSeenForUser(req, UserReleaseState);
  const rows = await Release.find({
    isPublished: true,
    publishedAt: { $lte: new Date() },
    ...cursorFilter('publishedAt', cursor),
  })
    .sort({ publishedAt: -1, _id: -1 })
    .limit(limit + 1)
    .select('_id title text publishedAt')
    .lean();
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return res.json({
    items: visible.map((row) => publicDto(row, lastSeenAt)),
    nextCursor: rows.length > limit && last ? encodeCursor(last.publishedAt, last._id) : null,
    lastSeenAt,
  });
});

router.post('/seen', async (req, res) => {
  const value = req.body?.seenUpTo;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return res.status(400).json({ message: 'Неверная дата seenUpTo' });
  const requested = new Date(value);
  if (Number.isNaN(requested.getTime()) || requested.toISOString() !== value)
    return res.status(400).json({ message: 'Неверная дата seenUpTo' });
  try {
    const { Release, UserReleaseState } = models();
    const priorSeenAt = await lastSeenForUser(req, UserReleaseState);
    const bound = new Date(Math.min(requested.getTime(), Date.now()));
    const latest = await Release.findOne({ isPublished: true, publishedAt: { $lte: bound } })
      .sort({ publishedAt: -1, _id: -1 })
      .select('publishedAt')
      .lean();
    if (latest && latest.publishedAt > priorSeenAt) {
      try {
        await UserReleaseState.updateOne(
          { userId: req.user.id },
          { $max: { lastSeenAt: latest.publishedAt } },
          { upsert: true },
        );
      } catch (error) {
        if (error?.code !== 11000) throw error;
        await UserReleaseState.updateOne(
          { userId: req.user.id },
          { $max: { lastSeenAt: latest.publishedAt } },
        );
      }
    }
    const lastSeenAt = await lastSeenForUser(req, UserReleaseState);
    const remaining = await unreadCount(Release, lastSeenAt);
    logger.info(
      `[releases] seen through ${lastSeenAt.toISOString()} by ${req.user.id}; unread=${remaining}`,
    );
    return res.json({ unreadCount: remaining, lastSeenAt });
  } catch (error) {
    logger.error('[releases] failed to mark releases as seen', {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
    return res.status(500).json({ message: 'Не удалось отметить релизы прочитанными' });
  }
});

module.exports = router;
