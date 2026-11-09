const express = require('express');
const axios = require('axios');
const zlib = require('node:zlib');
const { logger } = require('@librechat/data-schemas');
const { getAppConfig } = require('~/server/services/Config/app');
const { getUserKeyValues } = require('~/models');

const router = express.Router();
const MAX_PRICING_RESPONSE_BYTES = 5 * 1024 * 1024;

function decodeResponse(response) {
  let bytes = Buffer.from(response.data);
  const encoding = String(response.headers?.['content-encoding'] ?? '').toLowerCase();
  if (encoding.includes('gzip') || (bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    bytes = zlib.gunzipSync(bytes, { maxOutputLength: MAX_PRICING_RESPONSE_BYTES });
  } else if (encoding.includes('deflate') || (bytes[0] === 0x78 && bytes[1] === 0x9c)) {
    bytes = zlib.inflateSync(bytes, { maxOutputLength: MAX_PRICING_RESPONSE_BYTES });
  } else if (encoding.includes('br')) {
    bytes = zlib.brotliDecompressSync(bytes, { maxOutputLength: MAX_PRICING_RESPONSE_BYTES });
  }
  return JSON.parse(bytes.toString('utf8'));
}

router.get('/pricing', async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const config = await getAppConfig({
      role: req.user.role,
      userId: req.user.id,
      tenantId: req.user.tenantId,
    });
    const endpoint = config?.endpoints?.custom?.find((item) => item.name === 'OpenRouter');
    if (!endpoint?.baseURL || !endpoint?.apiKey) return res.json({ items: [] });

    const baseURL = new URL(endpoint.baseURL);
    if (baseURL.protocol !== 'https:' || baseURL.hostname !== 'or.crbrcloud.ru') {
      return res.json({ items: [] });
    }

    let values;
    try {
      values = await getUserKeyValues({ userId: req.user.id, name: 'OpenRouter' });
    } catch {
      return res.json({ items: [] });
    }
    if (typeof values?.apiKey !== 'string' || !values.apiKey) return res.json({ items: [] });

    const url = `${baseURL.toString().replace(/\/+$/, '')}/models`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${values.apiKey}`,
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
      },
      timeout: 8000,
      responseType: 'arraybuffer',
      decompress: false,
      maxRedirects: 0,
      maxContentLength: MAX_PRICING_RESPONSE_BYTES,
    });
    const payload = decodeResponse(response);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const items = rows.slice(0, 5000).flatMap((model) => {
      if (typeof model?.id !== 'string' || model.id.length > 200) return [];
      const rate = (value) => {
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : null;
      };
      const prompt = rate(model.pricing?.prompt);
      const completion = rate(model.pricing?.completion);
      const request = rate(model.pricing?.request);
      if (prompt === null && completion === null && request === null) return [];
      return [
        {
          id: model.id,
          ...(prompt !== null ? { promptPerMillion: prompt * 1_000_000 } : {}),
          ...(completion !== null ? { completionPerMillion: completion * 1_000_000 } : {}),
          ...(request !== null ? { requestPrice: request } : {}),
        },
      ];
    });
    return res.json({ items });
  } catch (error) {
    logger.warn('[model-prices] upstream pricing unavailable', {
      status: error?.response?.status,
      code: error?.code,
    });
    return res.status(502).json({ message: 'Не удалось загрузить стоимость моделей' });
  }
});

module.exports = router;
