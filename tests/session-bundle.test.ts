import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { CheckpointStore, emptyContextState } from '../src/checkpoint_store.js';
import { toSessionBundle, fromJsonl, toJsonl } from '../src/session_export.js';
import { graphMessages, validateSessionGraph } from '../src/session_graph.js';
import { ContextManager } from '../src/context_middleware.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import type { Message } from '../src/types.js';
import { scratch, cleanup } from './helpers.js';
import { SubagentNavigation } from '../src/tui/subagents.js';
const user = (id: string, content = id): Message => ({
  id,
  role: 'user',
  content,
});
const answer = (id: string, content = id): Message => ({
  id,
  role: 'assistant',
  content,
});
function reseal(text: string, change: (data: any) => void): string {
  const lines = text.split('\n');
  const data = JSON.parse(lines[1]!);
  change(data.data);
  lines[1] = JSON.stringify(data);
  lines[2] = JSON.stringify({
    type: 'seal',
    algorithm: 'sha256',
    digest: createHash('sha256')
      .update(lines.slice(0, 2).join('\n') + '\n')
      .digest('hex'),
  });
  return lines.join('\n');
}
test('session bundles restore all branches, selected heads, labels and raw messages with fresh physical identities', (t) => {
  const root = scratch(t);
  const source = new CheckpointStore(join(root, 'source'));
  cleanup(t, () => source.close());
  const session = source.create(root, 'test', 'branch history');
  const first = source.append(session.id, [user('start'), answer('response')])!;
  const branchA = source.append(session.id, [
    user('branch-a'),
    answer('answer-a'),
  ])!;
  source.setSummary(session.id, first, 'summary A');
  source.setLabel(session.id, 'branch-a', 'branch A');
  source.select(session.id, first);
  const branchB = source.append(session.id, [
    user('branch-b'),
    answer('answer-b'),
  ])!;
  source.setSummary(session.id, branchB, 'summary B');
  source.select(session.id, branchA);
  const text = toSessionBundle(source, session.id);
  const parsed = fromJsonl(text);
  assert.equal(parsed.header.version, 3);
  assert.deepEqual(parsed.messages, source.messages(session.id));
  const target = new CheckpointStore(join(root, 'target'));
  cleanup(t, () => target.close());
  const imported = target.importGraph(
    parsed.graph!,
    join(root, 'new-workspace'),
  );
  assert.notEqual(imported.id, session.id);
  assert.notEqual(imported.head, branchA);
  assert.deepEqual(target.messages(imported.id), source.messages(session.id));
  assert.equal(target.contextState(imported.id).summary!.text, 'summary A');
  assert.deepEqual(target.labels(imported.id), { 'branch-a': 'branch A' });
  const other = target
    .tree(imported.id)
    .find((checkpoint) => checkpoint.message.id === 'answer-b')!;
  target.select(imported.id, other.id);
  assert.equal(target.contextState(imported.id).summary!.text, 'summary B');
  assert.deepEqual(
    target.messages(imported.id).map((message) => message.id),
    ['start', 'response', 'branch-b', 'answer-b'],
  );
  assert.equal(source.get(session.id)!.head, branchA);
});
test('native children stay out of discovery and are cloned with their owning branch before the original is deleted', (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const parent = store.create(root, 'model');
  const before = store.append(parent.id, [user('before')])!;
  const head = store.append(parent.id, [answer('main')])!;
  const child = store.create(
    root,
    'child-model',
    'research',
    undefined,
    parent.id,
  );
  store.append(child.id, [user('child-input'), answer('child-report')]);
  store.setContextState(parent.id, {
    ...emptyContextState(),
    subagentSessionIds: [child.id],
  });
  assert.deepEqual(
    store.list().map((session) => session.id),
    [parent.id],
  );
  assert.equal(store.find(child.id), undefined);
  assert.equal(store.children(parent.id)[0]!.id, child.id);
  const fork = store.fork(parent.id, root, head);
  const forkChild = store.children(fork.id)[0]!;
  assert.notEqual(forkChild.id, child.id);
  assert.deepEqual(store.messages(forkChild.id), store.messages(child.id));
  assert.deepEqual(store.contextState(fork.id).subagentSessionIds, [
    forkChild.id,
  ]);
  const earlier = store.fork(parent.id, root, before);
  assert.equal(store.children(earlier.id).length, 0);
  store.delete(parent.id);
  assert.equal(store.get(child.id), undefined);
  assert.ok(store.get(forkChild.id));
  assert.equal(store.messages(forkChild.id).at(-1)!.content, 'child-report');
});
test('integrity failures and re-sealed invalid graphs are rejected before any database writes', (t) => {
  const root = scratch(t);
  const source = new CheckpointStore(join(root, 'source'));
  cleanup(t, () => source.close());
  const parent = source.create(root, 'test');
  source.append(parent.id, [user('user'), answer('answer')]);
  const original = toSessionBundle(source, parent.id);
  const target = new CheckpointStore(join(root, 'target'));
  cleanup(t, () => target.close());
  const kept = target.create(root, 'kept');
  target.append(kept.id, [user('kept')]);
  assert.throws(
    () =>
      fromJsonl(original.replace('"content":"user"', '"content":"changed"')),
    /integrity/,
  );
  for (const modify of [
    (graph: any) => {
      graph.sessions[0].session.head = 'missing';
    },
    (graph: any) => {
      graph.sessions[0].checkpoints[0].parent =
        graph.sessions[0].checkpoints[1].id;
    },
    (graph: any) => {
      graph.sessions[0].contexts[0].state.offloaded.user = '/../../.env';
    },
    (graph: any) => {
      graph.sessions[0].contexts[0].state.subagentSessionIds = ['missing'];
    },
    (graph: any) => {
      graph.sessions.push(graph.sessions[0]);
    },
  ])
    assert.throws(() => {
      const parsed = fromJsonl(reseal(original, modify));
      target.importGraph(parsed.graph!, root);
    });
  assert.deepEqual(
    target.list().map((session) => session.id),
    [kept.id],
  );
  assert.equal(target.messages(kept.id)[0]!.content, 'kept');
});
test('graph validation checks inactive branches as well as the selected conversation', (t) => {
  const root = scratch(t);
  const source = new CheckpointStore(root);
  cleanup(t, () => source.close());
  const session = source.create(root, 'test');
  const first = source.append(session.id, [user('start')])!;
  source.append(session.id, [answer('first')]);
  source.select(session.id, first);
  source.append(session.id, [answer('second')]);
  const graph = source.exportGraph(session.id);
  graph.sessions[0]!.checkpoints.find(
    (checkpoint) => checkpoint.message?.id === 'first',
  )!.message = {
    id: 'orphan',
    role: 'tool',
    tool_call_id: 'missing',
    content: 'bad',
  };
  assert.throws(() => validateSessionGraph(graph), /matching call/);
});
test('nullable checkpoint boundaries and context version order survive export and import', (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  store.append(session.id, [user('raw')]);
  const graph = store.exportGraph(session.id);
  const node = graph.sessions[0]!;
  node.checkpoints.push({
    id: 'boundary',
    session_id: session.id,
    parent: session.head,
    message: null,
    created: Date.now(),
  });
  // create() returns the initial metadata; use the actual saved head here.
  node.checkpoints.at(-1)!.parent = store.get(session.id)!.head;
  node.session.head = 'boundary';
  node.contexts.push(
    {
      checkpoint_id: 'boundary',
      state: {
        ...emptyContextState(),
        summary: { cutoffMessageId: 'raw', text: 'first' },
      },
      created: 1,
    },
    {
      checkpoint_id: 'boundary',
      state: {
        ...emptyContextState(),
        summary: { cutoffMessageId: 'raw', text: 'latest' },
      },
      created: 2,
    },
  );
  const imported = store.importGraph(graph, root);
  assert.equal(store.checkpoint(imported.head!)!.message, null);
  assert.equal(store.contextState(imported.id).summary!.text, 'latest');
  assert.equal(store.messages(imported.id).length, 1);
});
test('moving a bundle to another data directory restores offloaded output from raw bytes without copying configuration', async (t) => {
  const root = scratch(t);
  const sourceHome = join(root, 'source');
  const targetHome = join(root, 'target');
  const source = new CheckpointStore(sourceHome);
  cleanup(t, () => source.close());
  const session = source.create(root, 'test');
  const output = '中文 raw output\n'.repeat(12000);
  source.append(session.id, [
    user('input'),
    {
      id: 'call',
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'read', name: 'read_file', args: { file_path: 'large.txt' } },
      ],
    },
    {
      id: 'result',
      role: 'tool',
      name: 'read_file',
      tool_call_id: 'read',
      content: output,
    },
    answer('done'),
  ]);
  const manager = new ContextManager(source, join(sourceHome, 'data'), {
    autoCompact: false,
  });
  await manager.prepare(
    session.id,
    new ScriptedModel(),
    '',
    [],
    new AbortController().signal,
  );
  const virtual = source.contextState(session.id).offloaded.result!;
  const target = new CheckpointStore(targetHome);
  cleanup(t, () => target.close());
  const imported = target.importGraph(
    fromJsonl(toSessionBundle(source, session.id)).graph!,
    join(root, 'new-workspace'),
  );
  const restored = new ContextManager(target, join(targetHome, 'data'), {
    autoCompact: false,
  });
  assert.equal(existsSync(join(targetHome, 'data', virtual.slice(1))), false);
  await restored.prepare(
    imported.id,
    new ScriptedModel(),
    '',
    [],
    new AbortController().signal,
  );
  assert.equal(
    readFileSync(join(targetHome, 'data', virtual.slice(1)), 'utf8'),
    output,
  );
  assert.equal(existsSync(join(targetHome, 'credentials.json')), false);
});
test('runtime import preserves summary/subagent prices, sends the restored projection and never replays historical tools', async (t) => {
  const root = scratch(t);
  const source = new AgentRuntime({
    workspace: root,
    home: join(root, 'source'),
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => source.close());
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0 };
  const cost = {
    model: 'test',
    currency: 'USD',
    amount: 0.25,
    tokens: {
      input_miss: 100,
      input_hit: 0,
      input_write: 0,
      input_write_1h: 0,
      output: 10,
    },
    rates: { input: 1, output: 2 },
    provider: 'test',
  };
  source.store.append(source.session.id, [
    user('input'),
    {
      id: 'call',
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: 'must-not-write.txt', content: 'bad' },
        },
      ],
      usage,
      cost,
    },
    {
      id: 'result',
      role: 'tool',
      tool_call_id: 'write',
      name: 'write_file',
      content: 'already done',
    },
  ]);
  const child = source.store.create(
    root,
    'test',
    'research',
    undefined,
    source.session.id,
  );
  source.store.append(child.id, [{ ...answer('child'), usage, cost }]);
  source.store.setContextState(source.session.id, {
    ...emptyContextState(),
    subagentSessionIds: [child.id],
    summary: { cutoffMessageId: 'result', text: 'Restored summary' },
    compactionCalls: [{ id: 'summary-call', model: 'test', usage, cost }],
  });
  const before = source.stats();
  const text = source.exportSession();
  const model = new ScriptedModel([{ message: answer('next', 'continued') }]);
  const target = new AgentRuntime({
    workspace: root,
    home: join(root, 'target'),
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => target.close());
  await target.importSession(text);
  assert.equal(model.requests.length, 0);
  assert.equal(existsSync(join(root, 'must-not-write.txt')), false);
  assert.deepEqual(target.stats().costs, before.costs);
  assert.deepEqual(target.stats().usage, before.usage);
  assert.equal(target.store.children(target.session.id).length, 1);
  await target.harness.run('continue');
  assert.match(model.requests[0]!.messages[0]!.content, /Restored summary/);
  assert.equal(existsSync(join(root, 'must-not-write.txt')), false);
});
test('version-two message exports still import as conversations without executing tools', async (t) => {
  const root = scratch(t);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  await runtime.importSession(
    toJsonl([user('input'), answer('answer')], {
      thread_id: 'old',
      title: 'old export',
      workspace: root,
      model: 'test',
    }),
  );
  assert.equal(runtime.harness.messages.length, 2);
  assert.equal(runtime.store.get(runtime.session.id)!.title, 'old export');
});
test('schema upgrade associates earlier native children once and keeps checkpoint bytes unchanged', (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  const parent = store.create(root, 'test');
  store.append(parent.id, [user('parent')]);
  const child = store.create(root, 'test');
  store.append(child.id, [user('child')]);
  store.setContextState(parent.id, {
    ...emptyContextState(),
    subagentSessionIds: [child.id],
  });
  const raw = store.messages(parent.id);
  store.close();
  const old = new DatabaseSync(join(root, 'circle.sqlite'));
  try {
    old.exec(
      'DROP INDEX sessions_parent; ALTER TABLE sessions DROP COLUMN parent_id; PRAGMA user_version=3;',
    );
  } finally {
    old.close();
  }
  const upgraded = new CheckpointStore(root);
  cleanup(t, () => upgraded.close());
  assert.equal(upgraded.get(child.id)!.parent_id, parent.id);
  assert.deepEqual(upgraded.messages(parent.id), raw);
  assert.equal(upgraded.list().length, 1);
});
test('a database failure halfway through graph import rolls back every created root, child and checkpoint', (t) => {
  const root = scratch(t);
  const source = new CheckpointStore(join(root, 'source'));
  cleanup(t, () => source.close());
  const parent = source.create(root, 'test');
  source.append(parent.id, [user('source')]);
  const child = source.create(root, 'test', 'child', undefined, parent.id);
  source.append(child.id, [answer('child-fail')]);
  const home = join(root, 'target');
  const target = new CheckpointStore(home);
  cleanup(t, () => target.close());
  const kept = target.create(root, 'kept');
  target.append(kept.id, [user('kept')]);
  const fixture = new DatabaseSync(join(home, 'circle.sqlite'));
  try {
    fixture.exec(
      "CREATE TRIGGER reject_bundle BEFORE INSERT ON checkpoints WHEN json_extract(NEW.message,'$.id')='child-fail' BEGIN SELECT RAISE(ABORT,'forced import failure'); END;",
    );
  } finally {
    fixture.close();
  }
  assert.throws(
    () => target.importGraph(source.exportGraph(parent.id), root),
    /forced import failure/,
  );
  assert.deepEqual(
    target.list(undefined, true).map((session) => session.id),
    [kept.id],
  );
  assert.deepEqual(target.messages(kept.id), [user('kept')]);
});
test('restored plan boundaries enforce the actual tool gate after import and restart', async (t) => {
  const root = scratch(t);
  const source = new AgentRuntime({
    workspace: root,
    home: join(root, 'source'),
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => source.close());
  source.setPlanMode(true);
  const text = source.exportSession();
  const model = new ScriptedModel([
    {
      message: {
        id: 'attempt',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'write',
            name: 'write_file',
            args: { file_path: 'blocked.txt', content: 'bad' },
          },
        ],
      },
    },
    { message: answer('done', 'still planning') },
  ]);
  const home = join(root, 'target');
  const target = new AgentRuntime({
    workspace: root,
    home,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => target.close());
  await target.importSession(text);
  assert.equal(target.harness.planMode, true);
  target.policy.setYolo(target.session.id, true);
  await target.harness.run('continue');
  assert.equal(existsSync(join(root, 'blocked.txt')), false);
  const id = target.session.id;
  await target.close();
  const reopened = new AgentRuntime({
    workspace: root,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    session: id,
    headless: true,
  });
  cleanup(t, () => reopened.close());
  assert.equal(reopened.harness.planMode, true);
  reopened.setPlanMode(false);
  await reopened.close();
  const off = new AgentRuntime({
    workspace: root,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    session: id,
    headless: true,
  });
  cleanup(t, () => off.close());
  assert.equal(off.harness.planMode, false);
});
test('subagent detail navigation uses empty-prompt Down, Enter, arrows and Escape without turning inspected history into a new turn', () => {
  const navigation = new SubagentNavigation();
  const ids = ['first', 'second'];
  assert.equal(navigation.handle('down', '', ids, 'typing'), false);
  assert.equal(navigation.handle('down', '', ids, ''), true);
  assert.equal(navigation.selected, 'first');
  navigation.handle('down', '', ids, '');
  navigation.handle('enter', '', ids, '');
  assert.equal(navigation.detail, 'second');
  navigation.handle('left', '', ids, '');
  assert.equal(navigation.detail, 'first');
  navigation.handle('escape', '', ids, '');
  assert.equal(navigation.detail, undefined);
  navigation.handle('enter', '', ids, '');
  assert.equal(navigation.handle('x', 'x', ids, ''), false);
  assert.equal(navigation.detail, undefined);
  assert.equal(navigation.selected, undefined);
});
