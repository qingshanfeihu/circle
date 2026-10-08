import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { JobRegistry } from '../src/jobs.js';
import { Sandbox } from '../src/sandbox.js';
import { Watch, waitWatch } from '../src/watch.js';
import { ExtensionHost } from '../src/extensions.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { emptyUsage, type ChatModel, type Message } from '../src/types.js';
import {
  runningJobReminder,
  pollingJobReminder,
} from '../src/middleware/job_notice.js';
import { ContextManager } from '../src/context_middleware.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { scratch, cleanup } from './helpers.js';
const reply = (
  id: string,
  content: string,
  calls: Message['tool_calls'] = [],
) => ({
  message: { id, role: 'assistant' as const, content, tool_calls: calls },
  usage: emptyUsage(),
});
async function until(predicate: () => boolean, most = 5000): Promise<void> {
  const end = Date.now() + most;
  while (!predicate()) {
    if (Date.now() >= end)
      throw new Error('timed out waiting for actual watch state');
    await delay(10);
  }
}
test('a watch polls without a model turn, preserves false and zero results, and queues a conversation-owned completion notice', async (t) => {
  const root = scratch(t);
  const registry = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => registry.close().then(() => {}));
  let polls = 0;
  const job = registry.startWatch(
    new Watch(
      'remote run',
      async () => (++polls > 1 ? { verdict: 'pass', count: 0 } : null),
      { interval_s: 0.01 },
    ),
    { sessionId: 'owner', startedBy: 'model' },
    'lab',
  );
  assert.equal(job.kind, 'watch');
  assert.equal(job.source, 'lab');
  await registry.wait([job.id], 5, new AbortController().signal);
  assert.equal(registry.get(job.id)!.status, 'done');
  assert.match(readFileSync(job.outputPath, 'utf8'), /"count":0/);
  assert.equal(registry.takeNotices('other').length, 0);
  assert.match(registry.takeNotices('owner')[0]!.content, /"verdict":"pass"/);
  const zero = registry.startWatch(new Watch('zero', () => 0), {
    sessionId: 'owner',
  });
  await registry.wait([zero.id], 5, new AbortController().signal);
  assert.equal(registry.get(zero.id)!.status, 'done');
});
test('watch failures and deadlines remain failed, and stopping invokes cleanup exactly once before settlement', async (t) => {
  const root = scratch(t);
  const registry = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => registry.close().then(() => {}));
  const failed = registry.startWatch(
    new Watch('failed', () => {
      throw new Error('remote failure');
    }),
    { sessionId: 'owner' },
  );
  await registry.wait([failed.id], 5, new AbortController().signal);
  assert.equal(registry.get(failed.id)!.status, 'failed');
  assert.match(readFileSync(failed.outputPath, 'utf8'), /remote failure/);
  let stops = 0;
  const deadline = registry.startWatch(
    new Watch('deadline', () => null, {
      interval_s: 0.01,
      deadline_s: 0.02,
      on_stop: async () => {
        await delay(20);
        stops++;
      },
    }),
    { sessionId: 'owner' },
  );
  await registry.wait([deadline.id], 5, new AbortController().signal);
  assert.equal(registry.get(deadline.id)!.status, 'failed');
  assert.equal(registry.get(deadline.id)!.reason, 'timeout');
  assert.equal(stops, 1);
  let cleaned = false;
  const stopped = registry.startWatch(
    new Watch(
      'stop',
      async (signal) => {
        await delay(10000, undefined, { signal });
        return 'late';
      },
      {
        on_stop: async () => {
          await delay(20);
          cleaned = true;
          stops++;
        },
      },
    ),
    { sessionId: 'owner' },
  );
  await delay(10);
  await Promise.all([registry.stop(stopped.id), registry.stop(stopped.id)]);
  assert.equal(cleaned, true);
  assert.equal(stops, 2);
  assert.equal(registry.get(stopped.id)!.status, 'stopped');
  assert.ok(!readFileSync(stopped.outputPath, 'utf8').includes('late'));
});
test('stopping a watch aborts a real HTTP poll before the server writes a delayed side effect', async (t) => {
  const root = scratch(t);
  let reached = false;
  const marker = join(root, 'late');
  const server = createServer((_request, response) => {
    reached = true;
    const timer = setTimeout(() => {
      writeFileSync(marker, 'bad');
      response.end('late');
    }, 500);
    response.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const registry = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => registry.close().then(() => {}));
  const job = registry.startWatch(
    new Watch(
      'http',
      async (signal) =>
        await (
          await fetch(
            `http://127.0.0.1:${(server.address() as { port: number }).port}`,
            { signal },
          )
        ).text(),
    ),
    { sessionId: 'owner' },
  );
  await until(() => reached);
  await registry.stop(job.id, 'user');
  await delay(600);
  assert.equal(existsSync(marker), false);
  assert.equal(registry.get(job.id)!.status, 'stopped');
});
test('standalone extension watches await completion with cancellation and preserve asynchronous stop hooks', async (t) => {
  const root = scratch(t);
  const folder = join(root, 'extensions', 'waiter');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'extension.mjs'),
    `export function register(api){api.registerTool('watch_test','watch',{type:'object',properties:{}},()=>new api.Watch('result',()=>false),{readOnly:true});}`,
  );
  const host = new ExtensionHost({
    workspace: root,
    home: root,
    trusted: false,
  });
  await host.load();
  assert.equal(
    await host
      .tools()[0]!
      .run({}, { sessionId: 'owner', signal: new AbortController().signal }),
    'false',
  );
  let cleaned = 0;
  const controller = new AbortController();
  const pending = waitWatch(
    new Watch('cancel', () => null, {
      interval_s: 0.01,
      on_stop: () => {
        cleaned++;
      },
    }),
    controller.signal,
  );
  const rejected = assert.rejects(pending, /Interrupted/);
  controller.abort(new Error('Interrupted'));
  await rejected;
  assert.equal(cleaned, 1);
});
test('an approved extension returns immediately and its result enters the next actual model request without another tool call', async (t) => {
  const root = scratch(t);
  const folder = join(root, '.circle/extensions/watch');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'extension.mjs'),
    `export function register(api){api.registerTool('remote_run','submit',{type:'object',properties:{}},()=>{let n=0;return new api.Watch('remote',()=>++n>1?{verdict:'pass'}:null,{interval_s:0.01,result:{state:'pending'}})},{readOnly:true});}`,
  );
  const model = new ScriptedModel([
    reply('submit', '', [{ id: 'remote', name: 'remote_run', args: {} }]),
    reply('continue', 'watch is running'),
    reply('notice', 'result processed'),
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('submit');
  assert.match(
    runtime.harness.messages.find(
      (message) => message.tool_call_id === 'remote',
    )!.content,
    /"state":"pending"/,
  );
  await until(() => runtime.jobs.get('j1')?.status === 'done');
  await runtime.runJobNotices();
  assert.match(
    JSON.stringify(model.requests.at(-1)!.messages),
    /verdict.*pass/,
  );
  assert.equal(
    runtime.harness.messages.filter(
      (message) => message.tool_call_id === 'remote',
    ).length,
    1,
  );
});
test(
  'a finished job stops a real bare sleep process while foreign conversation completion does not',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = scratch(t);
    const registry = new JobRegistry(new Sandbox(root, join(root, 'data')));
    cleanup(t, () => registry.close().then(() => {}));
    let finishOwn = false;
    const own = registry.startWatch(
      new Watch('own', () => (finishOwn ? 'complete' : null), {
        interval_s: 0.01,
      }),
      { sessionId: 'owner' },
    );
    const foreign = registry.startWatch(new Watch('foreign', () => 'done'), {
      sessionId: 'other',
    });
    let settled = false;
    const started = Date.now();
    const sleeping = registry
      .execute('sleep 30', { sessionId: 'owner' }, new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });
    await registry.wait([foreign.id], 5, new AbortController().signal);
    await delay(50);
    assert.equal(settled, false);
    finishOwn = true;
    const result = await sleeping;
    assert.equal(result.exit_code, 0);
    assert.match(result.output, /background jobs ended/);
    assert.ok(Date.now() - started < 5000);
    assert.equal(registry.get(own.id)!.status, 'done');
  },
);
test('reminders name forgotten running jobs after compaction once and polling advice excludes productive commands and background sleeps', async (t) => {
  const root = scratch(t);
  const store = new CheckpointStore(root);
  cleanup(t, () => store.close());
  const session = store.create(root, 'test');
  store.append(
    session.id,
    Array.from({ length: 8 }, (_, index) => ({
      id: 'm' + index,
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: 'history',
    })),
  );
  store.setSummary(
    session.id,
    store.get(session.id)!.head!,
    'summary without jobs',
  );
  const job = {
    id: 'j1',
    sessionId: session.id,
    kind: 'watch' as const,
    title: 'remote run',
    status: 'running' as const,
    reason: '',
    started: Date.now(),
    outputPath: '',
    virtualPath: '/background_jobs/run/log',
  };
  const manager = new ContextManager(store, join(root, 'data'), {
    autoCompact: false,
    runningJobs: () => [job],
  });
  const first = await manager.prepare(
    session.id,
    new ScriptedModel(),
    '',
    [],
    new AbortController().signal,
  );
  assert.match(first.at(-1)!.content, /remote run/);
  await manager.prepare(
    session.id,
    new ScriptedModel(),
    '',
    [],
    new AbortController().signal,
  );
  assert.equal(
    store
      .messages(session.id)
      .filter((message) => message.internal === 'job_reminder').length,
    1,
  );
  assert.ok(
    runningJobReminder(
      [job],
      [{ id: 'similar', role: 'user', content: 'j10 is known' }],
    ),
  );
  const raw: Message[] = [
    { id: 'user', role: 'user', content: 'start' },
    {
      id: 'calls',
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'a', name: 'list_jobs', args: {} },
        { id: 'b', name: 'execute', args: { command: 'sleep 30' } },
      ],
    },
    { id: 'result', role: 'tool', tool_call_id: 'b', content: 'ok' },
  ];
  assert.match(
    pollingJobReminder([job], raw)!.content,
    /End your turn instead of polling/,
  );
  raw[1]!.tool_calls![1]!.args.background = true;
  assert.equal(pollingJobReminder([job], raw), undefined);
});
test('long single-line watch output remains in the log and its bounded notice contains real text', async (t) => {
  const root = scratch(t);
  const registry = new JobRegistry(new Sandbox(root, join(root, 'data')));
  cleanup(t, () => registry.close().then(() => {}));
  const result = '中文'.repeat(10000);
  const job = registry.startWatch(new Watch('large result', () => result), {
    sessionId: 'owner',
  });
  await registry.wait([job.id], 5, new AbortController().signal);
  assert.equal(readFileSync(job.outputPath, 'utf8'), result + '\n');
  const notice = registry.takeNotices('owner')[0]!.content;
  assert.match(notice, /中文/);
  assert.ok(notice.length < 5000);
  assert.ok(!notice.includes('�'));
});
test('a foreground child watch belongs to the visible conversation and is cleaned when that child reports', async (t) => {
  const root = scratch(t);
  const folder = join(root, '.circle/extensions/child-watch');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'extension.mjs'),
    `import fs from 'node:fs';import path from 'node:path';export function register(api){api.registerTool('start_watch','watch',{type:'object',properties:{}},()=>new api.Watch('child watch',()=>null,{interval_s:0.01,on_stop:()=>fs.writeFileSync(path.join(${JSON.stringify(root)},'cleaned'),'once')}),{readOnly:true});}`,
  );
  const model: ChatModel = {
    model: 'controlled',
    complete: async (request) => {
      const input = request.messages.find(
        (message) => message.role === 'user' && !message.internal,
      )!.content;
      const tool = request.messages.some((message) => message.role === 'tool');
      if (input === 'research')
        return tool
          ? reply('report', 'child complete')
          : reply('watch', '', [
              { id: 'watch', name: 'start_watch', args: {} },
            ]);
      return tool
        ? reply('main-complete', 'completed')
        : reply('main-task', '', [
            { id: 'task', name: 'task', args: { description: 'research' } },
          ]);
    },
  };
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('start');
  const watch = runtime.jobs.get('j1')!;
  assert.equal(watch.sessionId, runtime.session.id);
  assert.equal(watch.status, 'stopped');
  assert.ok(watch.parent);
  assert.equal(readFileSync(join(root, 'cleaned'), 'utf8'), 'once');
});
