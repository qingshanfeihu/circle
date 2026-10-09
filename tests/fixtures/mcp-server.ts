import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const pending = new Map<unknown, NodeJS.Timeout>();
const input = createInterface({ input: process.stdin, terminal: false });
const send = (id: unknown, result: unknown): void => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
};
for await (const line of input) {
  const request = JSON.parse(line) as {
    id?: number;
    method: string;
    params?: Record<string, unknown>;
  };
  if (request.method === 'initialize')
    send(request.id, {
      protocolVersion: request.params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '1' },
    });
  else if (request.method === 'tools/list')
    send(request.id, {
      tools: [
        {
          name: 'media',
          description: 'Return image and PDF fixtures.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'write_receipt',
          description: 'Write an observable test receipt.',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              delay: { type: 'integer' },
            },
            required: ['path'],
          },
        },
        {
          name: 'environment',
          description: 'Inspect the isolated test process.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'failure',
          description: 'Return an MCP error.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
  else if (request.method === 'tools/call') {
    const name = request.params?.name;
    const args =
      (request.params?.arguments as { path?: string; delay?: number }) || {};
    if (name === 'environment')
      send(request.id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              pid: process.pid,
              ambient: process.env.OPENAI_API_KEY,
              supplied: process.env.TEST_SUPPLIED,
            }),
          },
        ],
      });
    else if (name === 'media')
      send(request.id, {
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xkAAAAASUVORK5CYII=',
          },
          {
            type: 'resource',
            resource: {
              uri: 'file:///fixture.pdf',
              mimeType: 'application/pdf',
              blob: Buffer.from('%PDF-1.4\nfixture\n%%EOF').toString('base64'),
            },
          },
        ],
      });
    else if (name === 'failure')
      send(request.id, {
        isError: true,
        content: [{ type: 'text', text: 'fixture error' }],
      });
    else if (name === 'write_receipt') {
      const finish = (): void => {
        writeFileSync(args.path!, 'MCP wrote this');
        pending.delete(request.id);
        send(request.id, { content: [{ type: 'text', text: 'written' }] });
      };
      if (args.delay) pending.set(request.id, setTimeout(finish, args.delay));
      else finish();
    }
  } else if (request.method === 'notifications/cancelled') {
    const id = request.params?.requestId;
    const timer = pending.get(id);
    if (timer) clearTimeout(timer);
    pending.delete(id);
  }
}
for (const timer of pending.values()) clearTimeout(timer);
