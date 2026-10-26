import assert from 'node:assert/strict';
import test from 'node:test';
import {
  probeStorybookMcp,
  storybookAgentConfiguration,
  STORYBOOK_MCP_URL,
} from '../src/storybook-mcp.js';

test('legacy MCP probe consumes fragmented SSE replies without waiting for stream closure, sends no new-server token and never follows redirects', async () => {
  const token = 'private-storybook-fixture';
  let calls = 0,
    deleted = false;
  const fetchImpl = async (url, options) => {
    assert.equal(url, STORYBOOK_MCP_URL);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect === 'manual' || options.redirect === 'error', true);
    if (options.method === 'DELETE') {
      deleted = true;
      return new Response(null, { status: 202 });
    }
    const rpc = JSON.parse(options.body);
    calls++;
    if (!rpc.id) return new Response(null, { status: 202 });
    const result =
      rpc.method === 'initialize'
        ? { protocolVersion: '2025-03-26' }
        : rpc.method === 'tools/list'
          ? {
              tools: [
                'list-all-documentation',
                'get-documentation',
                'get-documentation-for-story',
              ].map((name) => ({ name })),
            }
          : { content: [{ type: 'text', text: 'UI Kit component documentation' }] };
    const wire = `data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from(wire.slice(0, 17)));
          controller.enqueue(Buffer.from(wire.slice(17)));
          // Real Storybook can leave its SSE connection open after the reply.
        },
      }),
      { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'fixture-session' } },
    );
  };
  const result = await probeStorybookMcp({ token, fetchImpl });
  assert.equal(result.passed, true);
  assert.equal(calls, 4);
  assert.equal(deleted, true);
  assert.ok(!JSON.stringify(result).includes(token));
  let redirects = 0;
  await assert.rejects(
    probeStorybookMcp({
      token,
      fetchImpl: async () => {
        redirects++;
        return new Response(null, {
          status: 307,
          headers: { location: 'https://foreign.example/mcp?private=secret' },
        });
      },
    }),
    (error) =>
      error.message === 'STORYBOOK_MCP_HTTP_307' &&
      error.redirectLocation === 'https://foreign.example/mcp',
  );
  assert.equal(redirects, 1);
});

test('legacy agent MCP config contains only the exact server and read tools without forwarding the new credential', () => {
  const config = storybookAgentConfiguration({ STORYBOOK_MCP_TOKEN: 'private-fixture' });
  assert.equal(config.mcp.storybook.url, STORYBOOK_MCP_URL);
  assert.equal(config.permission['storybook_*'], 'deny');
  assert.equal(config.permission['storybook_list-all-documentation'], 'allow');
  assert.ok(!JSON.stringify(config).includes('private-fixture'));
  assert.equal(storybookAgentConfiguration({}).mcp.storybook.headers, undefined);
});
