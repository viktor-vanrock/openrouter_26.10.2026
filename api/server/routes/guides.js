const express = require('express');
const mongoose = require('mongoose');
const { requireJwtAuth } = require('~/server/middleware');
const { mediaForHtml } = require('~/server/services/guides/media');

const router = express.Router();

router.get('/published', requireJwtAuth, async (_req, res) => {
  const GuidePage = mongoose.models.GuidePage;
  if (!GuidePage) throw new Error('GuidePage model not available');
  const guide = await GuidePage.findOne({ isPublished: true })
    .select('title publishedHtml publishedAt')
    .lean();
  if (!guide) return res.status(404).json({ message: 'not_published' });
  const media = await mediaForHtml(guide.publishedHtml);
  return res
    .set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
    .json({
      title: guide.title,
      html: guide.publishedHtml,
      publishedAt: guide.publishedAt,
      ...media,
    });
});

module.exports = router;
