import { parsePrototypeCommand, type PrototypeWorkerEvent } from '../contracts';
import {
  parsePrototypeCommandV2,
  PROTOTYPE_COMMAND_STREAM_V2,
  type PrototypeCommandV2,
} from '../contracts.v2';

export const COMMAND_STREAM = 'prototype.commands.v1';
export const EVENT_STREAM = 'prototype.events.v1';

export class RedisPrototypeStreams {
  constructor(private readonly redis: any, private readonly group = 'prototype-workers') {}

  async ensureGroup(): Promise<void> {
    try { await this.redis.xgroup('CREATE', COMMAND_STREAM, this.group, '0', 'MKSTREAM'); } catch (error) {
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
  }

  async publishEvent(event: PrototypeWorkerEvent): Promise<void> {
    await this.redis.xadd(EVENT_STREAM, '*', 'event', JSON.stringify(event));
  }

  async acknowledge(streamId: string): Promise<void> {
    await this.redis.xack(COMMAND_STREAM, this.group, streamId);
  }

  parse(fields: string[]): ReturnType<typeof parsePrototypeCommand> {
    const index = fields.indexOf('command');
    if (index < 0) throw new Error('Redis command payload missing');
    return parsePrototypeCommand(JSON.parse(fields[index + 1]));
  }
}

type RedisStreamItem<TCommand> = { streamId: string; command: TCommand };

type CommandSourceOptions = {
  group?: string;
  claimIdleMs?: number;
  blockMs?: number;
};

class RedisCommandSource<TCommand> {
  private closed = false;

  constructor(
    private readonly redis: any,
    private readonly consumer: string,
    private readonly stream: string,
    private readonly parser: (value: unknown) => TCommand,
    private readonly options: CommandSourceOptions = {},
  ) {}

  private get group() { return this.options.group ?? 'prototype-workers'; }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.stream, this.group, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
  }

  private item(entry: unknown): RedisStreamItem<TCommand> | null {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) return null;
    const index = entry[1].indexOf('command');
    if (index < 0 || typeof entry[1][index + 1] !== 'string') {
      throw new Error('Redis command payload missing');
    }
    return { streamId: entry[0], command: this.parser(JSON.parse(entry[1][index + 1])) };
  }

  async next(): Promise<RedisStreamItem<TCommand> | null> {
    if (this.closed) return null;
    const reclaimed = await this.redis.xautoclaim(
      this.stream,
      this.group,
      this.consumer,
      this.options.claimIdleMs ?? 60_000,
      '0-0',
      'COUNT',
      1,
    );
    const reclaimedItem = this.item(reclaimed?.[1]?.[0]);
    if (reclaimedItem) return reclaimedItem;
    if (this.closed) return null;
    const result = await this.redis.xreadgroup(
      'GROUP',
      this.group,
      this.consumer,
      'COUNT',
      1,
      'BLOCK',
      this.options.blockMs ?? 5_000,
      'STREAMS',
      this.stream,
      '>',
    );
    return this.item(result?.[0]?.[1]?.[0]);
  }

  async acknowledge(streamId: string): Promise<void> {
    await this.redis.xack(this.stream, this.group, streamId);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Redis Streams consumer-group reader with stale pending-entry reclaim. */
export class RedisPrototypeCommandSource extends RedisCommandSource<ReturnType<typeof parsePrototypeCommand>> {
  constructor(
    redis: any,
    consumer: string,
    options: CommandSourceOptions = {},
  ) {
    super(redis, consumer, COMMAND_STREAM, parsePrototypeCommand, options);
  }
}

/** Strict v2 command reader used by the isolated Prototype Service. */
export class RedisPrototypeCommandSourceV2 extends RedisCommandSource<PrototypeCommandV2> {
  constructor(
    redis: any,
    consumer: string,
    options: CommandSourceOptions = {},
  ) {
    super(redis, consumer, PROTOTYPE_COMMAND_STREAM_V2, parsePrototypeCommandV2, options);
  }
}
