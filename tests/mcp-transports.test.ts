import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import { McpManager } from '../src/mcp_loader.js';
import { scratch, cleanup } from './helpers.js';
interface Request {
  id?: number;
  method: string;
  params?: { protocolVersion?: string; name?: string };
}
function result(request: Request): unknown {
  if (request.method === 'initialize')
    return {
      protocolVersion: request.params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'transport-fixture', version: '1' },
    };
  if (request.method === 'tools/list')
    return {
      tools: [
        {
          name: 'echo',
          description: 'Transport round trip.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
  if (request.method === 'tools/call')
    return { content: [{ type: 'text', text: 'actual transport response' }] };
  return {};
}
test('MCP Streamable HTTP, legacy SSE and WebSocket perform real initialization and tool calls', async (t) => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  let sse: ServerResponse | undefined;
  server.on('request', async (request, response) => {
    if (request.url === '/sse' && request.method === 'GET') {
      sse = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('event: endpoint\ndata: /messages\n\n');
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    const parsed = JSON.parse(text) as Request;
    if (parsed.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const body = { jsonrpc: '2.0', id: parsed.id, result: result(parsed) };
    if (request.url === '/messages') {
      sse!.write('event: message\ndata: ' + JSON.stringify(body) + '\n\n');
      response.writeHead(202).end();
    } else
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(body));
  });
  sockets.on('connection', (socket) =>
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString()) as Request;
      if (request.id !== undefined)
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: result(request),
          }),
        );
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets.clients) socket.terminate();
        sockets.close();
        sse?.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  const root = scratch(t);
  const manager = new McpManager(root);
  cleanup(t, () => manager.close());
  for (const [transport, url] of [
    ['streamable_http', `http://127.0.0.1:${port}/mcp`],
    ['sse', `http://127.0.0.1:${port}/sse`],
    ['websocket', `ws://127.0.0.1:${port}/socket`],
  ]) {
    await manager.load([{ name: 'fixture', url, transport }]);
    assert.equal(
      manager.status[0]?.error,
      '',
      `${transport}: ${manager.describe()}`,
    );
    assert.equal(
      await manager.tools[0]!.run(
        {},
        { sessionId: 'test', signal: new AbortController().signal },
      ),
      'actual transport response',
    );
  }
});
