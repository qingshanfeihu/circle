import { writeFileSync } from 'node:fs';
let buffer: Buffer = Buffer.alloc(0);
const log = process.env.LSP_TEST_LOG;
const records: Record<string, unknown>[] = [];
const send = (id: unknown, result: unknown): void => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(header.subarray(0, 7));
  process.stdout.write(Buffer.concat([header.subarray(7), body]));
};
process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const size = Number(
      buffer
        .subarray(0, end)
        .toString()
        .match(/Content-Length:\s*(\d+)/i)![1],
    );
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(
      buffer.subarray(end + 4, end + 4 + size).toString(),
    ) as Record<string, unknown>;
    buffer = buffer.subarray(end + 4 + size);
    records.push(message);
    if (log) writeFileSync(log, JSON.stringify(records));
    if (message.method === 'initialize')
      send(message.id, { capabilities: { textDocumentSync: 1 } });
    else if (message.method === 'textDocument/hover')
      send(message.id, {
        contents: { kind: 'plaintext', value: '文档 hover' },
      });
    else if (message.method === 'textDocument/definition')
      send(message.id, [
        {
          uri: 'file:///definition.ts',
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 1 },
          },
        },
      ]);
    else if (message.method === 'never/respond') {
      /* Deliberately no response to exercise an actual read deadline. */
    } else if (message.id !== undefined) send(message.id, null);
  }
});
