import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { GatewayModel } from '../src/model.js';
import {
  defaultSettings,
  saveSettings,
  saveCredentials,
  trustFolder,
} from '../src/settings.js';
async function server(
  t: { after(fn: () => void | Promise<void>): void },
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
  ) => void,
): Promise<string> {
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    handler(request, response, text ? JSON.parse(text) : {});
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(() => {
    instance.closeAllConnections();
    return new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}
function scratch(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'circle-gateway-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function sse(response: ServerResponse, data: unknown): void {
  response.write('data: ' + JSON.stringify(data) + '\n\n');
}
test('OpenAI streaming joins split tool arguments and records usage from the final empty chunk', async (t) => {
  let requestBody: Record<string, unknown> = {};
  const base = await server(t, (request, response, body) => {
    assert.equal(request.url, '/v1/chat/completions');
    requestBody = body;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call',
                function: { name: 'read_file', arguments: '{"file_' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    sse(response, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: 'path":"file.txt"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    sse(response, {
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    });
    response.end('data: [DONE]\n\n');
  });
  const home = scratch(t);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    base_url: base + '/v1',
    model: 'gateway',
  };
  saveCredentials({ api_key: 'test-key' }, home);
  const model = new GatewayModel(settings, home);
  const result = await model.complete({
    system: 'system',
    messages: [{ id: 'one', role: 'user', content: 'read' }],
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
  });
  assert.deepEqual(result.message.tool_calls, [
    { id: 'call', name: 'read_file', args: { file_path: 'file.txt' } },
  ]);
  assert.deepEqual(result.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 2,
  });
  assert.equal(requestBody.model, 'gateway');
});
test('Anthropic streaming preserves thinking signatures and tool payloads for the next request', async (t) => {
  const base = await server(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type: string, body: unknown) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
    event('message_start', {
      type: 'message_start',
      message: {
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: 'gateway',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 0 },
      },
    });
    event('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'reason' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'preserved-signature' },
    });
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    });
    event('content_block_delta', {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    });
    event('content_block_stop', { type: 'content_block_stop', index: 1 });
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    });
    event('message_stop', { type: 'message_stop' });
    response.end();
  });
  const home = scratch(t);
  const settings = defaultSettings();
  settings.auth = {
    ...settings.auth,
    base_url: base,
    model: 'gateway',
    protocol: 'anthropic',
  };
  saveCredentials({ api_key: 'test-key' }, home);
  const model = new GatewayModel(settings, home);
  const tokens: string[] = [];
  const result = await model.complete({
    system: 'system',
    messages: [{ id: 'one', role: 'user', content: 'question' }],
    tools: [],
    signal: new AbortController().signal,
    token: (text) => tokens.push(text),
  });
  assert.equal(result.message.content, 'answer');
  assert.equal(result.message.thinking, 'reason');
  assert.equal(
    (result.message.provider_content?.[0] as { signature: string }).signature,
    'preserved-signature',
  );
  assert.deepEqual(tokens, ['reason', 'answer']);
});
test('CLI runs two real HTTP requests with a file side effect and resumes persisted history in a new process', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  let requests = 0;
  const bodies: Record<string, unknown>[] = [];
  const base = await server(t, (_request, response, body) => {
    bodies.push(body);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const first = requests++ === 0;
    sse(response, {
      choices: [
        {
          index: 0,
          delta: first
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        file_path: 'actual.txt',
                        content: 'actual side effect',
                      }),
                    },
                  },
                ],
              }
            : { content: 'done' },
          finish_reason: first ? 'tool_calls' : 'stop',
        },
      ],
    });
    response.end('data: [DONE]\n\n');
  });
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth = {
    ...settings.auth,
    base_url: base + '/v1',
    model: 'gateway',
  };
  settings = trustFolder(settings, workspace);
  saveSettings(settings, home);
  saveCredentials({ api_key: 'test-key' }, home);
  const run = (
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolveRun, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/cli.ts', ...args],
        {
          cwd: process.cwd(),
          env: { ...process.env, CIRCLE_HOME: home },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => {
        stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      child.once('error', reject);
      child.once('close', (code) => resolveRun({ code, stdout, stderr }));
      child.stdin.end();
    });
  const first = await run(['-p', 'write', workspace, '--yolo']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, 'done\n');
  assert.ok(existsSync(join(workspace, 'actual.txt')));
  assert.equal(
    readFileSync(join(workspace, 'actual.txt'), 'utf8'),
    'actual side effect',
  );
  const next = await run(['-p', 'next', workspace, '-c']);
  assert.equal(next.code, 0, next.stderr);
  assert.equal(next.stdout, 'done\n');
  const messages = bodies[2]!.messages as { role: string; content: string }[];
  assert.ok(
    messages.some(
      (message) => message.role === 'tool' && message.content.includes('Wrote'),
    ),
  );
  assert.equal(messages.at(-1)!.content, 'next');
});
