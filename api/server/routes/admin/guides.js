const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const { requireCapability } = require('~/server/middleware/roles/capabilities');
const { requireJwtAuth } = require('~/server/middleware');
const { createFileLimiters } = require('~/server/middleware/limiters/uploadLimiters');
const {
  MAX_HTML_BYTES,
  extractTitle,
  validateRawHtml,
  sanitizeGuideHtml,
} = require('~/server/services/guides/sanitizeGuideHtml');
const {
  getGuideMediaModel,
  decodeUploadName,
  getS3,
  mediaDto,
  mediaForHtml,
} = require('~/server/services/guides/media');

const router = express.Router();
const requireAdminAccess = requireCapability(SystemCapabilities.ACCESS_ADMIN);
const requireManageGuides = requireCapability(SystemCapabilities.MANAGE_GUIDES);
const imageLimit = Number(process.env.GUIDES_IMAGE_MAX_BYTES) || 5 * 1024 * 1024;
const videoLimit = Number(process.env.GUIDES_VIDEO_MAX_BYTES) || 200 * 1024 * 1024;

router.use(requireJwtAuth, requireAdminAccess, requireManageGuides);
const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_HTML_BYTES, files: 1 },
  fileFilter: (_req, file, cb) =>
    /\.html?$/i.test(file.originalname)
      ? cb(null, true)
      : cb(new Error('Допустимы только .html файлы')),
});

const uploadSingle = (req, res, next) =>
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ message: 'Файл больше 2 МБ' });
    return res.status(400).json({ message: error.message });
  });

const validId = (req, res, next) =>
  mongoose.isValidObjectId(req.params.id)
    ? next()
    : res.status(400).json({ message: 'Неверный id' });

const metaFields =
  '_id title isPublished hasUnpublishedChanges size createdAt updatedAt publishedAt';
const toMeta = (guide) => ({
  _id: guide._id,
  title: guide.title,
  isPublished: guide.isPublished,
  hasUnpublishedChanges: guide.hasUnpublishedChanges,
  size: guide.size,
  createdAt: guide.createdAt,
  updatedAt: guide.updatedAt,
  publishedAt: guide.publishedAt,
});

function getGuidePageModel() {
  const GuidePage = mongoose.models.GuidePage;
  if (!GuidePage) throw new Error('GuidePage model not available');
  return GuidePage;
}
function detectMedia(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { kind: 'image', contentType: 'image/png', ext: 'png' };
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return { kind: 'image', contentType: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 4).toString() === 'GIF8')
    return { kind: 'image', contentType: 'image/gif', ext: 'gif' };
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP')
    return { kind: 'image', contentType: 'image/webp', ext: 'webp' };
  if (buffer.subarray(4, 8).toString() === 'ftyp')
    return { kind: 'video', contentType: 'video/mp4', ext: 'mp4' };
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return { kind: 'video', contentType: 'video/webm', ext: 'webm' };
  return null;
}
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) => cb(null, `guide-media-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: videoLimit, files: 1 },
});

function logMediaUploadError(stage, error, s3Request) {
  let message = String(error?.message ?? 'unknown error').replace(/https?:\/\/\S+/gi, '[url]');
  for (const secret of [process.env.AWS_ACCESS_KEY_ID, process.env.AWS_SECRET_ACCESS_KEY]) {
    if (secret) message = message.replaceAll(secret, '[redacted]');
  }
  logger.error('[guides] media upload failed', {
    stage,
    name: error?.name,
    message: message.slice(0, 500),
    code: error?.code,
    httpStatusCode: error?.$metadata?.httpStatusCode,
    ...(stage === 'загрузка в S3' ? { s3Request } : {}),
  });
}

function receiveMediaFile(req, res, next) {
  try {
    mediaUpload.single('file')(req, res, (error) => {
      if (!error) return next();
      logMediaUploadError('multer', error);
      if (error.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ message: 'Видео больше 200 МБ' });
      if (error instanceof multer.MulterError || /LIMIT_/.test(error.code ?? ''))
        return res.status(400).json({ message: error.message });
      return res.status(500).json({ message: 'Не удалось загрузить файл: приём файла' });
    });
  } catch (error) {
    logMediaUploadError('multer', error);
    return res.status(500).json({ message: 'Не удалось загрузить файл: приём файла' });
  }
}

router.get('/media', async (_req, res) => {
  const rows = await getGuideMediaModel().find({}).sort({ createdAt: -1 }).lean();
  return res
    .set('Cache-Control', 'private, no-store')
    .json({ media: rows.map((row) => mediaDto(row)) });
});

router.post(
  '/media',
  fileUploadIpLimiter,
  fileUploadUserLimiter,
  receiveMediaFile,
  async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'Файл не передан' });
    let stage = 'определение типа';
    let s3Request;
    try {
      const handle = await fs.promises.open(req.file.path, 'r');
      const head = Buffer.alloc(16);
      try {
        await handle.read(head, 0, head.length, 0);
      } finally {
        await handle.close();
      }
      const detected = detectMedia(head);
      if (!detected)
        return res.status(400).json({
          message:
            'Поддерживаются PNG, JPEG, WebP, GIF, MP4 и WebM. HEIC конвертируйте в JPEG или WebP.',
        });
      const limit = detected.kind === 'image' ? imageLimit : videoLimit;
      if (req.file.size > limit)
        return res.status(413).json({
          message: `${detected.kind === 'image' ? 'Картинка' : 'Видео'} превышает лимит ${limit / 1024 / 1024} МБ`,
        });
      stage = 'подключение S3';
      const { s3, bucket: s3Bucket } = getS3();
      const uploadedKey = `guides/media/${crypto.randomUUID()}.${detected.ext}`;
      const endpointHost = process.env.AWS_ENDPOINT_URL
        ? new URL(process.env.AWS_ENDPOINT_URL).host
        : undefined;
      s3Request = { endpointHost, Bucket: s3Bucket, Key: uploadedKey };
      logger.info('[guides] media put', {
        keyPrefix: 'guides/media/',
        extension: detected.ext,
        contentType: detected.contentType,
        contentLength: req.file.size,
        bucketConfigured: Boolean(s3Bucket),
      });
      stage = 'загрузка в S3';
      await s3.send(
        new PutObjectCommand({
          Bucket: s3Bucket,
          Key: uploadedKey,
          Body: fs.createReadStream(req.file.path),
          ContentLength: req.file.size,
          ContentType: detected.contentType,
        }),
      );
      stage = 'проверка чтения из S3';
      try {
        const uploaded = await s3.send(
          new GetObjectCommand({ Bucket: s3Bucket, Key: uploadedKey, Range: 'bytes=0-0' }),
        );
        if (!uploaded.Body) throw new Error('S3 returned an empty response body');
        await uploaded.Body.transformToByteArray();
      } catch (error) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: uploadedKey }));
        } catch (cleanupError) {
          logMediaUploadError('удаление объекта после ошибки чтения из S3', cleanupError);
        }
        throw error;
      }
      let media;
      stage = 'запись в MongoDB';
      try {
        media = await getGuideMediaModel().create({
          key: uploadedKey,
          kind: detected.kind,
          contentType: detected.contentType,
          size: req.file.size,
          originalName: decodeUploadName(req.file.originalname).slice(0, 200),
          createdBy: req.user.id,
        });
      } catch (error) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: uploadedKey }));
        } catch (cleanupError) {
          logMediaUploadError('удаление объекта после ошибки MongoDB', cleanupError);
        }
        throw error;
      }
      logger.info(`[guides] media uploaded ${media._id} by ${req.user.id}`);
      return res.status(201).json({ media: mediaDto(media) });
    } catch (error) {
      logMediaUploadError(stage, error, s3Request);
      return res.status(500).json({ message: `Не удалось загрузить файл: ${stage}` });
    } finally {
      await fs.promises.unlink(req.file.path).catch(() => {});
    }
  },
);

router.delete('/media/:id', validId, async (req, res) => {
  const media = await getGuideMediaModel().findById(req.params.id);
  if (!media) return res.status(404).json({ message: 'Файл не найден' });
  const usage = await getGuidePageModel()
    .find({
      $or: [
        { draftHtml: { $regex: `media/${req.params.id}` } },
        { publishedHtml: { $regex: `media/${req.params.id}` } },
      ],
    })
    .select('_id title')
    .lean();
  if (usage.length && req.query.force !== '1')
    return res.status(409).json({
      message: 'Файл используется на страницах',
      pages: usage.map((page) => ({ id: String(page._id), title: page.title })),
    });
  const { s3, bucket: s3Bucket } = getS3();
  await s3.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: media.key }));
  await media.deleteOne();
  logger.info(`[guides] media deleted ${media._id} by ${req.user.id}`);
  return res.json({ ok: true });
});

router.get('/', async (_req, res) => {
  const items = await getGuidePageModel()
    .find({})
    .select(metaFields)
    .sort({ isPublished: -1, createdAt: -1 })
    .lean();
  return res.set('Cache-Control', 'no-store').json({ items });
});

router.get('/:id', validId, async (req, res) => {
  const guide = await getGuidePageModel().findById(req.params.id).lean();
  if (!guide) return res.status(404).json({ message: 'Не найдено' });
  const media = await mediaForHtml(guide.draftHtml);
  return res
    .set('Cache-Control', 'private, no-store')
    .json({ guide: toMeta(guide), html: guide.draftHtml, ...media });
});

router.post('/', uploadSingle, async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Файл не передан' });
  let html;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(req.file.buffer).replace(/^\uFEFF/, '');
  } catch {
    return res.status(400).json({ message: 'Файл должен быть в UTF-8' });
  }
  const validationError = validateRawHtml(html);
  if (validationError) return res.status(400).json({ message: validationError });
  const fileName = Buffer.from(req.file.originalname, 'latin1')
    .toString('utf8')
    .replace(/\.html?$/i, '');
  const guide = await getGuidePageModel().create({
    title: extractTitle(html, fileName),
    draftHtml: html,
    size: Buffer.byteLength(html, 'utf8'),
    createdBy: req.user.id,
    updatedBy: req.user.id,
  });
  logger.info(`[guides] created ${guide._id} by ${req.user.id}`);
  return res.status(201).json({ guide: toMeta(guide), html });
});

router.put('/:id', validId, async (req, res) => {
  const html = req.body?.html;
  const validationError = validateRawHtml(html);
  if (validationError) return res.status(400).json({ message: validationError });
  const guide = await getGuidePageModel().findById(req.params.id);
  if (!guide) return res.status(404).json({ message: 'Не найдено' });
  guide.draftHtml = html;
  guide.title = extractTitle(html, guide.title);
  guide.size = Buffer.byteLength(html, 'utf8');
  guide.updatedBy = req.user.id;
  if (guide.isPublished) guide.hasUnpublishedChanges = true;
  await guide.save();
  logger.info(`[guides] updated ${guide._id} by ${req.user.id}`);
  return res.json({ guide: toMeta(guide) });
});

router.delete('/:id', validId, async (req, res) => {
  const guide = await getGuidePageModel().findByIdAndDelete(req.params.id);
  if (!guide) return res.status(404).json({ message: 'Не найдено' });
  logger.info(`[guides] deleted ${guide._id} (published=${guide.isPublished}) by ${req.user.id}`);
  return res.json({ ok: true });
});

router.post('/:id/publish', validId, async (req, res) => {
  const GuidePage = getGuidePageModel();
  const guide = await GuidePage.findById(req.params.id);
  if (!guide) return res.status(404).json({ message: 'Не найдено' });
  try {
    await GuidePage.updateMany(
      { isPublished: true, _id: { $ne: guide._id } },
      { $set: { isPublished: false, publishedHtml: '', hasUnpublishedChanges: false } },
    );
    guide.publishedHtml = sanitizeGuideHtml(guide.draftHtml);
    guide.isPublished = true;
    guide.hasUnpublishedChanges = false;
    guide.publishedBy = req.user.id;
    guide.publishedAt = new Date();
    await guide.save();
  } catch (error) {
    if (error?.code === 11000)
      return res.status(409).json({ message: 'Конфликт публикации, повторите' });
    throw error;
  }
  logger.info(`[guides] published ${guide._id} by ${req.user.id}`);
  return res.json({ guide: toMeta(guide) });
});

module.exports = router;
