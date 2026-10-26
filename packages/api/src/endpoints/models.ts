import crypto from 'crypto';
import zlib from 'zlib';
import axios from 'axios';
import { logger } from '@librechat/data-schemas';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  Time,
  CacheKeys,
  KnownEndpoints,
  EModelEndpoint,
  defaultModels,
} from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { ModelInfo } from 'librechat-data-provider';
import {
  processModelData,
  extractBaseURL,
  isUserProvided,
  resolveHeaders,
  deriveBaseURL,
  logAxiosError,
  inputSchema,
} from '~/utils';
import { standardCache, tokenConfigCache } from '~/cache';

export interface FetchModelsParams {
  /** User ID for API requests */
  user?: string;
  /** API key for authentication */
  apiKey: string;
  /** Base URL for the API */
  baseURL?: string;
  /** Endpoint name (defaults to 'openAI') */
  name?: string;
  /** Whether directEndpoint was configured */
  direct?: boolean;
  /** Whether to fetch from Azure */
  azure?: boolean;
  /** Whether to send user ID as query parameter */
  userIdQuery?: boolean;
  /** Whether to create token configuration from API response */
  createTokenConfig?: boolean;
  /** Cache key for token configuration (uses name if omitted) */
  tokenKey?: string;
  /** Optional headers for the request */
  headers?: Record<string, string> | null;
  /** Optional user object for header resolution */
  userObject?: Partial<IUser>;
  /** Skip MODEL_QUERIES cache (e.g., for user-provided keys) */
  skipCache?: boolean;
}

/**
 * Fetches Ollama models from the specified base API path.
 * @param baseURL - The Ollama server URL
 * @param options - Optional configuration
 * @returns Promise resolving to array of model names
 */
async function fetchOllamaModels(
  baseURL: string,
  options: { headers?: Record<string, string> | null; user?: Partial<IUser> } = {},
): Promise<string[]> {
  if (!baseURL) {
    return [];
  }

  const ollamaEndpoint = deriveBaseURL(baseURL);

  const resolvedHeaders = resolveHeaders({
    headers: options.headers ?? undefined,
    user: options.user,
  });

  const response = await axios.get<{ models: Array<{ name: string }> }>(
    `${ollamaEndpoint}/api/tags`,
    {
      headers: resolvedHeaders,
      timeout: 5000,
    },
  );

  return response.data.models.map((tag) => tag.name);
}

/**
 * Splits a string by commas and trims each resulting value.
 * @param input - The input string to split.
 * @returns An array of trimmed values.
 */
export function splitAndTrim(input: string | null | undefined): string[] {
  if (!input || typeof input !== 'string') {
    return [];
  }
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Decodes response body handling gzip/deflate/brotli and validates it's JSON.
 * Used as axios `transformResponse` for /models endpoint where some proxies
 * return compressed bodies without proper Content-Encoding or ignore Accept-Encoding.
 */
function decodeModelsResponse(
  data: Buffer | ArrayBuffer | undefined,
  responseHeaders: Record<string, string> | undefined,
): unknown {
  try {
    if (!data) {
      throw new Error('Empty response body');
    }

    const buf: Buffer = Buffer.isBuffer(data) ? (data as Buffer) : Buffer.from(data as ArrayBuffer);

    if (buf.length === 0) {
      throw new Error('Empty response buffer');
    }

    const encoding = String(responseHeaders?.['content-encoding'] ?? '')
      .toLowerCase()
      .trim();

    const isGzipMagic = buf[0] === 0x1f && buf[1] === 0x8b;
    const isDeflateMagic =
      buf[0] === 0x78 && (buf[1] === 0x9c || buf[1] === 0xda || buf[1] === 0x01);

    let decoded: Buffer;
    if (encoding === 'gzip' || isGzipMagic) {
      decoded = zlib.gunzipSync(buf);
    } else if (encoding === 'br') {
      decoded = zlib.brotliDecompressSync(buf);
    } else if (encoding === 'deflate' || isDeflateMagic) {
      try {
        decoded = zlib.inflateSync(buf);
      } catch {
        decoded = zlib.inflateRawSync(buf);
      }
    } else {
      decoded = buf;
    }

    const text = decoded.toString('utf-8').trim();
    if (!text) {
      throw new Error('Decoded response is empty');
    }

    if (text.startsWith('<')) {
      throw new Error(`Expected JSON, got HTML (probably an error page): ${text.slice(0, 200)}`);
    }

    return JSON.parse(text);
  } catch (e) {
    const preview =
      data && (data as Buffer).length
        ? Buffer.from(data as ArrayBuffer)
            .slice(0, 64)
            .toString('hex')
        : 'empty';
    throw new Error(
      `Failed to parse models response: ${(e as Error).message} (first bytes: ${preview})`,
    );
  }
}

/**
 * Fetches models from the specified base API path or Azure, based on the provided configuration.
 *
 * @param params - The parameters for fetching the models.
 * @returns A promise that resolves to an array of model identifiers.
 */
export async function fetchModels({
  user,
  apiKey,
  baseURL: _baseURL,
  name = EModelEndpoint.openAI,
  direct = false,
  azure = false,
  userIdQuery = false,
  createTokenConfig = true,
  tokenKey,
  headers,
  userObject,
  skipCache = false,
}: FetchModelsParams): Promise<string[]> {
  let models: string[] = [];
  const baseURL = direct ? extractBaseURL(_baseURL ?? '') : _baseURL;

  if (!baseURL && !azure) {
    return models;
  }

  if (!apiKey) {
    return models;
  }

  const shouldCache = !skipCache && !(userIdQuery && user);
  const cacheKey = shouldCache ? modelsCacheKey(baseURL ?? '', apiKey) : '';
  const modelsCache = shouldCache ? standardCache(CacheKeys.MODEL_QUERIES) : null;
  if (modelsCache && cacheKey) {
    const cachedModels = await modelsCache.get(cacheKey);
    if (cachedModels) {
      return cachedModels as string[];
    }
  }

  if (name && name.toLowerCase().startsWith(KnownEndpoints.ollama)) {
    let ollamaModels: string[] | null = null;
    try {
      ollamaModels = await fetchOllamaModels(baseURL ?? '', { headers, user: userObject });
    } catch (ollamaError) {
      logAxiosError({
        message:
          'Failed to fetch models from Ollama API. Attempting to fetch via OpenAI-compatible endpoint.',
        error: ollamaError as Error,
      });
    }
    if (ollamaModels !== null) {
      if (modelsCache && cacheKey && ollamaModels.length > 0) {
        await modelsCache.set(cacheKey, ollamaModels, Time.TWO_MINUTES);
      }
      return ollamaModels;
    }
  }

  try {
    const options: {
      headers: Record<string, string>;
      timeout: number;
      httpsAgent?: HttpsProxyAgent<string>;
    } = {
      headers: {
        ...(headers ?? {}),
      },
      timeout: 5000,
    };

    if (name === EModelEndpoint.anthropic) {
      options.headers = {
        'x-api-key': apiKey,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      };
    } else {
      options.headers.Authorization = `Bearer ${apiKey}`;
    }

    if (process.env.PROXY) {
      options.httpsAgent = new HttpsProxyAgent(process.env.PROXY);
    }

    if (process.env.OPENAI_ORGANIZATION && baseURL?.includes('openai')) {
      options.headers['OpenAI-Organization'] = process.env.OPENAI_ORGANIZATION;
    }

    const url = new URL(`${(baseURL ?? '').replace(/\/+$/, '')}${azure ? '' : '/models'}`);
    if (user && userIdQuery) {
      url.searchParams.append('user', user);
    }

    const res = await axios.get(url.toString(), {
      ...options,
      responseType: 'arraybuffer',
      decompress: false,
      transformResponse: [
        (data, responseHeaders) =>
          decodeModelsResponse(
            data as Buffer | ArrayBuffer | undefined,
            responseHeaders as Record<string, string> | undefined,
          ),
      ],
    });

    const input = res.data;

    if (!input || !Array.isArray(input.data)) {
      logger.warn(
        `Unexpected models response shape from ${name}: ${
          typeof input === 'object' ? JSON.stringify(input)?.slice(0, 300) : String(input)
        }`,
      );
      return models;
    }

    const validationResult = inputSchema.safeParse(input);
    if (validationResult.success && createTokenConfig) {
      const endpointTokenConfig = processModelData(input);
      await tokenConfigCache().set(tokenKey ?? name, endpointTokenConfig);
    }
    models = input.data.map((item: { id: string }) => item.id);
  } catch (error) {
    const logMessage = `Failed to fetch models from ${azure ? 'Azure ' : ''}${name} API`;
    logAxiosError({ message: logMessage, error: error as Error });
  }

  if (modelsCache && cacheKey && models.length > 0) {
    await modelsCache.set(cacheKey, models, Time.TWO_MINUTES);
  }

  return models;
}

function modelsCacheKey(baseURL: string, apiKey: string): string {
  return crypto.createHash('sha256').update(`${baseURL}:${apiKey}`).digest('hex').slice(0, 32);
}

/** Fetches provider metadata used for capability-aware model selection. */
export async function fetchModelInfo(params: FetchModelsParams): Promise<ModelInfo[]> {
  const { apiKey, name = EModelEndpoint.openAI } = params;
  const baseURL = params.direct ? extractBaseURL(params.baseURL ?? '') : params.baseURL;
  if (!baseURL || !apiKey || name.toLowerCase().startsWith(KnownEndpoints.ollama)) {
    return [];
  }

  try {
    const headers: Record<string, string> = {
      ...(resolveHeaders({ headers: params.headers ?? undefined, user: params.userObject }) ?? {}),
    };
    if (name === EModelEndpoint.anthropic) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = process.env.ANTHROPIC_VERSION || '2023-06-01';
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const options: {
      headers: Record<string, string>;
      timeout: number;
      responseType: 'arraybuffer';
      decompress: false;
      transformResponse: Array<
        (
          data: Buffer | ArrayBuffer | undefined,
          responseHeaders: Record<string, string> | undefined,
        ) => unknown
      >;
      httpsAgent?: HttpsProxyAgent<string>;
    } = {
      headers,
      timeout: 5000,
      responseType: 'arraybuffer',
      decompress: false,
      transformResponse: [(data, responseHeaders) => decodeModelsResponse(data, responseHeaders)],
    };
    if (process.env.PROXY) {
      options.httpsAgent = new HttpsProxyAgent(process.env.PROXY);
    }
    const url = new URL(`${baseURL.replace(/\/+$/, '')}/models`);
    if (params.user && params.userIdQuery) {
      url.searchParams.append('user', params.user);
    }
    const response = await axios.get(url.toString(), options);
    const input = response.data as { data?: ModelInfo[] };
    if (!Array.isArray(input?.data)) {
      return [];
    }
    return input.data.reduce<ModelInfo[]>((result, model) => {
      if (typeof model?.id !== 'string') {
        return result;
      }
      result.push({
        id: model.id,
        supported_parameters: Array.isArray(model.supported_parameters)
          ? model.supported_parameters.filter((parameter) => typeof parameter === 'string')
          : undefined,
      });
      return result;
    }, []);
  } catch (error) {
    logAxiosError({
      message: `Failed to fetch model capabilities from ${name} API`,
      error: error as Error,
    });
    return [];
  }
}

/** Options for fetching OpenAI models */
export interface GetOpenAIModelsOptions {
  /** User ID for API requests */
  user?: string;
  /** Whether to fetch from Azure */
  azure?: boolean;
  /** Whether to fetch models for the Assistants endpoint */
  assistants?: boolean;
  /** OpenAI API key (if not using environment variable) */
  openAIApiKey?: string;
  /** Skip MODEL_QUERIES cache (e.g., for user-provided keys) */
  skipCache?: boolean;
}

function resolveOpenAIApiKey(opts: GetOpenAIModelsOptions): string | undefined {
  return opts.openAIApiKey || process.env.OPENAI_API_KEY;
}

/**
 * Fetches models from OpenAI or Azure based on the provided options.
 * @param opts - Options for fetching models
 * @param _models - Fallback models array
 * @returns Promise resolving to array of model IDs
 */
export async function fetchOpenAIModels(
  opts: GetOpenAIModelsOptions,
  _models: string[] = [],
): Promise<string[]> {
  let models = _models.slice() ?? [];
  const apiKey = resolveOpenAIApiKey(opts);
  const openaiBaseURL = 'https://api.openai.com/v1';
  let baseURL = openaiBaseURL;
  let reverseProxyUrl = process.env.OPENAI_REVERSE_PROXY;

  if (opts.assistants && process.env.ASSISTANTS_BASE_URL) {
    reverseProxyUrl = process.env.ASSISTANTS_BASE_URL;
  } else if (opts.azure) {
    return models;
  }

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl) ?? openaiBaseURL;
  }

  if (baseURL || opts.azure) {
    models = await fetchModels({
      apiKey: apiKey ?? '',
      baseURL,
      azure: opts.azure,
      user: opts.user,
      name: EModelEndpoint.openAI,
      skipCache: opts.skipCache,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  if (baseURL === openaiBaseURL) {
    const regex = /(text-davinci-003|gpt-|o\d+)/;
    const excludeRegex = /audio|realtime/;
    models = models.filter((model) => regex.test(model) && !excludeRegex.test(model));
    const instructModels = models.filter((model) => model.includes('instruct'));
    const otherModels = models.filter((model) => !model.includes('instruct'));
    models = otherModels.concat(instructModels);
  }

  return models;
}

/**
 * Loads the default models for OpenAI or Azure.
 * @param opts - Options for getting models
 * @returns Promise resolving to array of model IDs
 */
export async function getOpenAIModels(opts: GetOpenAIModelsOptions = {}): Promise<string[]> {
  let models = defaultModels[EModelEndpoint.openAI];

  if (opts.assistants) {
    models = defaultModels[EModelEndpoint.assistants];
  } else if (opts.azure) {
    models = defaultModels[EModelEndpoint.azureAssistants];
  }

  let key: string;
  if (opts.assistants) {
    key = 'ASSISTANTS_MODELS';
  } else if (opts.azure) {
    key = 'AZURE_OPENAI_MODELS';
  } else {
    key = 'OPENAI_MODELS';
  }

  if (process.env[key]) {
    return splitAndTrim(process.env[key]);
  }

  if (isUserProvided(resolveOpenAIApiKey(opts))) {
    return models;
  }

  return await fetchOpenAIModels(opts, models);
}

/**
 * Fetches models from the Anthropic API.
 * @param opts - Options for fetching models
 * @param _models - Fallback models array
 * @returns Promise resolving to array of model IDs
 */
export async function fetchAnthropicModels(
  opts: { user?: string; skipCache?: boolean } = {},
  _models: string[] = [],
): Promise<string[]> {
  let models = _models.slice() ?? [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropicBaseURL = 'https://api.anthropic.com/v1';
  let baseURL = anthropicBaseURL;
  const reverseProxyUrl = process.env.ANTHROPIC_REVERSE_PROXY;

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl) ?? anthropicBaseURL;
  }

  if (!apiKey) {
    return models;
  }

  if (baseURL) {
    models = await fetchModels({
      apiKey,
      baseURL,
      user: opts.user,
      name: EModelEndpoint.anthropic,
      tokenKey: EModelEndpoint.anthropic,
      skipCache: opts.skipCache,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  return models;
}

/**
 * Gets Anthropic models from environment or API.
 * @param opts - Options for fetching models
 * @returns Promise resolving to array of model IDs
 */
export async function getAnthropicModels(
  opts: { user?: string; vertexModels?: string[] } = {},
): Promise<string[]> {
  const models = defaultModels[EModelEndpoint.anthropic];

  // Vertex AI models from YAML config take priority
  if (opts.vertexModels && opts.vertexModels.length > 0) {
    return opts.vertexModels;
  }

  if (process.env.ANTHROPIC_MODELS) {
    return splitAndTrim(process.env.ANTHROPIC_MODELS);
  }

  if (isUserProvided(process.env.ANTHROPIC_API_KEY)) {
    return models;
  }

  try {
    return await fetchAnthropicModels(opts, models);
  } catch (error) {
    logger.error('Error fetching Anthropic models:', error);
    return models;
  }
}

/**
 * Gets Google models from environment or defaults.
 * @returns Array of model IDs
 */
export function getGoogleModels(): string[] {
  let models = defaultModels[EModelEndpoint.google];
  if (process.env.GOOGLE_MODELS) {
    models = splitAndTrim(process.env.GOOGLE_MODELS);
  }
  return models;
}

/**
 * Gets Bedrock models from environment or defaults.
 * @returns Array of model IDs
 */
export function getBedrockModels(): string[] {
  let models = defaultModels[EModelEndpoint.bedrock];
  if (process.env.BEDROCK_AWS_MODELS) {
    models = splitAndTrim(process.env.BEDROCK_AWS_MODELS);
  }
  return models;
}
