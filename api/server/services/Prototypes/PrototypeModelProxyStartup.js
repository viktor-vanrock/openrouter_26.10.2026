const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { constants } = require('node:fs');
const { PrototypeScopedModelProxy } = require('./PrototypeScopedModelProxy');
const { PrototypeJobTokenService } = require('./PrototypeJobTokenService');
const { PrototypeModelAuthority } = require('./PrototypeModelAuthority');
const { createPrototypeStreamingHttpAdapter } = require('./PrototypeStreamingHttpAdapter');
const { createPrototypeModelProxyRouter } = require('../../routes/internal/prototypeModelProxy');
const { createPrototypeTokenRouter } = require('../../routes/internal/prototypeTokens');

function validateSigningKey(value) {
  const key = crypto.createPrivateKey(value);
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('PROTOTYPE_PROXY_KEY_INVALID');
  return key;
}

async function readSigningKey(path, encoded) {
  if (encoded) {
    if (path || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 24_000) throw new Error('PROTOTYPE_PROXY_KEY_INVALID');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('PROTOTYPE_PROXY_KEY_INVALID');
    return validateSigningKey(bytes);
  }
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 16_384 ||
        typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('PROTOTYPE_PROXY_KEY_INVALID');
    return validateSigningKey(await file.readFile());
  } finally { await file.close(); }
}

async function boundedJson(response) {
  if (!response.ok || !response.body) throw new Error('PROTOTYPE_PROXY_METADATA_UNAVAILABLE');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new Error('PROTOTYPE_PROXY_METADATA_UNAVAILABLE');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function quoteAgentRequest(body, metadata) {
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (metadata?.id !== body.model || !Number.isSafeInteger(metadata.context_length) ||
      metadata.context_length < bytes + 1024 + body.max_tokens ||
      !Number.isSafeInteger(metadata.top_provider?.max_completion_tokens) ||
      metadata.top_provider.max_completion_tokens < body.max_tokens || metadata.pricing?.internal_reasoning != null) {
    throw new Error('PROTOTYPE_PROXY_METADATA_UNAVAILABLE');
  }
  const price = value => {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)) throw new Error('PROTOTYPE_PROXY_PRICE_UNKNOWN');
    return Number(value);
  };
  const pricing = metadata.pricing;
  const upper = field => Math.max(price(pricing?.[field]), ...(pricing?.overrides ?? []).map(entry =>
    entry[field] == null ? 0 : price(entry[field])));
  const input = Math.max(upper('prompt'), ...['input_cache_read', 'input_cache_write', 'input_cache_write_1h']
    .filter(key => pricing?.[key] != null).map(upper));
  return Math.ceil(((bytes + 1024) * input + body.max_tokens * upper('completion') +
    (pricing?.request == null ? 0 : upper('request'))) * 2 * 1_000_000) / 1_000_000;
}

/** Explicit opt-in; failure is contained inside optional prototype startup. No network work on config/chat paths. */
async function createPrototypeModelProxyStartup({ mongoose, getUserKeyValues, authenticateService,
  env = process.env, fetchImpl = fetch, loadBudget = () => import('@librechat/prototype-worker') }) {
  if (env.PROTOTYPE_MODEL_PROXY_ENABLED !== 'true') return null;
  if (env.NODE_ENV === 'production') require('./PrototypeControlPlaneStartup').validatePrototypeServiceAuth(env);
  const baseUrl = env.OPENROUTER_API_URL;
  const privateKey = await readSigningKey(env.PROTOTYPE_MODEL_TOKEN_PRIVATE_KEY_PATH, env.PROTOTYPE_MODEL_TOKEN_PRIVATE_KEY_BASE64);
  const previousKeys = env.PROTOTYPE_MODEL_TOKEN_PREVIOUS_PUBLIC_KEY_PATH
    ? [crypto.createPublicKey(await fs.readFile(env.PROTOTYPE_MODEL_TOKEN_PREVIOUS_PUBLIC_KEY_PATH))] : [];
  const authority = new PrototypeModelAuthority({ mongoose });
  const tokenService = new PrototypeJobTokenService({ issuer: 'chatrouter-prototype-model', privateKey,
    publicKeys: [crypto.createPublicKey(privateKey), ...previousKeys], activeLease: input => authority.active(input) });
  const { AgentTurnBudget } = await loadBudget();
  const proxy = new PrototypeScopedModelProxy({ baseUrl, budget: new AgentTurnBudget({ mongoose, jobs: mongoose.models.PrototypeJob }),
    verifyToken: token => tokenService.verify(token), authorizeClaims: async claims => !!(await authority.active(claims)),
    getUserKeyValues, requestUpstream: createPrototypeStreamingHttpAdapter({ fetchImpl }),
    quoteRequest: async ({ body, apiKey }) => {
      const metadata = await boundedJson(await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      }));
      return quoteAgentRequest(body, metadata.data?.find(model => model.id === body.model));
    },
  });
  return { proxy, authority, tokenService, modelRouter: createPrototypeModelProxyRouter({ proxy }),
    tokenRouter: createPrototypeTokenRouter({ authenticateWorker: authenticateService,
      loadExecution: input => authority.renew(input), tokenService }), close: () => proxy.close() };
}
module.exports = { createPrototypeModelProxyStartup, quoteAgentRequest, readSigningKey };
