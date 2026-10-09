import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentRuntime } from '../src/runtime.js';
import { Sandbox } from '../src/sandbox.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { prepareToolCall } from '../src/tool_call_compat.js';
import { buildTools } from '../src/tools.js';
import { cleanup, scratch } from './helpers.js';

test('file pagination skips zero-based source lines and accepts CRLF, CR and EOF without a phantom row', async (t) => {
  const root = scratch(t);
  const tools = buildTools(new Sandbox(root));
  const context = { signal: new AbortController().signal, sessionId: 'test' };
  for (const separator of ['\n', '\r\n', '\r']) {
    for (const finalNewline of ['', separator]) {
      writeFileSync(
        join(root, 'lines.txt'),
        ['one', 'two', '', 'four'].join(separator) + finalNewline,
      );
      const read = async (offset: number, limit: number) => {
        const call = prepareToolCall(
          {
            id: 'read',
            name: 'read_file',
            args: { file_path: 'lines.txt', offset, limit },
          },
          tools,
        );
        return call.tool.run(call.call.args, context);
      };
      assert.equal(await read(0, 1), '1: one');
      assert.equal(await read(1, 2), '2: two\n3: ');
      assert.equal(await read(-2, 1), '1: one');
      assert.equal(await read(3, 20), '4: four');
      assert.match(await read(0, 0), /no lines were read/);
      assert.match(await read(0, -3), /no lines were read/);
      await assert.rejects(
        read(4, 1),
        /offset 4 exceeds file length \(4 lines\)/,
      );
    }
  }
});

test('reads retain requested large windows, bound long rows and distinguish blank files from zero-line requests', async (t) => {
  const root = scratch(t);
  const tool = buildTools(new Sandbox(root)).find(
    (tool) => tool.name === 'read_file',
  )!;
  const context = { signal: new AbortController().signal, sessionId: 'test' };
  writeFileSync(
    join(root, 'large.txt'),
    Array.from({ length: 3001 }, (_, i) => `line ${i + 1}`).join('\n'),
  );
  const rows = (
    await tool.run({ file_path: 'large.txt', limit: 3000 }, context)
  ).split('\n');
  assert.equal(rows.length, 3000);
  assert.equal(rows.at(-1), '3000: line 3000');
  writeFileSync(join(root, 'long.txt'), 'x'.repeat(3000));
  assert.equal(
    await tool.run({ file_path: 'long.txt' }, context),
    '1: ' + 'x'.repeat(2000) + '…',
  );
  for (const contents of ['', ' \r\n\t']) {
    writeFileSync(join(root, 'blank.txt'), contents);
    assert.match(
      await tool.run({ file_path: 'blank.txt', limit: 0 }, context),
      /File exists but has empty contents/,
    );
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tool.run(
      { file_path: 'large.txt' },
      { ...context, signal: controller.signal },
    ),
    { name: 'AbortError' },
  );
});

test('paged file results reach the next model request and remain identical after reopening the session', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'source.txt'), 'alpha\nbeta\ngamma\ndelta\n');
  const model = new ScriptedModel([
    {
      message: {
        id: 'read',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'page',
            name: 'read_file',
            args: { file_path: 'source.txt', offset: 2, limit: 2 },
          },
        ],
      },
    },
    { message: { id: 'answer', role: 'assistant', content: 'done' } },
  ]);
  const options = {
    workspace: root,
    home: join(root, 'home'),
    settings: defaultSettings(),
    model,
  };
  const runtime = new AgentRuntime(options);
  cleanup(t, () => runtime.close());
  const harness = runtime.harness;
  await harness.run('Read the last two lines');
  const result = model.requests[1]!.messages.find(
    (message) => message.role === 'tool',
  )!;
  assert.equal(result.content, '3: gamma\n4: delta');
  const sessionId = runtime.session.id;
  await runtime.close();
  const reopened = new AgentRuntime(options);
  cleanup(t, () => reopened.close());
  assert.equal(
    reopened.store
      .messages(sessionId)
      .find((message) => message.role === 'tool')!.content,
    result.content,
  );
});
