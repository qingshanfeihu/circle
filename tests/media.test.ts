import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { AgentRuntime } from '../src/runtime.js';
import { GatewayModel } from '../src/model.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import {
  makeAttachment,
  validateAttachments,
  attachmentFromBase64,
  MAX_MEDIA_BYTES,
} from '../src/media.js';
import { validateMessages } from '../src/session_graph.js';
import { McpManager } from '../src/mcp_loader.js';
import { fromLegacyMessage } from '../src/legacy_message.js';
import { toHtml, toJsonl, fromJsonl } from '../src/session_export.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ContextManager } from '../src/context_middleware.js';
import {
  nextPruneState,
  pruneMessages,
} from '../src/middleware/tool_result_prune.js';
import type { MediaAttachment, Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xkAAAAASUVORK5CYII=',
  'base64',
);
const pdf = Buffer.from('%PDF-1.4\nfixture\n%%EOF');
for (const protocol of ['openai', 'anthropic'] as const) {
  test(`${protocol} sends user and tool media through the SDK, keeps tool batches balanced and restores bytes after export`, async (t) => {
    const root = scratch(t);
    const requests: any[] = [];
    const calls = [
      { id: 'image', name: 'read_file', args: { file_path: 'picture.png' } },
      { id: 'pdf', name: 'read_file', args: { file_path: 'document.pdf' } },
      { id: 'text', name: 'read_file', args: { file_path: 'note.txt' } },
    ];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      const first = requests.length === 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (protocol === 'openai') {
        const delta = first
          ? {
              tool_calls: calls.map((call, index) => ({
                index,
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args),
                },
              })),
            }
          : { content: 'viewed' };
        response.write(
          'data: ' +
            JSON.stringify({
              id: 'response',
              model: 'gateway',
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: first ? 'tool_calls' : 'stop',
                },
              ],
            }) +
            '\n\n',
        );
        response.end('data: [DONE]\n\n');
      } else {
        const send = (event: { type: string; [key: string]: unknown }) =>
          response.write(
            'event: ' +
              event.type +
              '\ndata: ' +
              JSON.stringify(event) +
              '\n\n',
          );
        send({
          type: 'message_start',
          message: {
            id: 'response',
            type: 'message',
            role: 'assistant',
            model: 'gateway',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        if (first)
          calls.forEach((call, index) => {
            send({
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: {},
              },
            });
            send({
              type: 'content_block_delta',
              index,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(call.args),
              },
            });
            send({ type: 'content_block_stop', index });
          });
        else {
          send({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          });
          send({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'viewed' },
          });
          send({ type: 'content_block_stop', index: 0 });
        }
        send({
          type: 'message_delta',
          delta: {
            stop_reason: first ? 'tool_use' : 'end_turn',
            stop_sequence: null,
          },
          usage: { output_tokens: 3 },
        });
        send({ type: 'message_stop' });
        response.end();
      }
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    cleanup(t, async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const settings = defaultSettings();
    settings.default_thinking = '';
    settings.auth = {
      ...settings.auth,
      protocol,
      model: 'gateway',
      base_url: `http://127.0.0.1:${address.port}${protocol === 'openai' ? '/v1' : ''}`,
    };
    const home = join(root, 'home');
    saveCredentials({ api_key: 'fixture-key' }, home);
    writeFileSync(join(root, 'picture.png'), png);
    writeFileSync(join(root, 'document.pdf'), pdf);
    writeFileSync(join(root, 'note.txt'), 'real text');
    writeFileSync(join(root, '.env'), 'PRIVATE_VALUE=should-not-be-attached');
    const runtime = new AgentRuntime({
      workspace: root,
      home,
      settings,
      model: new GatewayModel(settings, home),
      headless: true,
    });
    cleanup(t, () => runtime.close());
    assert.equal(
      (await runtime.harness.run('Inspect @picture.png and @.env')).answer,
      'viewed',
    );
    assert.equal(requests.length, 2);
    assert.ok(!JSON.stringify(requests).includes('should-not-be-attached'));
    if (protocol === 'openai') {
      assert.equal(
        requests[0].messages.at(-1).content[1].image_url.url,
        'data:image/png;base64,' + png.toString('base64'),
      );
      const last = requests[1].messages.slice(-4);
      assert.deepEqual(
        last.map((message: any) => message.role),
        ['tool', 'tool', 'tool', 'user'],
      );
      assert.deepEqual(
        last.slice(0, 3).map((message: any) => message.tool_call_id),
        ['image', 'pdf', 'text'],
      );
      assert.equal(
        last[3].content[1].image_url.url,
        'data:image/png;base64,' + png.toString('base64'),
      );
      assert.equal(
        last[3].content[2].file.file_data,
        'data:application/pdf;base64,' + pdf.toString('base64'),
      );
    } else {
      assert.equal(
        requests[0].messages[0].content[1].source.data,
        png.toString('base64'),
      );
      const results = requests[1].messages.at(-1).content;
      assert.deepEqual(
        results.map((block: any) => block.tool_use_id),
        ['image', 'pdf', 'text'],
      );
      assert.equal(results[0].content[1].source.data, png.toString('base64'));
      assert.equal(results[1].content[1].source.data, pdf.toString('base64'));
    }
    const original = runtime.harness.messages;
    validateMessages(original);
    const sessionId = runtime.session.id;
    const bundle = runtime.exportSession();
    await runtime.close();
    rmSync(join(root, 'picture.png'));
    const model = new ScriptedModel([
      { message: { id: 'after', role: 'assistant', content: 'restored' } },
    ]);
    const reopened = new AgentRuntime({
      workspace: root,
      home,
      settings,
      sessionId,
      model,
      headless: true,
    });
    cleanup(t, () => reopened.close());
    assert.deepEqual(reopened.harness.messages, original);
    const imported = new AgentRuntime({
      workspace: root,
      home: join(root, 'imported'),
      settings,
      model,
      headless: true,
    });
    cleanup(t, () => imported.close());
    await imported.importSession(bundle);
    assert.deepEqual(imported.harness.messages, original);
    await imported.harness.run('Inspect again');
    assert.equal(
      model.requests[0]!.messages.find(
        (message) => message.tool_call_id === 'image',
      )!.attachments![0]!.data,
      png.toString('base64'),
    );
  });
}

test('MCP image and embedded PDF results become attachments without base64 in terminal text', async (t) => {
  const root = scratch(t);
  const manager = new McpManager(root);
  cleanup(t, () => manager.close());
  await manager.load([
    {
      name: 'fixture',
      command: process.execPath,
      args: [resolve('tests/fixtures/mcp-server.ts')],
    },
  ]);
  const attachments: MediaAttachment[] = [];
  const text = await manager.tools
    .find((tool) => tool.name === 'fixture_media')!
    .run(
      {},
      {
        sessionId: 'test',
        signal: new AbortController().signal,
        emitAttachments: (items) => attachments.push(...items),
      },
    );
  assert.deepEqual(
    attachments.map((item) => item.mime_type),
    ['image/png', 'application/pdf'],
  );
  assert.ok(!text.includes(png.toString('base64')));
  validateAttachments(attachments);
});

test('attachment validation rejects changed bytes, invalid base64 and unsupported types and imports inline legacy media', () => {
  const attachment = makeAttachment(png, 'image/png', 'picture.png');
  validateAttachments([attachment]);
  assert.throws(
    () =>
      validateAttachments([
        { ...attachment, data: Buffer.from('changed').toString('base64') },
      ]),
    /receipt/,
  );
  assert.throws(
    () => attachmentFromBase64('not base64!', 'image/png', 'image.png'),
    /base64/,
  );
  assert.throws(
    () =>
      makeAttachment(
        Buffer.alloc(MAX_MEDIA_BYTES + 1),
        'image/png',
        'large.png',
      ),
    /20 MiB/,
  );
  assert.throws(
    () =>
      validateMessages([
        {
          id: 'bad',
          role: 'user',
          content: '',
          attachments: [{ ...attachment, mime_type: 'text/html' } as any],
        },
      ]),
    /attachment/,
  );
  const legacy = fromLegacyMessage({
    type: 'human',
    data: {
      id: 'legacy',
      content: [
        { type: 'text', text: 'view' },
        {
          type: 'image',
          mime_type: 'image/png',
          base64: png.toString('base64'),
        },
        {
          type: 'file',
          file: {
            filename: 'document.pdf',
            file_data: 'data:application/pdf;base64,' + pdf.toString('base64'),
          },
        },
      ],
    },
  });
  assert.equal(legacy.content, 'view');
  assert.deepEqual(
    legacy.attachments!.map((item) => Buffer.from(item.data, 'base64')),
    [png, pdf],
  );
});

test('failed tools discard emitted media rather than persist a success attachment', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: {
        id: 'call',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'failed', name: 'inspect', args: {} }],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'failed safely' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    extraTools: [
      {
        name: 'inspect',
        description: '',
        effect: 'read',
        parameters: { type: 'object', properties: {} },
        run: async (_, context) => {
          context.emitAttachments!([
            makeAttachment(png, 'image/png', 'image.png'),
          ]);
          throw new Error('inspection failed');
        },
      },
    ],
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('inspect');
  const result = model.requests[1]!.messages.find(
    (message) => message.role === 'tool',
  )!;
  assert.equal(result.status, 'error');
  assert.equal(result.attachments, undefined);
});

test('media stays in raw archives, is not pruned automatically and is summarized without encoded bytes', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const attachment = makeAttachment(png, 'image/png', 'picture.png');
  const messages: Message[] = [
    {
      id: 'prompt',
      role: 'user',
      content: 'inspect',
      attachments: [attachment],
    },
    {
      id: 'call',
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'read', name: 'read_file', args: {} }],
    },
    {
      id: 'result',
      role: 'tool',
      content: 'picture'.repeat(100),
      tool_call_id: 'read',
      name: 'read_file',
      attachments: [attachment],
    },
    { id: 'answer', role: 'assistant', content: 'a small image' },
    ...Array.from({ length: 6 }, (_, i): Message => ({
      id: 'tail' + i,
      role: i % 2 ? 'assistant' : 'user',
      content: 'follow-up',
    })),
  ];
  store.append(session.id, messages);
  const state = nextPruneState(
    messages,
    { prunedIds: [], stripThinkingIds: [], offloaded: {} },
    { enabled: true, protectTokens: 0, minimumTokens: 0 },
  );
  assert.ok(!state.prunedIds.includes('result'));
  assert.equal(
    pruneMessages(messages, state)[2]!.attachments![0]!.data,
    attachment.data,
  );
  const model = new ScriptedModel([
    {
      message: {
        id: 'summary',
        role: 'assistant',
        content: 'Inspected picture.png',
      },
    },
  ]);
  const manager = new ContextManager(store, join(root, 'data'));
  await manager.compact(session.id, model, new AbortController().signal);
  const text = model.requests[0]!.messages[0]!.content;
  assert.ok(!text.includes(attachment.data));
  assert.ok(text.includes(attachment.sha256));
  assert.deepEqual(store.messages(session.id), messages);
  const archived = store.contextState(session.id).summary!.historyPath!;
  const { readFileSync } = await import('node:fs');
  assert.ok(
    readFileSync(
      join(root, 'data', archived.replace(/^\//, '')),
      'utf8',
    ).includes(attachment.data),
  );
});

test('HTML preserves media and escapes filenames; old JSONL validation rejects altered attachment receipts', () => {
  const attachment = makeAttachment(png, 'image/png', 'picture"<.png');
  const document = makeAttachment(pdf, 'application/pdf', 'document.pdf');
  const messages: Message[] = [
    {
      id: 'user',
      role: 'user',
      content: 'view',
      attachments: [attachment, document],
    },
  ];
  const meta = {
    thread_id: 'session',
    title: 'test',
    workspace: '.',
    model: 'test',
  };
  const html = toHtml(messages, meta);
  assert.ok(html.includes('data:image/png;base64,' + attachment.data));
  assert.ok(html.includes('data:application/pdf;base64,' + document.data));
  assert.ok(html.includes('picture&quot;&lt;.png'));
  assert.deepEqual(fromJsonl(toJsonl(messages, meta)).messages, messages);
  assert.throws(
    () =>
      fromJsonl(
        toJsonl(messages, meta).replace(attachment.sha256, '0'.repeat(64)),
      ),
    /receipt/,
  );
});
