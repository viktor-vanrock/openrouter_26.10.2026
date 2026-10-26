const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { initializeS3 } = require('@librechat/api');

const MEDIA_REF_PATTERN = /media\/([a-f0-9]{24})/gi;
const MEDIA_URL_TTL_SECONDS = 2 * 60 * 60;

function getGuideMediaModel() {
  if (mongoose.models.GuideMedia) return mongoose.models.GuideMedia;

  // The production schema is registered by @librechat/data-schemas. This fallback
  // keeps local API startup working until that TypeScript package is rebuilt.
  const schema = new mongoose.Schema(
    {
      key: { type: String, required: true, unique: true },
      kind: { type: String, required: true, enum: ['image', 'video'] },
      contentType: { type: String, required: true },
      size: { type: Number, required: true, min: 0 },
      originalName: { type: String, required: true, maxlength: 200 },
      createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true },
  );
  schema.index({ createdAt: -1 });
  return mongoose.model('GuideMedia', schema);
}

function mediaIdsInHtml(html = '') {
  return [...html.matchAll(MEDIA_REF_PATTERN)].map((match) => match[1].toLowerCase());
}

function decodeUploadName(name) {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1'));
    const cyrillicCount = (value) => (value.match(/[\u0400-\u04ff]/g) ?? []).length;
    return cyrillicCount(decoded) > cyrillicCount(name) ? decoded : name;
  } catch {
    return name;
  }
}

function getS3() {
  const s3 = initializeS3();
  const bucket = process.env.AWS_BUCKET_NAME;
  if (!s3 || !bucket) throw new Error('S3 storage is not configured');
  return { s3, bucket };
}

function signedMediaUrl(id) {
  const token = jwt.sign({ guideMediaId: String(id) }, process.env.JWT_SECRET, {
    expiresIn: MEDIA_URL_TTL_SECONDS,
  });
  return `/api/guides/media/${id}?token=${encodeURIComponent(token)}`;
}

function mediaDto(media) {
  const id = String(media._id);
  return {
    id,
    kind: media.kind,
    name: decodeUploadName(media.originalName),
    size: media.size,
    createdAt: media.createdAt,
    url: signedMediaUrl(id),
    snippet:
      media.kind === 'image'
        ? `<img src="media/${id}" alt="">`
        : `<video controls preload="metadata" src="media/${id}"></video>`,
  };
}

async function mediaForHtml(html) {
  const ids = [...new Set(mediaIdsInHtml(html))];
  if (!ids.length) return { media: {}, mediaOrigin: undefined };
  const rows = await getGuideMediaModel()
    .find({ _id: { $in: ids } })
    .select('_id kind')
    .lean();
  const media = Object.fromEntries(
    rows.map((row) => [String(row._id), { url: signedMediaUrl(row._id), kind: row.kind }]),
  );
  return { media };
}

module.exports = {
  MEDIA_URL_TTL_SECONDS,
  decodeUploadName,
  getGuideMediaModel,
  getS3,
  mediaDto,
  mediaForHtml,
  mediaIdsInHtml,
  signedMediaUrl,
};
