import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { CheckpointStore, emptyContextState } from '../src/checkpoint_store.js';
import { ContextManager } from '../src/context_middleware.js';
import {
  nextPruneState,
  pruneMessages,
} from '../src/middleware/tool_result_prune.js';
import { planReminder, planTail } from '../src/middleware/plan_tail.js';
import { analyze, loopReminder } from '../src/middleware/loop_guard.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import type { Message, ModelRequest } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
const assistant = (
  id: string,
  content: string,
  name?: string,
  args: Record<string, unknown> = {},
): Message => ({
  id,
  role: 'assistant',
  content,
  ...(name ? { tool_calls: [{ id: 'call-' + id, name, args }] } : {}),
});
const tool = (id: string, name: string, content: string): Message => ({
  id: 'result-' + id,
  role: 'tool',
  name,
  content,
  tool_call_id: 'call-' + id,
  status: 'success',
});
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('pruning persists one batch, protects structured and question results, and strips only already-existing affected thinking', () => {
  const messages: Message[] = [{ id: 'user', role: 'user', content: 'go' }];
  for (let index = 0; index < 2; index++)
    messages.push(
      {
        ...assistant('ai-' + index, 'step', 'tick', { index }),
        thinking: 'original thought',
        provider_content: [
          { type: 'thinking', thinking: 'thought', signature: 'signature' },
          { type: 'text', text: 'step' },
        ],
      },
      tool('ai-' + index, 'tick', 'x'.repeat(40000)),
    );
  const original = digest(messages);
  const state = nextPruneState(messages, emptyContextState(), {
    protectTokens: 0,
  });
  assert.deepEqual(state.prunedIds, ['result-ai-0', 'result-ai-1']);
  assert.deepEqual(state.stripThinkingIds, ['ai-1']);
  assert.equal(nextPruneState(messages, state, { protectTokens: 0 }), state);
  const projected = pruneMessages(messages, state);
  assert.match(projected[2]!.content, /pruned to free context/);
  assert.equal(projected[1]!.thinking, 'original thought');
  assert.equal(projected[3]!.thinking, undefined);
  assert.equal(digest(messages), original);
  const protectedMessages = [
    tool('question', 'question', 'x'.repeat(100000)),
    tool('skill', 'skill', 'x'.repeat(100000)),
    tool('json', 'read_file', JSON.stringify({ data: 'x'.repeat(100000) })),
  ];
  assert.equal(
    nextPruneState(protectedMessages, emptyContextState(), { protectTokens: 0 })
      .prunedIds.length,
    0,
  );
  messages.push({ ...assistant('later', 'later'), thinking: 'new thought' });
  assert.equal(pruneMessages(messages, state).at(-1)!.thinking, 'new thought');
});
test('real tool loop preserves request prefixes between batches and reuses projection after restart', async (t) => {
  const root = scratch(t);
  const replies = Array.from({ length: 8 }, (_, index) => ({
    message: {
      ...assistant('ai-' + index, 'step', 'tick', { index }),
      thinking: 'thought-' + index,
    },
  }));
  const model = new ScriptedModel([
    ...replies,
    { message: assistant('done', 'done') },
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
    name: 'tick',
    description: 'numbered output',
    effect: 'read',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
    },
    run: async (args) => `${args.index}:` + 'x'.repeat(40000),
  });
  await runtime.harness.run('go');
  assert.equal(model.requests.length, 9);
  const prefix = (a: number, b: number) =>
    digest(model.requests[a]!.messages) ===
    digest(
      model.requests[b]!.messages.slice(0, model.requests[a]!.messages.length),
    );
  for (const index of [0, 1, 2, 3, 5, 7])
    assert.equal(prefix(index, index + 1), true, `prefix ${index}`);
  assert.equal(prefix(4, 5), false);
  assert.equal(prefix(6, 7), false);
  assert.equal(
    runtime.store.contextState(runtime.session.id).prunedIds.length,
    4,
  );
  assert.ok(
    runtime.harness.messages
      .filter((message) => message.role === 'tool')
      .every((message) => message.content.length > 40000),
  );
  const state = runtime.store.contextState(runtime.session.id);
  const id = runtime.session.id;
  await runtime.close();
  const follow = new ScriptedModel([{ message: assistant('follow', 'again') }]);
  const reopened = new AgentRuntime({
    home: root,
    workspace: root,
    settings: defaultSettings(),
    model: follow,
    session: id,
    headless: true,
  });
  cleanup(t, () => reopened.close());
  assert.equal(reopened.session.id, id);
  await reopened.harness.run('next');
  assert.deepEqual(reopened.store.contextState(id).prunedIds, state.prunedIds);
  assert.match(
    JSON.stringify(follow.requests[0]!.messages),
    /pruned to free context/,
  );
});
test('summary projections belong to their branch and fork, not a session-wide mutable pointer', (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const prefix = store.append(session.id, [
    { id: 'user', role: 'user', content: 'go' },
  ]);
  const a = store.append(session.id, [assistant('a', 'branch A')])!;
  store.setSummary(session.id, a, 'summary A');
  const aRaw = digest(store.messages(session.id));
  store.select(session.id, prefix);
  const b = store.append(session.id, [assistant('b', 'branch B')])!;
  assert.equal(store.contextState(session.id).summary, undefined);
  store.setSummary(session.id, b, 'summary B');
  store.select(session.id, a);
  assert.match(store.projectedMessages(session.id)[0]!.content, /summary A/);
  assert.equal(digest(store.messages(session.id)), aRaw);
  const fork = store.fork(session.id, root);
  assert.match(store.projectedMessages(fork.id)[0]!.content, /summary A/);
  store.select(session.id, b);
  assert.match(store.projectedMessages(session.id)[0]!.content, /summary B/);
});
test('large tool output is offloaded as exact bytes, recovered after relocation, and corrupt artifacts are rejected', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const raw = '中文 output\n'.repeat(10000);
  store.append(session.id, [
    { id: 'user', role: 'user', content: 'go' },
    assistant('read', '', 'read_file', {}),
    tool('read', 'read_file', raw),
  ]);
  const before = digest(store.messages(session.id));
  const data = join(root, 'data');
  const manager = new ContextManager(store, data, { autoCompact: false });
  const model = new ScriptedModel();
  const signal = new AbortController().signal;
  const projected = await manager.prepare(session.id, model, '', [], signal);
  const virtual = store.contextState(session.id).offloaded['result-read']!;
  const path = join(data, virtual.slice(1));
  assert.equal(readFileSync(path, 'utf8'), raw);
  assert.match(projected.at(-1)!.content, /Full output saved/);
  assert.equal(digest(store.messages(session.id)), before);
  unlinkSync(path);
  await manager.prepare(session.id, model, '', [], signal);
  assert.equal(readFileSync(path, 'utf8'), raw);
  const relocated = new ContextManager(store, join(root, 'relocated'), {
    autoCompact: false,
  });
  await relocated.prepare(session.id, model, '', [], signal);
  assert.equal(
    readFileSync(join(root, 'relocated', virtual.slice(1)), 'utf8'),
    raw,
  );
  writeFileSync(path, 'corrupt');
  await assert.rejects(
    manager.prepare(session.id, model, '', [], signal),
    /does not match raw history/,
  );
  assert.equal(readFileSync(path, 'utf8'), 'corrupt');
});
test('automatic compaction uses a balanced prefix, retains raw bytes, and exposes recoverable history', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const raw: Message[] = [];
  for (let i = 0; i < 6; i++)
    raw.push(
      {
        id: 'user-' + i,
        role: 'user',
        content: 'goal ' + i + 'x'.repeat(2000),
      },
      assistant('ai-' + i, 'answer ' + i),
    );
  store.append(session.id, raw);
  const before = digest(store.messages(session.id));
  const model = new ScriptedModel([
    { message: assistant('summary', 'structured summary') },
  ]);
  const manager = new ContextManager(store, join(root, 'data'), {
    contextWindow: 1000,
  });
  const result = await manager.prepare(
    session.id,
    model,
    '',
    [],
    new AbortController().signal,
  );
  assert.match(result[0]!.content, /structured summary/);
  assert.equal(result.length, 7);
  assert.equal(digest(store.messages(session.id)), before);
  const state = store.contextState(session.id);
  assert.ok(state.summary?.historyPath);
  const artifact = readFileSync(
    join(root, 'data', state.summary.historyPath.slice(1)),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(artifact, raw.slice(0, 6));
  assert.equal(model.requests[0]!.tools.length, 0);
});
test('plan reminders are bounded, after tool results, current-turn-only and do not treat subagents as the main agent', () => {
  const todos = [{ content: 'work', status: 'in_progress' as const }];
  const raw: Message[] = [
    { id: 'user', role: 'user', content: 'go' },
    assistant('plan', '', 'write_todos', { todos }),
    tool('plan', 'write_todos', 'updated'),
  ];
  for (let index = 0; index < 10; index++)
    raw.push(
      assistant('ai-' + index, '', 'tick', { index }),
      tool('ai-' + index, 'tick', 'found'),
    );
  const reminder = planReminder(raw, raw, todos)!;
  assert.equal(reminder.internal, 'plan-reminder');
  assert.match(reminder.content, /\[>\] work/);
  assert.equal(planReminder(raw, raw, todos, true), undefined);
  assert.equal(
    planReminder(
      [
        ...raw,
        { id: 'next', role: 'user', content: 'new task' },
        tool('after', 'tick', 'found'),
      ],
      raw,
      todos,
    ),
    undefined,
  );
  const long = Array.from({ length: 40 }, (_, index) => ({
    content: 'step ' + index + 'x'.repeat(200),
    status: index < 20 ? ('completed' as const) : ('pending' as const),
  }));
  assert.equal(
    planTail(long)
      .split('\n')
      .filter((line) => line.startsWith('[')).length,
    15,
  );
  assert.match(planTail(long), /step 20/);
});
test('loop analysis groups parallel empty results as one round and permits ordered paging progress', () => {
  const messages: Message[] = [{ id: 'u', role: 'user', content: 'search' }];
  for (let round = 0; round < 4; round++) {
    const answer = assistant('a' + round, '');
    answer.tool_calls = Array.from({ length: 3 }, (_, index) => ({
      id: `r${round}-${index}`,
      name: 'grep',
      args: { pattern: 'missing' + index },
    }));
    messages.push(
      answer,
      ...answer.tool_calls.map((call) => ({
        id: call.id + '-result',
        role: 'tool' as const,
        content: 'No matches found',
        tool_call_id: call.id,
      })),
    );
  }
  assert.equal(analyze(messages).emptyRounds, 4);
  assert.equal(loopReminder(messages)?.internal, 'loop-guard');
  const pages = Array.from({ length: 8 }, (_, index) =>
    assistant('page' + index, '', 'read_file', {
      file_path: 'a',
      offset: index * 100,
    }),
  );
  assert.equal(analyze(pages).loose, 0);
  for (const message of pages) message.tool_calls![0]!.args.offset = 1;
  assert.equal(analyze(pages).loose, 8);
});
test('productive long turns are not cut off at the prototype one-hundred-call limit', async (t) => {
  const root = scratch(t);
  const replies = Array.from({ length: 105 }, (_, index) => ({
    message: assistant('ai-' + index, '', 'tick', { index }),
  }));
  const model = new ScriptedModel([
    ...replies,
    { message: assistant('done', 'completed the long task') },
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
    name: 'tick',
    description: '',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
    },
    effect: 'read',
    run: async (args) => 'new result ' + args.index,
  });
  assert.equal(
    (await runtime.harness.run('long task')).answer,
    'completed the long task',
  );
  assert.equal(model.requests.length, 106);
  assert.ok(
    runtime.harness.messages.some(
      (message) => message.internal === 'loop-guard',
    ),
  );
});
