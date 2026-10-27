const mongoose = require('mongoose');

function models() {
  const Release = mongoose.models.Release;
  const UserReleaseState = mongoose.models.UserReleaseState;
  if (!Release || !UserReleaseState) throw new Error('Release models not available');
  return { Release, UserReleaseState };
}

function parseLimit(value, fallback = 20, maximum = 50) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= maximum ? limit : null;
}

function encodeCursor(date, id) {
  return Buffer.from(`${date.toISOString()}|${id}`, 'utf8').toString('base64');
}

function parseCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    return false;
  const raw = Buffer.from(value, 'base64');
  if (raw.toString('base64') !== value) return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([a-f0-9]{24})$/.exec(
    raw.toString('utf8'),
  );
  if (!match) return false;
  const date = new Date(match[1]);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== match[1]) return false;
  return { date, id: new mongoose.Types.ObjectId(match[2]) };
}

function cursorFilter(field, cursor) {
  return cursor
    ? {
        $or: [{ [field]: { $lt: cursor.date } }, { [field]: cursor.date, _id: { $lt: cursor.id } }],
      }
    : {};
}

function validateContent(body) {
  const title = body?.title ?? '';
  const text = body?.text;
  if (typeof title !== 'string' || title.trim().length > 120)
    return { error: 'Заголовок должен быть строкой длиной до 120 символов' };
  if (typeof text !== 'string' || !text.trim() || text.length > 10000)
    return { error: 'Текст обязателен и должен содержать не более 10 000 символов' };
  return { title: title.trim(), text };
}

function publicDto(release, lastSeenAt) {
  return {
    id: String(release._id),
    title: release.title,
    text: release.text,
    publishedAt: release.publishedAt,
    isUnread: release.publishedAt > lastSeenAt,
  };
}

async function lastSeenForUser(req, UserReleaseState) {
  const state = await UserReleaseState.findOne({ userId: req.user.id }).select('lastSeenAt').lean();
  const createdAt = req.user.createdAt
    ? new Date(req.user.createdAt)
    : (await mongoose.models.User.findById(req.user.id).select('createdAt').lean())?.createdAt;
  if (!createdAt) throw new Error('User registration date not available');
  return state?.lastSeenAt && state.lastSeenAt > createdAt ? state.lastSeenAt : createdAt;
}

module.exports = {
  models,
  parseLimit,
  encodeCursor,
  parseCursor,
  cursorFilter,
  validateContent,
  publicDto,
  lastSeenForUser,
};
