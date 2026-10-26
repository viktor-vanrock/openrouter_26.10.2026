const mongoose = require('mongoose');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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

function getS3() {
  const s3 = initializeS3();
  const bucket = process.env.AWS_BUCKET_NAME;
  if (!s3 || !bucket) throw new Error('S3 storage is not configured');
  return { s3, bucket };
}

async function signedMediaUrl(key) {
  const { s3, bucket } = getS3();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: MEDIA_URL_TTL_SECONDS,
  });
}

function mediaDto(media, url) {
  const id = String(media._id);
  return {
    id,
    kind: media.kind,
    name: media.originalName,
    size: media.size,
    createdAt: media.createdAt,
    url,
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
    .select('_id key kind')
    .lean();
  const entries = await Promise.all(
    rows.map(async (row) => [
      String(row._id),
      { url: await signedMediaUrl(row.key), kind: row.kind },
    ]),
  );
  const media = Object.fromEntries(entries);
  const firstUrl = Object.values(media)[0]?.url;
  return { media, mediaOrigin: firstUrl ? new URL(firstUrl).origin : undefined };
}

module.exports = {
  MEDIA_URL_TTL_SECONDS,
  getGuideMediaModel,
  getS3,
  mediaDto,
  mediaForHtml,
  mediaIdsInHtml,
  signedMediaUrl,
};
