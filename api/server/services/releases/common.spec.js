const mongoose = require('mongoose');
const {
  parseLimit,
  encodeCursor,
  parseCursor,
  cursorFilter,
  validateContent,
} = require('./common');

describe('release input and pagination helpers', () => {
  it('validates content and limits', () => {
    expect(validateContent({ text: '   ' }).error).toBeDefined();
    expect(validateContent({ text: 'x'.repeat(10001) }).error).toBeDefined();
    expect(validateContent({ title: 'x'.repeat(121), text: 'ok' }).error).toBeDefined();
    expect(validateContent({ title: ' test ', text: 'a\n<b>' })).toEqual({
      title: 'test',
      text: 'a\n<b>',
    });
    expect(parseLimit('0')).toBeNull();
    expect(parseLimit('51')).toBeNull();
    expect(parseLimit('20')).toBe(20);
  });

  it('round trips a cursor and rejects malformed input', () => {
    const date = new Date('2026-10-26T18:30:00.000Z');
    const id = new mongoose.Types.ObjectId();
    const cursor = parseCursor(encodeCursor(date, id));
    expect(cursor).toEqual({ date, id });
    expect(cursorFilter('publishedAt', cursor)).toEqual({
      $or: [{ publishedAt: { $lt: date } }, { publishedAt: date, _id: { $lt: id } }],
    });
    expect(parseCursor('not-base64')).toBe(false);
    expect(parseCursor(Buffer.from('bad-date|bad-id').toString('base64'))).toBe(false);
  });
});
