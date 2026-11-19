const axios = require('axios');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { extractEnvVariable } = require('librechat-data-provider');
const { getUserKeyValues } = require('~/models');

const cache = new Map();
const TTL = 10 * 60 * 1000;
const FAILURE = 'Извините, не удалось сгенерировать изображение';

async function credentials(req) {
  const endpoint = req.config?.endpoints?.custom?.find(
    (item) => item.name?.toLowerCase() === 'openrouter',
  );
  if (!endpoint) throw new Error('OpenRouter is not configured');
  const values = await getUserKeyValues({ userId: req.user.id, name: endpoint.name }).catch(
    () => ({}),
  );
  const configuredKey = extractEnvVariable(endpoint.apiKey);
  const configuredUrl = extractEnvVariable(endpoint.baseURL);
  const apiKey = configuredKey === 'user_provided' ? values?.apiKey : configuredKey;
  const baseURL = new URL(configuredUrl === 'user_provided' ? values?.baseURL : configuredUrl);
  if (
    !apiKey ||
    apiKey === 'user_provided' ||
    baseURL.protocol !== 'https:' ||
    baseURL.username ||
    baseURL.password ||
    baseURL.search ||
    baseURL.hash
  ) {
    throw new Error('Invalid OpenRouter configuration');
  }
  return { apiKey, baseURL: baseURL.toString().replace(/\/+$/, '') };
}

function price(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function outputModalities(model) {
  const modalities = model.architecture?.output_modalities ?? model.output_modalities;
  if (Array.isArray(modalities)) return modalities;
  const modality = model.architecture?.modality;
  if (typeof modality !== 'string' || !modality.includes('->')) return [];
  return modality
    .split('->')[1]
    .split('+')
    .map((item) => item.trim());
}

function normalizeModels(rows) {
  return rows
    .filter((m) => {
      if (typeof m?.id !== 'string' || m.id.length > 200) return false;
      // Routers describe the union of all possible outputs, not a specific image model.
      if (
        String(m.architecture?.tokenizer ?? '').toLowerCase() === 'router' ||
        /^openrouter\/auto(?:[-:]|$)/i.test(m.id)
      )
        return false;
      return outputModalities(m).includes('image');
    })
    .map((m) => {
      const imageOutput = price(m.pricing?.image_output);
      const imageToken = price(m.pricing?.image_token);
      const prompt = price(m.pricing?.prompt);
      const request = price(m.pricing?.request);
      const completion = price(m.pricing?.completion);
      const cost = null;
      return {
        id: m.id,
        name: typeof m.name === 'string' ? m.name : m.id,
        price: cost,
        outputModalities: outputModalities(m),
        imagePrice: null,
        ...(imageOutput !== null || imageToken !== null
          ? { imageOutputPerMillion: (imageOutput ?? imageToken) * 1_000_000 }
          : {}),
        ...(prompt !== null ? { promptPerMillion: prompt * 1_000_000 } : {}),
        ...(completion !== null ? { completionPerMillion: completion * 1_000_000 } : {}),
        ...(request !== null ? { requestPrice: request } : {}),
      };
    })
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || a.id.localeCompare(b.id));
}

function perImagePrice(payload) {
  const endpoints = Array.isArray(payload?.endpoints) ? payload.endpoints : [];
  const prices = [];
  for (const endpoint of endpoints) {
    if (typeof endpoint?.provider_tag !== 'string' || !endpoint.provider_tag) continue;
    const output = (Array.isArray(endpoint.pricing) ? endpoint.pricing : []).filter(
      (item) => item?.billable === 'output_image',
    );
    if (output.length !== 1 || output[0].unit !== 'image' || output[0].variant) continue;
    const amount = price(output[0].cost_usd);
    if (amount !== null) prices.push({ amount, provider: endpoint.provider_tag });
  }
  return prices.sort((a, b) => a.amount - b.amount)[0] ?? null;
}

async function attachImagePrices(models, auth) {
  let next = 0;
  async function worker() {
    while (next < models.length) {
      const model = models[next++];
      try {
        const response = await axios.get(
          `${auth.baseURL}/images/models/${model.id.split('/').map(encodeURIComponent).join('/')}/endpoints`,
          {
            headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: 'application/json' },
            timeout: 3000,
            maxRedirects: 0,
            maxContentLength: 1024 * 1024,
          },
        );
        const value = perImagePrice(response.data);
        if (value !== null) {
          model.imagePrice = model.price = value.amount;
          model.imageProvider = value.provider;
        }
      } catch {
        // The provider may not offer the endpoint or a comparable per-image price.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(models.length, 8) }, () => worker()));
  models.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || a.id.localeCompare(b.id));
}

async function getImageModels(req, auth) {
  auth = auth ?? (await credentials(req));
  const key = crypto.createHash('sha256').update(`${auth.baseURL}\0${auth.apiKey}`).digest('hex');
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.models;
  const options = {
    headers: {
      Authorization: `Bearer ${auth.apiKey}`,
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
    },
    timeout: 8000,
    maxRedirects: 0,
    maxContentLength: 5 * 1024 * 1024,
    responseType: 'arraybuffer',
    decompress: false,
  };
  let response;
  try {
    response = await axios.get(`${auth.baseURL}/models/user`, {
      ...options,
      params: { output_modalities: 'image' },
    });
  } catch (error) {
    if (![400, 404, 405, 422, 501].includes(error?.response?.status)) throw error;
    try {
      response = await axios.get(`${auth.baseURL}/models`, {
        ...options,
        params: { output_modalities: 'image' },
      });
    } catch (fallbackError) {
      if (![400, 404, 405, 422].includes(fallbackError?.response?.status)) throw fallbackError;
      response = await axios.get(`${auth.baseURL}/models`, options);
    }
  }
  let payload = response.data;
  if (Buffer.isBuffer(payload) || payload instanceof ArrayBuffer) {
    let bytes = Buffer.from(payload);
    const encoding = String(response.headers?.['content-encoding'] ?? '').toLowerCase();
    const options = { maxOutputLength: 5 * 1024 * 1024 };
    if (encoding.includes('gzip') || (bytes[0] === 0x1f && bytes[1] === 0x8b))
      bytes = zlib.gunzipSync(bytes, options);
    else if (encoding.includes('deflate')) bytes = zlib.inflateSync(bytes, options);
    else if (encoding.includes('br')) bytes = zlib.brotliDecompressSync(bytes, options);
    payload = JSON.parse(bytes.toString('utf8'));
  }
  if (!Array.isArray(payload?.data)) throw new Error('Invalid model list');
  const sorted = normalizeModels(payload.data.slice(0, 5000));
  const seen = new Set();
  const models = sorted.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
  await attachImagePrices(models, auth);
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(key, { models, expires: Date.now() + TTL });
  return models;
}

function imageUrlFromMessage(message) {
  const parts = [
    ...(Array.isArray(message?.images) ? message.images : []),
    ...(Array.isArray(message?.content) ? message.content : []),
  ];
  return parts
    .map((part) => part?.image_url?.url ?? part?.url)
    .find(
      (url) =>
        typeof url === 'string' &&
        url.length <= 40 * 1024 * 1024 &&
        /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(url),
    );
}

async function generateImage({ req, prompt, signal, onUsage }) {
  try {
    const auth = await credentials(req);
    const models = await getImageModels(req, auth);
    const chosen = models.find((m) => m.id === req.body?.imageModel);
    const candidates = [
      ...(chosen ? [chosen] : []),
      ...models.filter((m) => m.id !== chosen?.id),
    ].slice(0, 3);
    for (const model of candidates) {
      if (signal?.aborted) return null;
      try {
        const imageOnly = !model.outputModalities.includes('text');
        const response = await axios.post(
          `${auth.baseURL}/${imageOnly ? 'images' : 'chat/completions'}`,
          imageOnly
            ? {
                model: model.id,
                prompt,
                ...(model.imageProvider
                  ? { provider: { only: [model.imageProvider], allow_fallbacks: false } }
                  : {}),
              }
            : {
                model: model.id,
                messages: [{ role: 'user', content: prompt }],
                modalities: ['image', 'text'],
                stream: false,
                ...(model.imageProvider
                  ? { provider: { only: [model.imageProvider], allow_fallbacks: false } }
                  : {}),
              },
          {
            headers: { Authorization: `Bearer ${auth.apiKey}`, 'Content-Type': 'application/json' },
            timeout: 180000,
            maxRedirects: 0,
            maxContentLength: 40 * 1024 * 1024,
            maxBodyLength: 32 * 1024,
            signal,
          },
        );
        if (response.data?.usage && onUsage) onUsage(response.data.usage, model.id);
        let url = imageUrlFromMessage(response.data?.choices?.[0]?.message);
        if (imageOnly) {
          const b64 = response.data?.data?.[0]?.b64_json;
          if (
            typeof b64 === 'string' &&
            b64.length <= 40 * 1024 * 1024 &&
            /^[A-Za-z0-9+/=]+$/.test(b64)
          ) {
            const bytes = Buffer.from(b64.slice(0, 24), 'base64');
            let mime = 'png';
            if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = 'jpeg';
            else if (
              bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
              bytes.subarray(8, 12).toString('ascii') === 'WEBP'
            )
              mime = 'webp';
            url = `data:image/${mime};base64,${b64}`;
          }
        }
        if (url) return { url, model: model.id, usage: response.data?.usage };
      } catch (error) {
        if (signal?.aborted || [401, 402].includes(error?.response?.status)) return null;
      }
    }
  } catch {
    // Provider errors can contain credentials or image data; never expose them.
  }
  return null;
}

module.exports = {
  credentials,
  getImageModels,
  normalizeModels,
  perImagePrice,
  generateImage,
  FAILURE,
};
