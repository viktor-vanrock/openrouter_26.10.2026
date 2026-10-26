const { Readable } = require('stream');

function responseHeaders(response) {
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

function createPrototypeStreamingHttpAdapter({ fetchImpl = fetch } = {}) {
  return async ({ url, method, headers, body, signal }) => {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    });
    if (!response.body) throw new Error('Prototype upstream response has no body');
    return {
      status: response.status,
      headers: responseHeaders(response),
      body: Readable.fromWeb(response.body),
    };
  };
}

module.exports = { createPrototypeStreamingHttpAdapter };
