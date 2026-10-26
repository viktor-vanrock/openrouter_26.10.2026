const http = require('http');
const { createPrototypeStreamingHttpAdapter } = require('./PrototypeStreamingHttpAdapter');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe('Prototype streaming HTTP adapter', () => {
  it('streams a JSON request to a locally injected upstream without buffering its response', async () => {
    const capture = {};
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        capture.method = req.method;
        capture.authorization = req.headers.authorization;
        capture.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
    await listen(server);
    try {
      const address = server.address();
      const requestUpstream = createPrototypeStreamingHttpAdapter();
      const response = await requestUpstream({
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        method: 'POST',
        headers: { Authorization: 'Bearer synthetic-key', 'Content-Type': 'application/json' },
        body: { model: 'fixed/model', messages: [] },
        signal: new AbortController().signal,
      });
      const responseChunks = [];
      for await (const chunk of response.body) responseChunks.push(String(chunk));

      expect(capture).toEqual({
        method: 'POST',
        authorization: 'Bearer synthetic-key',
        body: { model: 'fixed/model', messages: [] },
      });
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(responseChunks.join('')).toBe('data: first\n\ndata: [DONE]\n\n');
    } finally {
      await close(server);
    }
  });

  it('aborts the upstream socket when the execution signal is canceled', async () => {
    const fetchImpl = jest.fn((_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    );
    const controller = new AbortController();
    const requestUpstream = createPrototypeStreamingHttpAdapter({ fetchImpl });
    const pending = requestUpstream({
      url: 'http://127.0.0.1:1/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { model: 'fixed/model', messages: [] },
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow('aborted');
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      signal: controller.signal,
    }));
  });
});
