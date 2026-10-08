import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import {
  prepareToolCall,
  parseToolInput,
  RecoverableToolError,
} from '../src/tool_call_compat.js';
import { buildTools } from '../src/tools.js';
import { Sandbox } from '../src/sandbox.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { redact } from '../src/redact.js';
import { scratch, cleanup } from './helpers.js';
import type { Message, Tool } from '../src/types.js';
test('read-only call aliases, field spellings and one-element string lists are repaired unambiguously', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'a.txt'), 'hello\n');
  const tools = buildTools(new Sandbox(root));
  const repaired = prepareToolCall(
    {
      id: 'call',
      name: 'Read_File',
      args: { filePath: ['a.txt'], offset: '1' },
    },
    tools,
  );
  assert.equal(repaired.call.name, 'read_file');
  assert.deepEqual(repaired.call.args, { file_path: 'a.txt', offset: 1 });
  const result = await repaired.tool.run(repaired.call.args, {
    signal: new AbortController().signal,
    sessionId: 'test',
  });
  assert.match(result, /1: hello/);
  for (const name of ['Write_File', 'Execute', 'write file'])
    assert.throws(
      () => prepareToolCall({ id: name, name, args: {} }, tools),
      RecoverableToolError,
    );
  assert.throws(
    () =>
      prepareToolCall(
        {
          id: 'ambiguous',
          name: 'read_file',
          args: { filePath: 'a', file_path: 'b' },
        },
        tools,
      ),
    /ambiguous aliases/,
  );
});
test('nested JSON strings and malformed Unicode escapes are repaired, while validation errors disclose types and fields only', () => {
  const tool: Tool = {
    name: 'inspect',
    description: '',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          items: {
            type: 'object',
            properties: { count: { type: 'integer' } },
            required: ['count'],
          },
        },
      },
      required: ['records'],
    },
    run: async () => 'ok',
  };
  const repaired = prepareToolCall(
    { id: 'one', name: 'inspect', args: { records: '[{"count":2}]' } },
    [tool],
  );
  assert.deepEqual(repaired.call.args, { records: [{ count: 2 }] });
  assert.deepEqual(parseToolInput('{"value":"\\u 00e9"}'), { value: 'é' });
  assert.throws(
    () =>
      prepareToolCall(
        {
          id: 'bad',
          name: 'inspect',
          args: { records: [{ count: 'private-value-should-not-appear' }] },
        },
        [tool],
      ),
    (error) => {
      assert.ok(error instanceof RecoverableToolError);
      assert.match(error.message, /count.*integer/);
      assert.ok(!error.message.includes('private-value'));
      return true;
    },
  );
});
test('the real tool boundary rejects malformed and misspelled mutable calls before any effect and gives the model a recoverable result', async (t) => {
  const root = scratch(t);
  const replies: Message[] = [
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'one',
          name: 'Write_File',
          args: { file_path: 'should-not-exist', content: 'wrong' },
        },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'two',
          name: 'write_file',
          args: {},
          raw_args: 'not json',
          argument_error: 'invalid arguments JSON',
        },
      ],
    },
    { id: 'a3', role: 'assistant', content: 'fixed the request' },
  ];
  const model = new ScriptedModel(replies.map((message) => ({ message })));
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('test');
  assert.equal(existsSync(join(root, 'should-not-exist')), false);
  const errors = runtime.harness.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.equal(errors.length, 2);
  assert.ok(
    errors.every(
      (message) => message.recoverable && message.status === 'error',
    ),
  );
  assert.equal(model.requests[1]!.messages.at(-1)!.tool_call_id, 'one');
  assert.equal(model.requests[2]!.messages.at(-1)!.tool_call_id, 'two');
});
test('tool exceptions redact known credential shapes before model context and persistence', async (t) => {
  const root = scratch(t);
  const model = new ScriptedModel([
    {
      message: {
        id: 'a',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'failure', name: 'fails', args: {} }],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'recovered' } },
  ]);
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.harness.tools.push({
    name: 'fails',
    description: '',
    parameters: { type: 'object' },
    effect: 'read',
    run: async () => {
      throw new Error(
        'https://user:password@host.test password=supersecret Authorization: Bearer 123456789abcdef',
      );
    },
  });
  await runtime.harness.run('test');
  const result = runtime.harness.messages.find(
    (message) => message.tool_call_id === 'failure',
  )!;
  assert.ok(!result.content.includes('supersecret'));
  assert.ok(!result.content.includes('123456789abcdef'));
  assert.equal(model.requests[1]!.messages.at(-1)!.content, result.content);
  assert.match(redact('token=hello'), /token=\*\*\*/);
});
