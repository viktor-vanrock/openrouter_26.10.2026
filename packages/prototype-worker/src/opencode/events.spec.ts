import { waitForTurnIdle } from './events';

async function* events() {
  yield {
    type: 'message.updated',
    properties: { info: { id: 'assistant_1', role: 'assistant', sessionID: 'session_1' } },
  };
  yield {
    type: 'message.part.updated',
    properties: {
      sessionID: 'session_1',
      part: { messageID: 'assistant_1', type: 'text', text: 'Hello ' },
    },
  };
  yield {
    type: 'message.part.updated',
    properties: {
      sessionID: 'session_1',
      part: { messageID: 'assistant_1', type: 'text', text: 'world' },
    },
  };
  yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
}

describe('waitForTurnIdle', () => {
  it('replaces cumulative updates and returns only the final assistant message', async () => {
    async function* cumulative() {
      yield {
        type: 'message.updated',
        properties: { info: { id: 'a', role: 'assistant', sessionID: 's' } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p', messageID: 'a', sessionID: 's', type: 'text', text: 'Working' },
        },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p', messageID: 'a', sessionID: 's', type: 'text', text: 'Working on it' },
        },
      };
      yield {
        type: 'message.updated',
        properties: { info: { id: 'b', role: 'assistant', sessionID: 's' } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          part: { id: 'q', messageID: 'b', sessionID: 's', type: 'text', text: 'Ready' },
        },
      };
      yield { type: 'session.idle', properties: { sessionID: 's' } };
    }
    await expect(waitForTurnIdle(cumulative(), 's', jest.fn())).resolves.toBe('Ready');
  });
  it('scopes events to the session and returns the final assistant text', async () => {
    const progress: string[] = [];
    await expect(
      waitForTurnIdle(events(), 'session_1', (value) => progress.push(value)),
    ).resolves.toBe('Hello world');
    expect(progress).toContain('Hello world');
  });

  it('collects assistant text when message metadata uses its session identifier', async () => {
    async function* scopedEvents() {
      yield {
        type: 'message.updated',
        properties: { info: { id: 'assistant_1', role: 'assistant', sessionID: 'session_1' } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          part: { messageID: 'assistant_1', sessionID: 'session_1', type: 'text', text: 'answer' },
        },
      };
      yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
    }

    await expect(waitForTurnIdle(scopedEvents(), 'session_1', jest.fn())).resolves.toBe('answer');
  });

  it('ignores message metadata and text belonging to another session', async () => {
    async function* mixedEvents() {
      yield {
        type: 'message.updated',
        properties: { info: { id: 'shared_message', role: 'assistant', sessionID: 'other' } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          part: {
            messageID: 'shared_message',
            sessionID: 'session_1',
            type: 'text',
            text: 'ignore',
          },
        },
      };
      yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
    }

    await expect(waitForTurnIdle(mixedEvents(), 'session_1', jest.fn())).resolves.toBe('');
  });

  it('ignores unscoped message metadata even when a scoped part reuses its ID', async () => {
    async function* unscopedEvents() {
      yield {
        type: 'message.updated',
        properties: { info: { id: 'shared_message', role: 'assistant' } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          part: {
            messageID: 'shared_message',
            sessionID: 'session_1',
            type: 'text',
            text: 'ignore',
          },
        },
      };
      yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
    }

    await expect(waitForTurnIdle(unscopedEvents(), 'session_1', jest.fn())).resolves.toBe('');
  });

  it('reports reasoning, tool and retry activity without adding them to the final answer', async () => {
    async function* activityEvents() {
      yield {
        type: 'message.updated',
        properties: { info: { id: 'assistant_1', role: 'assistant', sessionID: 'session_1' } },
      };
      yield {
        type: 'session.status',
        properties: { sessionID: 'session_1', status: { type: 'retry', attempt: 2 } },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session_1',
          part: { messageID: 'assistant_1', type: 'reasoning', text: 'thinking' },
        },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session_1',
          part: {
            messageID: 'assistant_1',
            type: 'tool',
            tool: 'write',
            state: { status: 'running', title: 'Writing page' },
          },
        },
      };
      yield {
        type: 'message.part.updated',
        properties: {
          sessionID: 'session_1',
          part: { messageID: 'assistant_1', type: 'text', text: 'answer' },
        },
      };
      yield { type: 'session.idle', properties: { sessionID: 'session_1' } };
    }
    const activity: Array<[string, string | undefined]> = [];

    await expect(
      waitForTurnIdle(activityEvents(), 'session_1', (value, kind) => activity.push([value, kind])),
    ).resolves.toBe('answer');

    expect(activity).toEqual(
      expect.arrayContaining([
        ['Retrying model request (attempt 2)', 'status'],
        ['thinking', 'reasoning'],
        ['running: Writing page', 'tool'],
      ]),
    );
  });

  it('rejects the turn when OpenCode publishes a scoped session error', async () => {
    async function* errorEvents() {
      yield {
        type: 'session.error',
        properties: {
          sessionID: 'session_1',
          error: { data: { message: 'upstream unavailable' } },
        },
      };
    }

    await expect(waitForTurnIdle(errorEvents(), 'session_1', jest.fn())).rejects.toThrow(
      'upstream unavailable',
    );
  });
});
