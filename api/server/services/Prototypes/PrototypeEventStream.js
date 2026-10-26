const EVENT_STREAM = 'prototype.events.v1';
const EVENT_STREAM_V2 = 'prototype.events.v2';

class PrototypeRedisEventSource {
  constructor({ redis, consumer, group = 'prototype-control-plane', claimIdleMs = 60_000, blockMs = 5_000, parseEvent, stream = EVENT_STREAM }) {
    this.redis = redis;
    this.consumer = consumer;
    this.group = group;
    this.claimIdleMs = claimIdleMs;
    this.blockMs = blockMs;
    this.parseEvent = parseEvent;
    this.stream = stream;
    this.closed = false;
  }

  async ensureGroup() {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM');
    } catch (error) {
      if (!error?.message?.includes('BUSYGROUP')) throw error;
    }
  }

  parse(entry) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return null;
    const index = entry[1].indexOf('event');
    if (index < 0 || typeof entry[1][index + 1] !== 'string') throw new Error('Redis event payload missing');
    const value = JSON.parse(entry[1][index + 1]);
    return { streamId: entry[0], event: this.parseEvent ? this.parseEvent(value) : value };
  }

  async next() {
    if (this.closed) return null;
    const reclaimed = await this.redis.xautoclaim(
      this.stream, this.group, this.consumer, this.claimIdleMs, '0-0', 'COUNT', 1,
    );
    const pending = this.parse(reclaimed?.[1]?.[0]);
    if (pending) return pending;
    const response = await this.redis.xreadgroup(
      'GROUP', this.group, this.consumer, 'COUNT', 1, 'BLOCK', this.blockMs,
      'STREAMS', this.stream, '>',
    );
    return this.parse(response?.[0]?.[1]?.[0]);
  }

  async acknowledge(streamId) {
    await this.redis.xack(this.stream, this.group, streamId);
  }

  async close() { this.closed = true; }
}

class PrototypeRedisEventSourceV2 extends PrototypeRedisEventSource {
  constructor(options) { super({ ...options, stream: EVENT_STREAM_V2 }); }
}

function abortableDelay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function runPrototypeEventLoop({
  source, consumer, signal, onError, ensureGroup = true, errorDelayMs = 1_000,
}) {
  if (ensureGroup) await source.ensureGroup();
  while (!signal.aborted) {
    try {
      const item = await source.next();
      if (!item) continue;
      await consumer.consume(item.streamId, item.event);
      await source.acknowledge?.(item.streamId);
    } catch (error) {
      if (signal.aborted) return;
      onError?.(error);
      await abortableDelay(errorDelayMs, signal);
    }
  }
}

module.exports = {
  EVENT_STREAM,
  EVENT_STREAM_V2,
  PrototypeRedisEventSource,
  PrototypeRedisEventSourceV2,
  runPrototypeEventLoop,
};
