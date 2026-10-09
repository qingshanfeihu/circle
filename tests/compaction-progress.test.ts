import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { ContextManager } from '../src/context_middleware.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import {
  CompactionProgress,
  compactionDone,
  type CompactionEvent,
} from '../src/compaction.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { ModelCatalog, slimCatalog } from '../src/model_catalog.js';
import { emptyUsage, type ChatModel, type Message } from '../src/types.js';
import { jsonEvent } from '../src/headless.js';
import { compactionRow } from '../src/tui/status_rows.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { scratch, cleanup } from './helpers.js';
function history(): Message[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: 'raw-' + index,
    role: index % 2 ? ('assistant' as const) : ('user' as const),
    content: 'history ' + index,
  }));
}
const digest = (messages: Message[]) =>
  createHash('sha256').update(JSON.stringify(messages)).digest('hex');
test('compaction archives exact raw history before summarizing, reports stages and retains raw checkpoints', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const raw = history();
  store.append(session.id, raw);
  const before = digest(store.messages(session.id));
  const events: CompactionEvent[] = [];
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      assert.deepEqual(
        events.map((event) => event.phase),
        ['start', 'saving', 'saved', 'summarizing'],
      );
      assert.ok(
        existsSync(
          join(
            root,
            'data',
            events.find((event) => event.phase === 'saved')!.file!.slice(1),
          ),
        ),
      );
      request.token('summary');
      return {
        message: { id: 'summary', role: 'assistant', content: 'summary' },
        usage: { input_tokens: 100, output_tokens: 5, cache_read_tokens: 0 },
      };
    },
  };
  const manager = new ContextManager(store, join(root, 'data'), {
    progress: (event) => events.push(event),
  });
  await manager.compact(
    session.id,
    model,
    new AbortController().signal,
    'preserve exact paths',
    { system: 'system text', trigger: 'tool' },
  );
  assert.deepEqual(
    events
      .filter((event) => event.phase !== 'chunks')
      .map((event) => event.phase),
    ['start', 'saving', 'saved', 'summarizing', 'summarized', 'done'],
  );
  assert.equal(digest(store.messages(session.id)), before);
  const done = events.at(-1)!;
  assert.equal(done.summarized, 4);
  assert.equal(done.kept, 6);
  assert.equal(done.trigger, 'tool');
  assert.deepEqual(
    readFileSync(join(root, 'data', done.file!.slice(1)), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    raw.slice(0, 4),
  );
  assert.match(
    compactionDone(done),
    /compacted.*summarized 4 messages, kept 6.*history:/,
  );
  assert.equal(store.contextState(session.id).compactionCalls!.length, 1);
});
test('an output reservation can trigger compaction before 85 percent and native model windows retain a token-based tail', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  store.append(session.id, [
    { id: 'old-user', role: 'user', content: 'x'.repeat(13_000) },
    { id: 'old-answer', role: 'assistant', content: 'done' },
    { id: 'next-user', role: 'user', content: 'y'.repeat(13_000) },
    { id: 'next-answer', role: 'assistant', content: 'done' },
    { id: 'current-user', role: 'user', content: 'z'.repeat(3000) },
  ]);
  const events: CompactionEvent[] = [];
  const model: ChatModel = {
    model: 'small-window',
    contextWindow: 10_000,
    outputBudget: 2500,
    complete: async () => ({
      message: {
        id: 'summary',
        role: 'assistant',
        content: 'The earlier work is summarized.',
      },
      usage: emptyUsage(),
    }),
  };
  const manager = new ContextManager(store, join(root, 'data'), {
    progress: (event) => events.push(event),
  });
  const projected = await manager.prepare(
    session.id,
    model,
    '',
    [],
    new AbortController().signal,
  );
  assert.equal(events[0]!.trigger, 'overflow');
  assert.ok(events[0]!.tokens_before! < 8500);
  assert.equal(projected.at(-1)!.id, 'current-user');
  assert.match(projected[0]!.content, /earlier work/);
  assert.ok(events.at(-1)!.tokens_after! < events[0]!.tokens_before!);
});
test('one oversized message remains unsplit and a balanced tool-call round is never partially summarized', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const model = new ScriptedModel();
  const manager = new ContextManager(store, join(root, 'data'), {
    contextWindow: 100,
  });
  store.append(session.id, [
    { id: 'single', role: 'user', content: 'x'.repeat(10000) },
  ]);
  await manager.prepare(
    session.id,
    model,
    '',
    [],
    new AbortController().signal,
  );
  assert.equal(model.requests.length, 0);
  const session2 = store.create(root, 'balanced');
  const raw = history();
  raw[2] = {
    id: 'calls',
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call-a', name: 'read_file', args: {} },
      { id: 'call-b', name: 'grep', args: {} },
    ],
  };
  raw[3] = {
    id: 'result-a',
    role: 'tool',
    tool_call_id: 'call-a',
    content: 'a',
  };
  raw[4] = {
    id: 'result-b',
    role: 'tool',
    tool_call_id: 'call-b',
    content: 'b',
  };
  store.append(session2.id, raw);
  const summarizer = new ScriptedModel([
    { message: { id: 'summary', role: 'assistant', content: 'summary' } },
  ]);
  await manager.compact(session2.id, summarizer, new AbortController().signal);
  const archived = readFileSync(
    join(
      root,
      'data',
      store.contextState(session2.id).summary!.historyPath!.slice(1),
    ),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(archived, raw.slice(0, 2));
  store.requireBalancedTools(manager.project(session2.id));
});
test('manual compaction owns busy and cancellation; no other turn or session switch may commit while its request is in flight', async (t) => {
  const root = scratch(t);
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      reached();
      request.token('partial summary');
      await delay(10000, undefined, { signal: request.signal });
      return {
        message: { id: 'summary', role: 'assistant', content: 'summary' },
        usage: emptyUsage(),
      };
    },
  };
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.store.append(runtime.session.id, history());
  const before = digest(runtime.harness.messages);
  const events: CompactionEvent[] = [];
  runtime.bus.subscribe((event) => {
    if (event.kind === 'compaction')
      events.push(event.payload as unknown as CompactionEvent);
  });
  const pending = runtime.compact();
  const rejected = assert.rejects(pending, /aborted|Interrupted/i);
  await started;
  assert.equal(runtime.busy, true);
  await assert.rejects(runtime.newSession(), /turn is running/);
  await assert.rejects(
    runtime.harness.run('must not append'),
    /compaction is running/,
  );
  await runtime.cancel();
  await rejected;
  assert.equal(runtime.busy, false);
  assert.equal(digest(runtime.harness.messages), before);
  assert.equal(
    runtime.store.contextState(runtime.session.id).summary,
    undefined,
  );
  assert.equal(
    runtime.store.contextState(runtime.session.id).compactionCalls,
    undefined,
  );
  assert.equal(events.at(-1)!.phase, 'error');
});
test('changing branches during a summary never attaches its projection or charge to the new branch', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  const first = store.append(session.id, history().slice(0, 1))!;
  store.append(session.id, history().slice(1));
  const model: ChatModel = {
    model: 'controlled',
    complete: async () => {
      store.select(session.id, first);
      return {
        message: { id: 'summary', role: 'assistant', content: 'summary' },
        usage: emptyUsage(),
      };
    },
  };
  const manager = new ContextManager(store, join(root, 'data'));
  await assert.rejects(
    manager.compact(session.id, model, new AbortController().signal),
    /conversation changed/,
  );
  assert.equal(store.contextState(session.id).summary, undefined);
  assert.equal(store.contextState(session.id).compactionCalls, undefined);
});
test('progress is monotonic within the summary and JSON events expose phases without raw history', () => {
  const progress = new CompactionProgress('auto');
  progress.apply({ sessionId: 's', phase: 'saved', trigger: 'auto' });
  const before = progress.fraction();
  progress.apply({
    sessionId: 's',
    phase: 'chunks',
    trigger: 'auto',
    chunks: 100,
  });
  const advanced = progress.fraction();
  progress.apply({
    sessionId: 's',
    phase: 'chunks',
    trigger: 'auto',
    chunks: 1,
  });
  assert.equal(progress.fraction(), advanced);
  assert.ok(advanced > before);
  progress.apply({ sessionId: 's', phase: 'summarized', trigger: 'auto' });
  assert.equal(progress.fraction(), 1);
  assert.match(
    stripAnsi(compactionRow(progress, 80)),
    /auto-compacting · █{16} summarized/,
  );
  const record = jsonEvent({
    kind: 'compaction',
    run_id: 'r',
    parent_run_id: null,
    seq: 1,
    ts: '',
    payload: { sessionId: 's', phase: 'summarizing', trigger: 'auto' },
    tags: {},
  });
  assert.deepEqual(record, {
    type: 'compaction',
    sessionId: 's',
    phase: 'summarizing',
    trigger: 'auto',
  });
});
test('repeated summary usage and prices survive restart exactly once without modifying the raw message history', async (t) => {
  const root = scratch(t);
  const endpoint = defaultSettings();
  endpoint.auth.model = 'priced';
  const catalog = new ModelCatalog(root, {
    data: slimCatalog({
      own: {
        models: {
          priced: { limit: { context: 10000 }, cost: { input: 1, output: 2 } },
        },
      },
    }),
    env: {},
  });
  const model = new ScriptedModel(
    Array.from({ length: 2 }, (_, index) => ({
      message: {
        id: 'summary-' + index,
        role: 'assistant' as const,
        content: 'summary ' + index,
      },
      usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0 },
    })),
  );
  model.model = 'priced';
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: endpoint,
    model,
    catalog,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.store.append(runtime.session.id, history());
  const before = digest(runtime.harness.messages);
  await runtime.compact();
  runtime.store.append(
    runtime.session.id,
    history().map((message) => ({ ...message, id: 'next-' + message.id })),
  );
  await runtime.compact();
  const stats = runtime.stats();
  assert.equal(stats.usage.input_tokens, 200);
  assert.equal(stats.costs.calls, 2);
  assert.ok(Math.abs(stats.costs.amounts.USD! - 0.00024) < 1e-12);
  assert.equal(digest(runtime.harness.messages.slice(0, 10)), before);
  const id = runtime.session.id;
  await runtime.close();
  const resumed = new AgentRuntime({
    workspace: root,
    home: root,
    settings: endpoint,
    model: new ScriptedModel(),
    session: id,
    headless: true,
  });
  cleanup(t, () => resumed.close());
  assert.deepEqual(resumed.stats().usage, stats.usage);
  assert.deepEqual(resumed.stats().costs, stats.costs);
});
