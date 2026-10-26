export async function waitForTurnIdle(
  stream: AsyncIterable<unknown>,
  sessionId: string,
  onProgress: (value: string, kind?: 'text' | 'reasoning' | 'tool' | 'status' | 'error') => void,
  onActivity: () => void = () => undefined,
): Promise<string> {
  const roles = new Map<string, string>();
  const textParts = new Map<string, string>();
  let latestMessage: string | undefined;
  let text = '';
  for await (const value of stream) {
    const event = value as {
      type?: string;
      properties?: {
        sessionID?: string;
        status?: { type?: string; attempt?: number };
        error?: { data?: { message?: string } };
        info?: { id?: string; role?: string; sessionID?: string };
        part?: {
          id?: string;
          messageID?: string;
          sessionID?: string;
          type?: string;
          text?: string;
          tool?: string;
          state?: { title?: string; status?: string };
        };
      };
    };
    if (event.type === 'message.updated') {
      const info = event.properties?.info;
      if (info?.id && info?.role && info.sessionID === sessionId) {
        roles.set(info.id, info.role);
        onActivity();
      }
      continue;
    }
    const eventSessionId = event.properties?.sessionID ?? event.properties?.part?.sessionID;
    if (eventSessionId !== sessionId) continue;
    onActivity();
    if (event.type === 'session.status') {
      const status = event.properties?.status;
      if (status?.type === 'retry')
        onProgress(`Retrying model request (attempt ${status.attempt})`, 'status');
      else if (status?.type === 'busy') onProgress('Model is processing the request', 'status');
    }
    if (event.type === 'session.error') {
      const error = event.properties?.error;
      throw new Error(error?.data?.message || 'OpenCode session failed');
    }
    if (event.type === 'message.part.updated') {
      const part = event.properties?.part;
      if (part?.messageID && roles.get(part.messageID) === 'assistant' && part.type === 'reasoning') {
        onProgress(part.text ?? '', 'reasoning');
      }
      if (part?.messageID && roles.get(part.messageID) === 'assistant' && part.type === 'tool') {
        const label = part.state?.title || part.tool;
        if (label) onProgress(`${part.state?.status ?? 'running'}: ${label}`, 'tool');
      }
      if (part?.type === 'text' && part.messageID && roles.get(part.messageID) === 'assistant') {
        if (latestMessage !== part.messageID) {
          latestMessage = part.messageID;
          textParts.clear();
          text = '';
        }
        if (part.id) {
          textParts.set(part.id, part.text ?? '');
          text = [...textParts.values()].join('\n');
        } else {
          text += part.text ?? '';
        }
        onProgress(text, 'text');
      }
    }
    if (event.type === 'session.idle') return text;
  }
  throw new Error('OpenCode event stream ended before session idle');
}
