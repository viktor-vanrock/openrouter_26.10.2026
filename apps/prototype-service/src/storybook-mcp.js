/** Trusted, exact-origin Storybook connection. Never writes the bearer into source/config/evidence. */
export const STORYBOOK_MCP_URL = 'https://storybook.ekim-evgeny.ru/mcp';
export const STORYBOOK_READ_TOOLS = [
  'list-all-documentation',
  'get-documentation',
  'get-documentation-for-story',
];

export function storybookAgentConfiguration() {
  return {
    mcp: {
      storybook: {
        type: 'remote',
        url: STORYBOOK_MCP_URL,
        enabled: true,
        oauth: false,
        timeout: 45000,
      },
    },
    permission: {
      'storybook_*': 'deny',
      ...Object.fromEntries(STORYBOOK_READ_TOOLS.map((name) => [`storybook_${name}`, 'allow'])),
    },
  };
}

export async function probeStorybookMcp({ fetchImpl = fetch } = {}) {
  let sessionId,
    protocol = '2025-03-26';
  let phase = 'initialize';
  const headers = () => ({
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocol,
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  });
  async function rpc(body) {
    const response = await fetchImpl(STORYBOOK_MCP_URL, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(45000),
    });
    if (response.status >= 300 && response.status < 400) {
      let location, sameTarget, queryKeys;
      try {
        const url = new URL(response.headers.get('location'), STORYBOOK_MCP_URL);
        location = url.origin + url.pathname;
        sameTarget = url.href === STORYBOOK_MCP_URL;
        queryKeys = [...url.searchParams.keys()];
      } catch {
        location = 'invalid';
      }
      await response.body?.cancel();
      throw Object.assign(new Error(`STORYBOOK_MCP_HTTP_${response.status}`), {
        redirectLocation: location,
        sameTarget,
        queryKeys,
        server: response.headers.get('server'),
      });
    }
    if (!response.ok) throw new Error(`STORYBOOK_MCP_HTTP_${response.status}`);
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    if (sessionId && (sessionId.length > 512 || /[\r\n]/.test(sessionId)))
      throw new Error('STORYBOOK_MCP_SESSION_INVALID');
    if (!body.id) {
      await response.body?.cancel();
      return;
    }
    const chunks = [];
    let bytes = 0,
      value;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('STORYBOOK_MCP_PROTOCOL_FAILED');
    try {
      while (!value) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 1024 * 1024) throw new Error('STORYBOOK_MCP_RESPONSE_LIMIT');
        chunks.push(Buffer.from(next.value));
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          value = JSON.parse(text);
        } catch {
          const events = text.replaceAll('\r\n', '\n').split('\n\n');
          // A reply event completes the RPC even when the SSE connection remains open.
          for (const event of events.slice(0, -1)) {
            const data = event
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const parsed = JSON.parse(data);
            if (parsed.id === body.id) {
              value = parsed;
              break;
            }
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (value?.id !== body.id || value.error || !value.result)
      throw new Error('STORYBOOK_MCP_PROTOCOL_FAILED');
    return value.result;
  }
  try {
    const init = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: protocol,
        capabilities: {},
        clientInfo: { name: 'chatrouter-gateway-probe', version: '1' },
      },
    });
    if (!['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(init.protocolVersion))
      throw new Error('STORYBOOK_MCP_PROTOCOL_UNSUPPORTED');
    protocol = init.protocolVersion;
    phase = 'initialized';
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    phase = 'tools/list';
    const inventory = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = inventory.tools?.map((tool) => tool.name);
    if (
      !Array.isArray(names) ||
      names.length > 100 ||
      names.some((name) => !/^[\w-]{1,128}$/.test(name)) ||
      STORYBOOK_READ_TOOLS.some((name) => !names.includes(name))
    )
      throw new Error('STORYBOOK_MCP_TOOLS_MISSING');
    phase = 'tools/call';
    const docs = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'list-all-documentation',
        arguments: { withStoryIds: false },
      },
    });
    const documentationBytes = (docs.content ?? [])
      .filter((item) => item.type === 'text')
      .reduce((sum, item) => sum + Buffer.byteLength(item.text ?? ''), 0);
    if (docs.isError || documentationBytes === 0)
      throw new Error('STORYBOOK_MCP_DOCUMENTATION_FAILED');
    return {
      passed: true,
      endpoint: STORYBOOK_MCP_URL,
      protocol,
      authenticated: false,
      tools: names,
      documentationBytes,
      checks: [
        'tls',
        'initialize',
        'initialized',
        'tools/list',
        'tools/call:list-all-documentation',
      ],
    };
  } catch (error) {
    error.phase = phase;
    throw error;
  } finally {
    if (sessionId)
      await fetchImpl(STORYBOOK_MCP_URL, {
        method: 'DELETE',
        headers: headers(),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
  }
}
