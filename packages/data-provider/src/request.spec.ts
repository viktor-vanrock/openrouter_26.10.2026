import axios from 'axios';
import request from './request';

jest.mock('axios');

describe('request.post', () => {
  it('preserves callers’ headers while retaining JSON content type', async () => {
    const post = jest.mocked(axios.post).mockResolvedValue({ data: { ok: true } });

    await request.post('/api/prototypes/job_1/replies', { messageId: 'message_1' }, {
      headers: { 'Idempotency-Key': 'reply-key' },
    });

    expect(post).toHaveBeenCalledWith(
      '/api/prototypes/job_1/replies',
      JSON.stringify({ messageId: 'message_1' }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'reply-key',
        },
      },
    );
  });
});
