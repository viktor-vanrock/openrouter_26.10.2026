const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { getGuideMediaModel, getS3, mediaForHtml } = require('~/server/services/guides/media');

const router = express.Router();

router.get('/media/:id', async (req, res) => {
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  });
  if (!mongoose.isValidObjectId(req.params.id)) return res.sendStatus(404);
  try {
    const payload = jwt.verify(req.query.token, process.env.JWT_SECRET);
    if (payload?.guideMediaId !== req.params.id) return res.sendStatus(401);
  } catch {
    return res.sendStatus(401);
  }

  const media = await getGuideMediaModel().findById(req.params.id).lean();
  if (!media) return res.sendStatus(404);
  const { s3, bucket } = getS3();
  try {
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: media.key,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      }),
    );
    res.status(object.ContentRange ? 206 : 200);
    res.set('Content-Type', media.contentType);
    if (object.ContentLength != null) res.set('Content-Length', String(object.ContentLength));
    if (object.ContentRange) res.set('Content-Range', object.ContentRange);
    res.on('close', () => object.Body.destroy());
    object.Body.on('error', (error) => {
      logger.error(`[guides] media stream failed ${req.params.id}: ${error.name}`);
      res.destroy(error);
    });
    return object.Body.pipe(res);
  } catch (error) {
    logger.error(
      `[guides] media read failed ${req.params.id}: ${error.name} (${error.$metadata?.httpStatusCode ?? 'no status'})`,
    );
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey') {
      return res.sendStatus(404);
    }
    if (error?.$metadata?.httpStatusCode === 416) return res.sendStatus(416);
    return res.status(502).json({ message: 'Не удалось загрузить файл' });
  }
});

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
