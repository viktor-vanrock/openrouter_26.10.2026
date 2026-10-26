import { EventEmitter } from 'node:events';
import { CacheKeys, Time } from 'librechat-data-provider';

// Real KeyvRedis adapters attach listeners to this shared client without networking.
const mockStorage = new Map<string, string>();
const mockClient = Object.assign(new EventEmitter(), {
  isOpen: true,
  connect: jest.fn(),
  scanIterator: jest.fn(),
  get: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
  set: jest.fn(async (key: string, value: string) => {
    mockStorage.set(key, value);
  }),
});
mockClient.setMaxListeners(0);

jest.mock('../../redisClients', () => ({ keyvRedisClient: mockClient, ioredisClient: null }));
jest.mock('../../cacheConfig', () => ({
  cacheConfig: {
    FORCED_IN_MEMORY_CACHE_NAMESPACES: [],
    REDIS_KEY_PREFIX: 'test',
    GLOBAL_PREFIX_SEPARATOR: '>>',
  },
}));
jest.mock('../../redisUtils', () => ({ batchDeleteKeys: jest.fn(), scanKeys: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  jest.resetModules();
  mockClient.removeAllListeners();
  mockClient.set.mockClear();
  mockStorage.clear();
});

test('repeated token config lookups attach one set of Redis listeners', async () => {
  const { standardCache, tokenConfigCache } = await import('../../cacheFactory');
  const first = tokenConfigCache();
  for (let i = 0; i < 100; i++) tokenConfigCache();
  expect(mockClient.listenerCount('reconnecting')).toBe(1);
  expect(mockClient.listenerCount('connect')).toBe(1);
  expect(mockClient.listenerCount('disconnect')).toBe(1);
  expect(standardCache(CacheKeys.TOKEN_CONFIG, Time.THIRTY_MINUTES)).toBe(first);
});

test('separate namespaces and TTLs keep their own cache settings', async () => {
  const { standardCache } = await import('../../cacheFactory');
  const short = standardCache('one', 500);
  const long = standardCache('one', 5000);
  const other = standardCache('two', 500);
  expect(short).not.toBe(long);
  expect(short).not.toBe(other);
  expect(short.ttl).toBe(500);
  expect(long.ttl).toBe(5000);
  expect(other.namespace).toBe('two');
  expect(short.namespace).toBe('one');
  expect(standardCache('one', 500)).toBe(short);
  expect(standardCache('one', 5000)).toBe(long);
  expect(standardCache('two', 500)).toBe(other);
  expect(standardCache('one')).not.toBe(short);
  expect(mockClient.listenerCount('reconnecting')).toBe(4);
});

test('namespace-aware clear preserves the existing Redis key pattern', async () => {
  const { standardCache } = await import('../../cacheFactory');
  const { scanKeys, batchDeleteKeys } = await import('../../redisUtils');
  jest.mocked(scanKeys).mockResolvedValue(['test>>one:key']);
  const cache = standardCache('one');
  await cache.clear();
  expect(scanKeys).toHaveBeenCalledWith(mockClient, 'test>>one:*');
  expect(batchDeleteKeys).toHaveBeenCalledWith(mockClient, ['test>>one:key']);
});

test('reused Redis caches preserve data sharing, namespace isolation and write TTL', async () => {
  const { standardCache } = await import('../../cacheFactory');
  const first = standardCache('one', 5000);
  const other = standardCache('two', 5000);
  await first.set('key', { value: 'one' });
  await other.set('key', { value: 'two' });
  for (let i = 0; i < 100; i++) {
    expect(await standardCache('one', 5000).get('key')).toEqual({ value: 'one' });
    expect(await standardCache('two', 5000).get('key')).toEqual({ value: 'two' });
  }
  expect(mockClient.set).toHaveBeenCalledWith('test>>one:key', expect.any(String), { PX: 5000 });
  expect(mockClient.set).toHaveBeenCalledWith('test>>two:key', expect.any(String), { PX: 5000 });
  expect(mockClient.listenerCount('reconnecting')).toBe(2);
});
