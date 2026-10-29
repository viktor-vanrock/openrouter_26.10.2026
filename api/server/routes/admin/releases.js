const express = require('express');
const mongoose = require('mongoose');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const {
  models,
  parseLimit,
  parseCursor,
  cursorFilter,
  encodeCursor,
  validateContent,
} = require('~/server/services/releases/common');

const router = express.Router();
router.use(
  requireJwtAuth,
  requireCapability(SystemCapabilities.ACCESS_ADMIN),
  requireCapability(SystemCapabilities.MANAGE_RELEASES),
  (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  },
);

router.param('id', (req, res, next) =>
  mongoose.isValidObjectId(req.params.id)
    ? next()
    : res.status(400).json({ message: 'Неверный id релиза' }),
);

router.get('/', async (req, res) => {
  const limit = parseLimit(req.query.limit);
  const cursor = parseCursor(req.query.cursor);
  if (!limit || cursor === false)
    return res.status(400).json({ message: 'Неверный limit или cursor' });
  const { Release } = models();
  const rows = await Release.find(cursorFilter('createdAt', cursor))
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .select('_id title text isPublished publishedAt createdAt updatedAt')
    .lean();
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return res.json({
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last._id) : null,
  });
});

router.post('/', async (req, res) => {
  const content = validateContent(req.body);
  if (content.error) return res.status(400).json({ message: content.error });
  const { Release } = models();
  const release = await Release.create({
    title: content.title,
    text: content.text,
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });
  logger.info(`[releases] created ${release._id} by ${req.user.id}`);
  return res.status(201).json({ release });
});

router.put('/:id', async (req, res) => {
  const content = validateContent(req.body);
  if (content.error) return res.status(400).json({ message: content.error });
  const { Release } = models();
  const release = await Release.findByIdAndUpdate(
    req.params.id,
    { $set: { title: content.title, text: content.text, updatedBy: req.user.id } },
    { new: true, runValidators: true },
  );
  if (!release) return res.status(404).json({ message: 'Релиз не найден' });
  logger.info(`[releases] updated ${release._id} by ${req.user.id}`);
  return res.json({ release });
});

router.delete('/:id', async (req, res) => {
  const { Release } = models();
  const release = await Release.findByIdAndDelete(req.params.id);
  if (!release) return res.status(404).json({ message: 'Релиз не найден' });
  logger.info(`[releases] deleted ${release._id} by ${req.user.id}`);
  return res.json({ ok: true });
});

router.post('/:id/publish', async (req, res) => {
  const { Release } = models();
  const release = await Release.findOneAndUpdate(
    { _id: req.params.id, isPublished: false },
    { $set: { isPublished: true, publishedAt: new Date(), publishedBy: req.user.id } },
    { new: true },
  );
  if (!release) {
    const exists = await Release.exists({ _id: req.params.id });
    return res
      .status(exists ? 409 : 404)
      .json({ message: exists ? 'Релиз уже опубликован' : 'Релиз не найден' });
  }
  logger.info(`[releases] published ${release._id} by ${req.user.id}`);
  return res.json({ release });
});

router.post('/:id/unpublish', async (req, res) => {
  const { Release } = models();
  const release = await Release.findOneAndUpdate(
    { _id: req.params.id, isPublished: true },
    { $set: { isPublished: false, publishedAt: null } },
    { new: true },
  );
  if (!release) {
    const exists = await Release.exists({ _id: req.params.id });
    return res
      .status(exists ? 409 : 404)
      .json({ message: exists ? 'Релиз уже снят с публикации' : 'Релиз не найден' });
  }
  logger.info(`[releases] unpublished ${release._id} by ${req.user.id}`);
  return res.json({ release });
});

module.exports = router;
