jest.mock('axios');
jest.mock('./denyRequest', () => jest.fn().mockResolvedValue(undefined));
const axios = require('axios');
const denyRequest = require('./denyRequest');
const moderateText = require('./moderateText');
const { ErrorTypes } = require('librechat-data-provider');

describe('ordinary chat moderation parity', () => {
  let previous;
  beforeEach(() => {
    previous = process.env.OPENAI_MODERATION;
    process.env.OPENAI_MODERATION = 'true';
    axios.post.mockReset();
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.OPENAI_MODERATION;
    else process.env.OPENAI_MODERATION = previous;
  });
  it('retains the normal chat denial for a flagged request', async () => {
    axios.post.mockResolvedValue({ data: { results: [{ flagged: true }] } });
    const req = { body: { text: 'blocked fixture' } },
      res = {},
      next = jest.fn();
    await moderateText(req, res, next);
    expect(denyRequest).toHaveBeenCalledWith(req, res, { type: ErrorTypes.MODERATION });
    expect(next).not.toHaveBeenCalled();
  });
  it('continues an unflagged request', async () => {
    axios.post.mockResolvedValue({ data: { results: [{ flagged: false }] } });
    const next = jest.fn();
    await moderateText({ body: { text: 'ordinary request' } }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('does not call the provider while the existing feature flag is disabled', async () => {
    process.env.OPENAI_MODERATION = 'false';
    const next = jest.fn();
    await moderateText({ body: { text: 'ordinary request' } }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });
  it('preserves denial when the provider is unavailable', async () => {
    axios.post.mockRejectedValue(new Error('provider unavailable'));
    const req = { body: { text: 'ordinary request' } },
      res = {},
      next = jest.fn();
    await moderateText(req, res, next);
    expect(denyRequest).toHaveBeenCalledWith(req, res, 'error in moderation check');
    expect(next).not.toHaveBeenCalled();
  });
});
