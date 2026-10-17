import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DeliveryService } from '../src/workspace/delivery.ts';
import { GitWorkspaceService } from '../src/workspace/git.ts';
import { startNodeCliFixture } from './helpers/node-cli-fixture.ts';
import { WorkspaceEventStream } from '../src/workspace/event-stream.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { AgentRuntime } from '../../../src/runtime.ts';
import {
  defaultSettings,
  trustFolder,
  saveSettings,
  saveSettingsChange,
} from '../../../src/settings.ts';
import type { WorkspaceServiceEvent } from '../src/workspace-protocol.ts';
import { patience } from './helpers/patience.mjs';

// Windows refuses to rename a folder while anything holds a handle in it, such
// as a watcher that is closing or a virus scan, so retry for a short while.
async function moveAside(folder: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(folder, folder + '.old');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 50 || (code !== 'EBUSY' && code !== 'EPERM')) throw error;
      await delay(100);
    }
  }
}
const assistant = (content: string, calls?: any[]) => ({
  id: randomUUID(),
  role: 'assistant' as const,
  content,
  tool_calls: calls,
});
async function wait(check: () => boolean) {
  const until = Date.now() + patience(8000);
  while (!check()) {
    if (Date.now() > until) throw Error('fixture timed out');
    await delay(10);
  }
}
async function setup(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0] = [],
  trusted = true,
  extra: Partial<ConstructorParameters<typeof RuntimeController>[0]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-controller-services-'));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  await mkdir(home);
  await mkdir(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  saveSettings(
    trusted ? trustFolder(defaultSettings(), workspace) : defaultSettings(),
    home,
  );
  const model = new ScriptedModel(replies);
  const events: WorkspaceServiceEvent[] = [];
  const updates: any[] = [];
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: (u) => updates.push(u),
    emitWorkspaceEvent: (e) => events.push(e),
    ...extra,
  });
  const call = (
    name: string,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  const service = (
    name: string,
    method: string,
    params: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => call('workspace-service', { service: name, method, params }, sessionId);
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    workspace,
    model,
    controller,
    call,
    service,
    events,
    updates,
  };
}
test('language restart is performed once per host operation and readonly child sources cannot stop it', async (t) => {
  const f = await setup(
    t,
    Array.from({ length: 6 }, () => ({ message: assistant('read completed') })),
  );
  await writeFile(join(f.workspace, 'main.ts'), 'export const value = 1;\n');
  execFileSync('git', ['-C', f.workspace, 'add', 'main.ts']);
  execFileSync('git', [
    '-C',
    f.workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Create language fixture',
  ]);
  const parent = f.controller.snapshot().activeSessionId;
  const project = () => f.service('language', 'request', { method: 'project' });
  const before = await project();
  assert.equal(before.ok, true, before.error);
  const command = {
    id: randomUUID(),
    name: 'workspace-service' as const,
    sessionId: parent,
    payload: {
      service: 'language',
      method: 'request',
      params: { method: 'restart', path: 'main.ts' },
    },
  };
  const replies = await Promise.all([
    f.controller.dispatch(command),
    f.controller.dispatch(command),
  ]);
  for (const reply of replies) assert.equal(reply.ok, true, reply.error);
  const after = await project();
  assert.equal(after.ok, true, after.error);
  assert.equal((after.data as any).version, (before.data as any).version + 1);
  const replay = await f.controller.dispatch(command);
  assert.equal(replay.ok, true, replay.error);
  assert.equal(
    ((await project()).data as any).version,
    (after.data as any).version,
  );
  const invalidOuter = await f.service('language', 'restart', {
    method: 'definition',
    path: 'main.ts',
  });
  assert.equal(
    invalidOuter.ok,
    false,
    'the protocol rejects an invalid outer method before execution',
  );
  assert.equal(
    ((await project()).data as any).version,
    (after.data as any).version,
  );
  const enqueued = await f.service('tasks', 'enqueue', {
    operationId: 'language-reader',
    tasks: [
      {
        id: 'language-reader',
        prompt: 'Read main.ts',
        access: 'readonly',
        acceptanceCriteria: ['inspect actual source'],
      },
    ],
  });
  assert.equal(enqueued.ok, true, enqueued.error);
  await wait(() =>
    f.controller
      .snapshot()
      .agents.some((agent) => agent.task?.id === 'language-reader'),
  );
  const child = f.controller
    .snapshot()
    .agents.find((agent) => agent.task?.id === 'language-reader')!;
  const stopped = await f.service(
    'language',
    'request',
    { method: 'stop', path: 'main.ts' },
    child.id,
  );
  assert.equal(stopped.ok, false);
  assert.match(stopped.error ?? '', /read-only agent source/);
  assert.equal(
    ((await project()).data as any).version,
    (after.data as any).version,
  );
});
test('legacy write-file requires an explicit revision without changing existing or missing files', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'README.md'), 'human content');
  for (const path of ['README.md', 'not-created.txt']) {
    const denied = await f.call('write-file', {
      path,
      content: 'unversioned overwrite',
    });
    if (path === 'README.md')
      assert.equal(
        await readFile(join(f.workspace, path), 'utf8'),
        'human content',
        'an unversioned request must preserve the actual disk contents',
      );
    assert.equal(denied.ok, false);
    assert.match(denied.error!, /revision.*required.*read/i);
  }
  await assert.rejects(readFile(join(f.workspace, 'not-created.txt')), {
    code: 'ENOENT',
  });
  assert.equal(f.model.requests.length, 0);
});
test('legacy write-file rejects an earlier read revision and preserves the later human contents', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'README.md'), 'before');
  const read = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(read.ok, true, read.error);
  const revision = (read.data as { revision: string }).revision;
  await writeFile(join(f.workspace, 'README.md'), 'human after read');
  const denied = await f.call('write-file', {
    path: 'README.md',
    content: 'stale draft',
    expectedRevision: revision,
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /file changed on disk/);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'human after read',
  );
  assert.equal(f.model.requests.length, 0);
});
test('legacy write-file accepts null only for an explicit new file', async (t) => {
  const f = await setup(t);
  const created = await f.call('write-file', {
    path: 'nested/new.txt',
    content: 'new content',
    expectedRevision: null,
  });
  assert.equal(created.ok, true, created.error);
  assert.equal(
    await readFile(join(f.workspace, 'nested/new.txt'), 'utf8'),
    'new content',
  );
  const read = await f.service('documents', 'read', { path: 'nested/new.txt' });
  assert.equal(read.ok, true, read.error);
  assert.equal(
    (created.data as any).document.revision,
    (read.data as any).revision,
  );
  const collision = await f.call('write-file', {
    path: 'nested/new.txt',
    content: 'replace with null',
    expectedRevision: null,
  });
  assert.equal(collision.ok, false);
  assert.match(collision.error!, /file changed on disk/);
  assert.equal(
    await readFile(join(f.workspace, 'nested/new.txt'), 'utf8'),
    'new content',
  );
});
test('legacy write-file accepts the current read revision and returns the saved disk revision', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'README.md'), 'before');
  const read = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(read.ok, true, read.error);
  const revision = (read.data as { revision: string }).revision;
  const saved = await f.call('write-file', {
    path: 'README.md',
    content: 'versioned human save',
    expectedRevision: revision,
  });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'versioned human save',
  );
  const current = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(current.ok, true, current.error);
  assert.notEqual((saved.data as any).document.revision, revision);
  assert.equal(
    (saved.data as any).document.revision,
    (current.data as any).revision,
  );
  assert.equal(f.model.requests.length, 0);
});
test('busy and inactive known sessions can save with CAS without switching selection or publishing chat snapshots', async (t) => {
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        );
      }),
  ]);
  await writeFile(join(f.workspace, 'README.md'), 'before');
  const first = f.controller.snapshot().activeSessionId;
  assert.equal((await f.call('prompt', { text: 'stay active' })).ok, true);
  await wait(() => f.model.requests.length === 1);
  const initial = await f.service(
    'documents',
    'read',
    { path: 'README.md' },
    first,
  );
  assert.equal(initial.ok, true);
  assert.equal((await f.call('new-session')).ok, true);
  const selected = f.controller.snapshot().activeSessionId;
  assert.notEqual(first, selected);
  const count = f.updates.length;
  const doc = initial.data as any;
  const saved = await f.service(
    'documents',
    'save',
    {
      path: 'README.md',
      content: 'human edit',
      expectedRevision: doc.revision,
    },
    first,
  );
  assert.equal(saved.ok, true, saved.error);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'human edit',
  );
  assert.equal(f.controller.snapshot().activeSessionId, selected);
  assert.equal(f.updates.length, count);
  await wait(() => f.events.length > 0);
  const id = f.controller.snapshot().workspaces[0]!.id;
  assert.ok(f.events.every((event) => event.workspaceId === id));
  const replay = await f.service(
    'events',
    'replay',
    { after: { offset: 0, seq: 0 }, limit: 256 },
    first,
  );
  assert.equal(replay.ok, true, replay.error);
  assert.ok((replay.data as any).events.length);
  assert.equal(typeof (replay.data as any).cursor.offset, 'number');
  const conflict = await f.service(
    'documents',
    'save',
    {
      path: 'README.md',
      content: 'stale edit',
      expectedRevision: doc.revision,
    },
    first,
  );
  assert.equal(conflict.ok, false);
  assert.match(conflict.error!, /changed/);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'human edit',
  );
});
test('unknown and untrusted service requests cannot acquire workspace authority', async (t) => {
  const f = await setup(t, [], false);
  await writeFile(join(f.workspace, 'README.md'), 'untouched');
  const denied = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(denied.ok, false);
  assert.match(denied.error!, /trust/);
  const unknown = await f.service(
    'documents',
    'save',
    { path: 'README.md', content: 'bad', expectedRevision: null },
    'unknown-session',
  );
  assert.equal(unknown.ok, false);
  assert.match(unknown.error!, /session not found/);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'untouched',
  );
  assert.equal(f.events.length, 0);
});
test('foreign occupied viewed history can use workspace documents without acquiring its runtime lease', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'README.md'), 'foreign view');
  const settings = trustFolder(defaultSettings(), f.workspace);
  const foreign = new AgentRuntime({
    workspace: f.workspace,
    home: f.home,
    userHome: f.home,
    settings,
    model: new ScriptedModel([]),
  });
  try {
    const selected = await f.call('select-session', { id: foreign.session.id });
    assert.equal(selected.ok, true, selected.error);
    const read = await f.service(
      'documents',
      'read',
      { path: 'README.md' },
      foreign.session.id,
    );
    assert.equal(read.ok, true, read.error);
    assert.equal((read.data as any).content, 'foreign view');
    assert.equal(f.controller.snapshot().activeSessionId, foreign.session.id);
  } finally {
    await foreign.close();
  }
});
test('human save while agent write approval waits prevents stale agent overwrite', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        { id: 'read', name: 'read_file', args: { file_path: 'README.md' } },
      ]),
    },
    {
      message: assistant('', [
        {
          id: 'write',
          name: 'write_file',
          args: { file_path: 'README.md', content: 'agent stale' },
        },
      ]),
    },
    { message: assistant('stale write rejected') },
  ]);
  await writeFile(join(f.workspace, 'README.md'), 'before');
  await f.call('prompt', { text: 'read and update README' });
  await wait(() =>
    f.controller
      .snapshot()
      .interactions.some(
        (i) => i.kind === 'approval' && i.status === 'pending',
      ),
  );
  const read = await f.service('documents', 'read', { path: 'README.md' });
  const doc = read.data as any;
  const save = await f.service('documents', 'save', {
    path: 'README.md',
    content: 'human latest',
    expectedRevision: doc.revision,
  });
  assert.equal(save.ok, true, save.error);
  const approval = f.controller
    .snapshot()
    .interactions.find((i) => i.kind === 'approval' && i.status === 'pending')!;
  const answer = await f.call(
    'answer',
    { id: approval.id, revision: approval.revision, answer: 'approve' },
    approval.sessionId,
  );
  assert.equal(answer.ok, true, answer.error);
  await wait(() => f.model.requests.length >= 3);
  assert.equal(
    await readFile(join(f.workspace, 'README.md'), 'utf8'),
    'human latest',
  );
  assert.ok(
    f.model.requests[2]!.messages.some(
      (m) => m.role === 'tool' && /changed|revision|conflict/.test(m.content),
    ),
  );
});

test('loaded project rules expose their real source path in the native snapshot', async (t) => {
  const f = await setup(t, [
    { message: assistant('rules loaded') },
    { message: assistant('new session rules loaded') },
  ]);
  await writeFile(
    join(f.workspace, 'AGENTS.md'),
    'independent loaded rule marker',
  );
  await f.call('prompt', { text: 'load actual project context' });
  await wait(() => f.model.requests.length === 1);
  assert.ok(
    f.model.requests[0]!.tools.some(
      (tool) => tool.name === 'native_tasks_enqueue',
    ),
  );
  const instructions = f.controller
    .snapshot()
    .workspaces.find(
      (w) =>
        w.path ===
        f.controller.snapshot().workspaces.find((p) => p.trusted)?.path,
    )!.instructions;
  const rule = instructions.find((rule) =>
    rule.content.includes('independent loaded rule marker'),
  );
  assert.ok(rule);
  assert.ok(rule.path);
  assert.equal(
    await readFile(rule.path!, 'utf8'),
    'independent loaded rule marker',
  );
  await writeFile(join(f.workspace, 'AGENTS.md'), 'new session actual rule');
  await f.call('new-session');
  await f.call('prompt', { text: 'load changed rules in this session' });
  await wait(() => f.model.requests.length === 2);
  assert.ok(
    f.controller
      .snapshot()
      .workspaces.some((workspace) =>
        workspace.instructions.some((rule) =>
          rule.content.includes('new session actual rule'),
        ),
      ),
  );
});

test('task bridge runs isolated writers and read-only reviewer while task approval can be opened', async (t) => {
  const handler: NonNullable<
    ConstructorParameters<typeof ScriptedModel>[0]
  >[number] = async (request) => {
    const prompt =
      request.messages.find((m) => m.role === 'user')?.content ?? '';
    const match = /Task (left|right|review), attempt/.exec(prompt);
    if (!match)
      return {
        message: assistant('parent ready'),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
      };
    assert.ok(
      !request.tools.some(
        (tool) =>
          tool.name.startsWith('native_tasks_') &&
          tool.name !== 'native_tasks_propose',
      ),
    );
    const name = match[1];
    const hadTool = request.messages.some((m) => m.role === 'tool');
    return {
      message: hadTool
        ? assistant(`finished ${name}`)
        : assistant('', [
            {
              id: `${name}-call`,
              name: name === 'review' ? 'read_file' : 'write_file',
              args:
                name === 'review'
                  ? { file_path: 'README.md' }
                  : { file_path: 'same.txt', content: name },
            },
          ]),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    };
  };
  const f = await setup(t, Array(30).fill(handler));
  await writeFile(join(f.workspace, 'README.md'), 'baseline');
  execFileSync('git', ['-C', f.workspace, 'add', 'README.md']);
  execFileSync('git', [
    '-C',
    f.workspace,
    '-c',
    'user.name=Circle Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Baseline',
  ]);
  const parent = f.controller.snapshot().activeSessionId;
  const enqueue = await f.service(
    'tasks',
    'enqueue',
    {
      operationId: 'fixture-isolated-three',
      tasks: ['left', 'right', 'review'].map((id) => ({
        id,
        access: id === 'review' ? 'readonly' : 'write',
        prompt: `perform ${id}`,
        acceptanceCriteria: ['inspect actual result'],
      })),
    },
    parent,
  );
  assert.equal(enqueue.ok, true, enqueue.error);
  await wait(() =>
    f.controller.snapshot().interactions.some((i) => i.status === 'pending'),
  );
  const waiting = f.controller
    .snapshot()
    .interactions.find((i) => i.status === 'pending')!;
  const selected = await f.call('select-session', { id: waiting.sessionId });
  assert.equal(selected.ok, true, selected.error);
  assert.equal(f.controller.snapshot().activeSessionId, waiting.sessionId);
  await f.call('select-session', { id: parent });
  // A wall-clock bound, not a product target: after their last model reply the
  // three tasks still capture candidates and close runtimes in real worktrees,
  // which a Windows runner has taken more than the remaining 4 s to finish.
  const until = Date.now() + 30000;
  let tasks: any[] = [];
  const bridgeTimeline: unknown[] = [];
  while (Date.now() < until) {
    for (const row of f.controller
      .snapshot()
      .interactions.filter((i) => i.status === 'pending')) {
      const answer = await f.call(
        'answer',
        { id: row.id, revision: row.revision, answer: 'approve' },
        row.sessionId,
      );
      assert.equal(answer.ok, true, answer.error);
    }
    const list = await f.service('tasks', 'list', {}, parent);
    assert.equal(list.ok, true, list.error);
    const nextTasks = list.data as any[];
    if (JSON.stringify(tasks) !== JSON.stringify(nextTasks))
      bridgeTimeline.push({ at: Date.now(), tasks: nextTasks });
    tasks = nextTasks;
    if (
      tasks.every((task) =>
        ['needs_review', 'succeeded', 'failed'].includes(task.state),
      )
    )
      break;
    await delay(10);
  }
  let bridgeFailureReceipt: string | undefined;
  if (!tasks.every((task) => task.state === 'needs_review')) {
    const directory = join(import.meta.dirname, '../artifacts/runtime');
    await mkdir(directory, { recursive: true });
    bridgeFailureReceipt = join(
      directory,
      `controller-task-bridge-failure-${randomUUID()}.json`,
    );
    await writeFile(
      bridgeFailureReceipt,
      JSON.stringify(
        {
          deadline: until,
          observedAt: Date.now(),
          tasks,
          authoritativeAfterFailure: (
            await f.service('tasks', 'list', {}, parent)
          ).data,
          timeline: bridgeTimeline,
          interactions: f.controller.snapshot().interactions,
          modelRequestCount: f.model.requests.length,
          requests: f.model.requests,
          events: f.events,
          files: await Promise.all(
            tasks.map(async (task) => ({
              id: task.spec.id,
              worktree: task.worktree,
              content: task.worktree
                ? await readFile(join(task.worktree, 'same.txt'), 'utf8').catch(
                    (error) => String(error),
                  )
                : undefined,
            })),
          ),
        },
        null,
        2,
      ),
    );
  }
  assert.equal(tasks.length, 3);
  assert.ok(
    tasks.every((task) => task.state === 'needs_review'),
    JSON.stringify({
      bridgeFailureReceipt,
      tasks: tasks.map((t) => ({
        id: t.spec.id,
        state: t.state,
        reason: t.reason,
      })),
    }),
  );
  assert.notEqual(tasks[0].worktree, tasks[1].worktree);
  for (const id of ['left', 'right'])
    assert.equal(
      await readFile(
        join(tasks.find((task) => task.spec.id === id).worktree, 'same.txt'),
        'utf8',
      ),
      id,
    );
  await assert.rejects(readFile(join(f.workspace, 'same.txt')));
  assert.ok(f.events.some((event) => event.service === 'tasks'));
});

test('a replaced trusted root cannot redirect an existing session into another trusted repository', async (t) => {
  const f = await setup(t, [{ message: assistant('opened') }]);
  await writeFile(join(f.workspace, 'marker.txt'), 'A');
  const first = f.controller.snapshot().activeSessionId;
  const other = join(f.root, 'other');
  await mkdir(other);
  execFileSync('git', ['init', '-q', other]);
  await writeFile(join(other, 'marker.txt'), 'B');
  saveSettingsChange(f.home, (settings) =>
    Object.assign(settings, trustFolder(settings, other)),
  );
  const initial = await f.service(
    'documents',
    'read',
    { path: 'marker.txt' },
    first,
  );
  assert.equal(initial.ok, true);
  const revision = (initial.data as any).revision;
  await moveAside(f.workspace);
  await symlink(other, f.workspace, 'dir');
  for (const [service, method, params] of [
    ['documents', 'read', { path: 'marker.txt' }],
    [
      'documents',
      'save',
      { path: 'marker.txt', content: 'redirected', expectedRevision: revision },
    ],
    ['git', 'status', {}],
  ] as const) {
    const denied = await f.service(service, method, params, first);
    assert.equal(denied.ok, false);
    assert.match(denied.error!, /workspace root changed/);
  }
  const shell = await f.call(
    'shell',
    { command: 'node -e process.exit(0)' },
    first,
  );
  assert.equal(shell.ok, false);
  assert.match(shell.error!, /workspace root changed/);
  assert.equal(f.model.requests.length, 0);
  assert.equal(await readFile(join(other, 'marker.txt'), 'utf8'), 'B');
  assert.equal(
    await readFile(join(f.workspace + '.old', 'marker.txt'), 'utf8'),
    'A',
  );
  // Opening the folder again authorizes its own root. A session in it starts
  // with the first message from home, as in the application.
  const opened = await f.call('open-workspace', { path: other });
  assert.equal(opened.ok, true, opened.error);
  const begun = await f.call('begin-session', {
    workspaceId: (opened.data as { workspaceId: string }).workspaceId,
    text: 'read the marker',
    display: 'read the marker',
  });
  assert.equal(begun.ok, true, begun.error);
  const reopened = (begun.data as { sessionId: string }).sessionId;
  await wait(
    () =>
      f.controller
        .snapshot()
        .sessions.find((session) => session.id === reopened)
        ?.messages.some((message) => message.role === 'assistant') ?? false,
  );
  const independent = await f.service(
    'documents',
    'read',
    { path: 'marker.txt' },
    reopened,
  );
  assert.equal(independent.ok, true, independent.error);
  assert.equal((independent.data as any).content, 'B');
  await moveAside(other);
  await mkdir(other);
  await writeFile(join(other, 'marker.txt'), 'replacement inode');
  const replaced = await f.service(
    'documents',
    'read',
    { path: 'marker.txt' },
    reopened,
  );
  assert.equal(replaced.ok, false);
  assert.match(replaced.error!, /workspace root changed/);
  // A new conversation from home cannot start in the replaced folder either.
  const sessions = f.controller.snapshot().sessions.length;
  const refused = await f.call('begin-session', {
    workspaceId: (opened.data as { workspaceId: string }).workspaceId,
    text: 'start over',
    display: 'start over',
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error!, /workspace root changed/);
  assert.equal(f.controller.snapshot().sessions.length, sessions);
  assert.equal(f.model.requests.length, 1);
  assert.equal(
    await readFile(join(other, 'marker.txt'), 'utf8'),
    'replacement inode',
  );
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
test('archive refuses native processes and confirmed delete awaits only its owning PTY', async (t) => {
  const f = await setup(t);
  const first = f.controller.snapshot().activeSessionId;
  const create = () =>
    f.service('terminal', 'create', {
      command: {
        file: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
      },
    });
  const a = await create();
  assert.equal(a.ok, true, a.error);
  const pidA = (a.data as any).pid;
  assert.ok(alive(pidA));
  await f.call('new-session');
  const second = f.controller.snapshot().activeSessionId;
  const b = await create();
  assert.equal(b.ok, true, b.error);
  const pidB = (b.data as any).pid;
  const archive = await f.call('archive-session', {
    id: first,
    archived: true,
  });
  assert.equal(archive.ok, false);
  assert.match(archive.error!, /native resources/);
  const unconfirmed = await f.call('delete-session', { id: first });
  assert.equal(unconfirmed.ok, false);
  assert.match(unconfirmed.error!, /confirm/);
  assert.ok(alive(pidA));
  const deleted = await f.call('delete-session', {
    id: first,
    confirmed: true,
  });
  assert.equal(deleted.ok, true, deleted.error);
  await wait(() => !alive(pidA));
  assert.ok(alive(pidB));
  assert.equal(f.controller.snapshot().activeSessionId, second);
  const close = await f.service('terminal', 'close', {
    id: (b.data as any).id,
  });
  assert.equal(close.ok, true, close.error);
  await wait(() => !alive(pidB));
});

test('streaming token IPC sends deltas while final snapshots remain authoritative', async (t) => {
  const content = Array(128).fill('chunk ').join('');
  const f = await setup(t, [
    async (request) => {
      for (let i = 0; i < 128; i++) request.token('chunk ');
      return {
        message: assistant(content),
        usage: { input_tokens: 1, output_tokens: 128, cache_read_tokens: 0 },
      };
    },
  ]);
  const deltas: any[] = [];
  f.controller.options.emitTokenDelta = (delta) => deltas.push(delta);
  await f.call('prompt', { text: 'stream a response' });
  await wait(() =>
    f.controller
      .snapshot()
      .sessions.some((session) =>
        session.messages.some((message) => message.text === content),
      ),
  );
  assert.equal(deltas.length, 128);
  assert.equal(deltas.map((delta) => delta.text ?? '').join(''), content);
  assert.ok(
    deltas.every(
      (delta, index) => delta.seq === index + 1 && delta.baseSeq > 0,
    ),
  );
  assert.ok(
    f.updates.length < 20,
    'tokens must not amplify into full history snapshots',
  );
  assert.ok(f.updates.every((update) => update.event?.kind !== 'llm_token'));
  await wait(() => f.updates.some((update) => update.tokenStream?.seq === 128));
  assert.ok(
    f.updates
      .at(-1)
      .snapshot.sessions.some((session: any) =>
        session.messages.some((message: any) => message.text === content),
      ),
  );
});

test('workspace journal failure cancels its producers and remains visible after state polling', async (t) => {
  let aborted = false;
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(request.signal.reason);
          },
          { once: true },
        );
      }),
  ]);
  await writeFile(join(f.workspace, 'README.md'), 'existing document');
  await f.call('prompt', { text: 'stay running while native journal fails' });
  await wait(() => f.model.requests.length === 1);
  let attemptedJournal: string | undefined;
  const open = WorkspaceEventStream.open.bind(WorkspaceEventStream);
  // Corrupt the exact physical journal selected by the real service, rather
  // than duplicating its path/hash policy in the test (8.3 aliases differ).
  t.mock.method(
    WorkspaceEventStream,
    'open',
    async (
      path: string,
      options?: Parameters<typeof WorkspaceEventStream.open>[1],
    ) => {
      attemptedJournal = path;
      // Opening a directory with a+ is platform dependent on Windows. Corrupt
      // the actual journal bytes instead, preserving sibling PTY directories.
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{synthetic invalid journal record}\n');
      return open(path, options);
    },
  );
  const failed = await f.service('documents', 'read', { path: 'README.md' });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /JSON|Unexpected token|invalid/i);
  assert.ok(attemptedJournal?.endsWith('events.jsonl'));
  try {
    await wait(() => aborted);
  } catch (error) {
    throw Error(
      `${String(error)}: ${JSON.stringify({ attemptedJournal, failed, runtime: f.controller.snapshot().runtime, activeWorkspaces: [...(f.controller as any).runtimes.values()].map((runtime: any) => runtime.options.workspace) })}`,
    );
  }

  assert.match(
    f.controller.snapshot().runtime?.error ?? '',
    /persistence failed/,
  );
  await f.call('state');
  assert.match(
    f.controller.snapshot().runtime?.error ?? '',
    /persistence failed/,
  );
});

test('parent conversations share the configured app model pool without holding leases for whole turns', async (t) => {
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        );
      }),
    { message: assistant('second parent completed') },
  ]);
  const configured = await f.service('tasks', 'settings', {
    limits: { agents: 1 },
  });
  assert.equal(configured.ok, true, configured.error);
  const first = f.controller.snapshot().activeSessionId;
  await f.call('prompt', { text: 'first parent blocked' });
  await wait(() => f.model.requests.length === 1);
  await f.call('new-session');
  const second = f.controller.snapshot().activeSessionId;
  await f.call('prompt', { text: 'second parent queued' });
  await delay(50);
  assert.equal(f.model.requests.length, 1);
  await f.call('select-session', { id: first });
  await f.call('abort');
  await wait(() => f.model.requests.length === 2);
  await wait(
    () =>
      f.controller
        .snapshot()
        .sessions.find((s) => s.id === second)
        ?.messages.some((m) => m.text === 'second parent completed') === true,
  );
});

test('completed native saves survive controller restart without replaying writes', async (t) => {
  const f = await setup(t);
  await writeFile(join(f.workspace, 'answer.txt'), 'before');
  const read = await f.service('documents', 'read', { path: 'answer.txt' });
  assert.equal(read.ok, true, read.error);
  const command = {
    id: randomUUID(),
    name: 'workspace-service',
    sessionId: f.controller.snapshot().activeSessionId,
    payload: {
      service: 'documents',
      method: 'save',
      params: {
        path: 'answer.txt',
        content: 'saved once',
        expectedRevision: (read.data as any).revision,
      },
    },
  };
  const saved = await f.controller.dispatch(command);
  assert.equal(saved.ok, true, saved.error);
  await f.controller.close();
  await writeFile(join(f.workspace, 'answer.txt'), 'external edit after save');
  const restarted = new RuntimeController({
    home: f.home,
    workspace: f.workspace,
    userHome: f.home,
    model: new ScriptedModel([]),
    emit: () => {},
  });

  const replay = await restarted.dispatch(command);
  assert.equal(replay.ok, true, replay.error);
  assert.deepEqual(replay.data, saved.data);
  assert.equal(
    await readFile(join(f.workspace, 'answer.txt'), 'utf8'),
    'external edit after save',
  );
  const different = await restarted.dispatch({
    ...command,
    payload: {
      ...command.payload,
      params: { ...command.payload.params, content: 'wrong second input' },
    },
  });
  assert.equal(different.ok, false);
  assert.equal(
    await readFile(join(f.workspace, 'answer.txt'), 'utf8'),
    'external edit after save',
  );
  await restarted.close();
});

test('pending operation review is restricted to its owning session and never replays effects', async (t) => {
  const f = await setup(t);
  const owner = f.controller.snapshot().activeSessionId;
  const operationId = randomUUID();
  const failed = await f.controller.dispatch({
    id: operationId,
    name: 'workspace-service',
    sessionId: owner,
    payload: {
      service: 'terminal',
      method: 'write',
      params: { id: 'missing-terminal', data: 'private input' },
    },
  });
  assert.equal(failed.ok, false);
  const listed = await f.service('operations', 'list', {
    state: 'needs_review',
  });
  assert.equal(listed.ok, true, listed.error);
  const metadata = (listed.data as any[]).find((row) => row.id === operationId);
  assert.equal(metadata.sessionId, owner);
  assert.equal(JSON.stringify(metadata).includes('private input'), false);
  await f.call('new-session');
  const foreign = await f.service('operations', 'review', {
    id: operationId,
    note: 'checked',
  });
  assert.equal(foreign.ok, false);
  const reviewed = await f.service(
    'operations',
    'review',
    { id: operationId, note: 'confirmed no terminal was created' },
    owner,
  );
  assert.equal(reviewed.ok, true, reviewed.error);
  assert.equal((reviewed.data as any).state, 'reconciled');
  const pending = await f.service(
    'operations',
    'list',
    { state: 'needs_review' },
    owner,
  );
  assert.equal((pending.data as any[]).length, 0);
});
test('controller task verification executes a pinned project oracle in an isolated candidate', async (t) => {
  const handler = async (request: any) => ({
    message: request.messages.some((m: any) => m.role === 'tool')
      ? assistant('implemented answer')
      : assistant('', [
          {
            id: 'oracle-write',
            name: 'write_file',
            args: { file_path: 'answer.txt', content: '42' },
          },
        ]),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  });
  const f = await setup(t, Array(15).fill(handler));
  await mkdir(join(f.workspace, '.circle'));
  await writeFile(
    join(f.workspace, 'package.json'),
    JSON.stringify({ scripts: { test: 'node verify.cjs' } }),
  );
  await writeFile(
    join(f.workspace, 'verify.cjs'),
    "if(require('node:fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)",
  );
  await writeFile(join(f.workspace, 'answer.txt'), '0');
  await writeFile(
    join(f.workspace, '.circle/verification.json'),
    JSON.stringify({
      version: 1,
      checks: [
        {
          criterion: 'answer is 42',
          script: 'test',
          oraclePaths: ['verify.cjs'],
        },
      ],
    }),
  );
  execFileSync('git', [
    '-C',
    f.workspace,
    'add',
    'package.json',
    'verify.cjs',
    'answer.txt',
    '.circle/verification.json',
  ]);
  execFileSync('git', [
    '-C',
    f.workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Baseline',
  ]);
  const parent = f.controller.snapshot().activeSessionId;
  const started = await f.service(
    'tasks',
    'enqueue',
    {
      operationId: 'controller-oracle',
      tasks: [
        {
          id: 'oracle',
          access: 'write',
          prompt: 'write answer.txt with 42',
          acceptanceCriteria: ['answer is 42'],
        },
      ],
    },
    parent,
  );
  assert.equal(started.ok, true, started.error);
  let task: any;
  const deadline = Date.now() + patience(15000);
  while (Date.now() < deadline) {
    for (const interaction of f.controller
      .snapshot()
      .interactions.filter((i) => i.status === 'pending'))
      await f.call(
        'answer',
        {
          id: interaction.id,
          revision: interaction.revision,
          answer: 'approve',
        },
        interaction.sessionId,
      );
    const list = await f.service('tasks', 'list', {}, parent);
    task = (list.data as any[])?.[0];
    if (task && ['succeeded', 'failed', 'needs_review'].includes(task.state))
      break;
    await delay(20);
  }
  assert.equal(task?.state, 'succeeded', JSON.stringify(task));
  assert.equal(await readFile(join(f.workspace, 'answer.txt'), 'utf8'), '0');
  assert.equal(await readFile(join(task.worktree, 'answer.txt'), 'utf8'), '42');
});

test('controller isolates same-named cycles by session and repairs real PR checks before human merge', async (t) => {
  // Observe actual operations without substituting results or caching scans.
  // Nested spans distinguish Git process time from verifier/reviewer wall time.
  const operationTimings: unknown[] = [];
  let operationSequence = 0;
  async function timed<T>(
    kind: string,
    details: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    const id = ++operationSequence;
    const startedAt = Date.now();
    const start = performance.now();
    operationTimings.push({ id, kind, event: 'start', startedAt, ...details });
    try {
      const result = await run();
      operationTimings.push({
        id,
        kind,
        event: 'end',
        startedAt,
        endedAt: Date.now(),
        durationMs: performance.now() - start,
        status: 'completed',
        ...details,
      });
      return result;
    } catch (error) {
      operationTimings.push({
        id,
        kind,
        event: 'end',
        startedAt,
        endedAt: Date.now(),
        durationMs: performance.now() - start,
        status: 'failed',
        error: String(error),
        ...details,
      });
      throw error;
    }
  }
  const actualGit = GitWorkspaceService.prototype.git;
  const actualSnapshot = GitWorkspaceService.prototype.snapshot;
  t.mock.method(
    GitWorkspaceService.prototype,
    'git',
    function (
      this: GitWorkspaceService,
      args: string[],
      input?: string,
      invocation?: Parameters<GitWorkspaceService['git']>[2],
    ) {
      return timed(
        'git',
        {
          cwd: this.root,
          args,
          inputBytes: input === undefined ? 0 : Buffer.byteLength(input),
        },
        () => actualGit.call(this, args, input, invocation),
      );
    },
  );
  t.mock.method(
    GitWorkspaceService.prototype,
    'snapshot',
    function (this: GitWorkspaceService) {
      return timed('git.snapshot', { cwd: this.root }, () =>
        actualSnapshot.call(this),
      );
    },
  );
  const tools = await mkdtemp(join(tmpdir(), 'circle-cycle-gh-'));
  const cliTranscript = join(
    import.meta.dirname,
    '../artifacts/runtime',
    `controller-cli-${randomUUID()}.jsonl`,
  );
  t.after(async () => {
    await mkdir(dirname(cliTranscript), { recursive: true });
    await writeFile(
      cliTranscript,
      await readFile(join(tools, 'calls'), 'utf8').catch((error) =>
        JSON.stringify({ error: String(error) }),
      ),
    );
    await writeFile(
      cliTranscript.replace('controller-cli-', 'controller-operation-'),
      operationTimings.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    );
    await rm(tools, { recursive: true, force: true });
  });
  const gh = join(tools, 'fake-gh.cjs');
  await writeFile(
    gh,
    `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path'),crypto=require('node:crypto');
function execute(args){
 const cwd=process.cwd(),key=crypto.createHash('sha256').update(cwd).digest('hex'),state=path.join(${JSON.stringify(tools)},key+'.json');
 const git=(...args)=>cp.execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 const pr=()=>({number:1,url:'https://example.invalid/pull/1',isDraft:!fs.existsSync(state+'.ready'),headRefOid:git('rev-parse','HEAD'),headRefName:git('branch','--show-current'),state:'OPEN'});
 let result;
 try {
  let stdout='',code=0;
  if(args[0]==='api'&&args[1]==='user')stdout=JSON.stringify({login:'fixture',id:7});
  else if(args[0]==='pr'&&args[1]==='create'){fs.writeFileSync(state,'{}');stdout='created'}
  else if(args[0]==='pr'&&args[1]==='view'){if(!fs.existsSync(state))code=1;else stdout=JSON.stringify(pr())}
  else if(args[0]==='pr'&&args[1]==='list')stdout='[]';
  else if(args[0]==='pr'&&args[1]==='checks'){const pass=fs.readFileSync('app.cjs','utf8').includes('readyForCI=true');stdout=JSON.stringify([{name:'integration',bucket:pass?'pass':'fail',state:pass?'SUCCESS':'FAILURE',link:'https://example.invalid/actions/runs/19'}])}
  else if(args[0]==='pr'&&args[1]==='ready'){fs.writeFileSync(state+'.ready','yes');stdout='ready'}
  else if(args[0]==='run'&&args[1]==='view')stdout='CI requires readyForCI=true; repair app.cjs';
  else if(args[0]==='auth')stdout='authenticated';
  else if(args[0]==='--version')stdout='gh version 2.83.2';
  else {code=2;stdout=''}
  result={code,stdout:stdout+'\\n',stderr:code?'fixture command unavailable':''};
 } catch(error){result={code:1,stdout:error.stdout?String(error.stdout):'',stderr:String(error)}}
 fs.appendFileSync(${JSON.stringify(join(tools, 'calls'))},JSON.stringify({args,cwd,argv:process.argv,pid:process.pid,result,at:new Date().toISOString()})+'\\n');
 return result;
}
if(process.argv[2]==='--ipc'){
 process.on('message',request=>{try{process.chdir(request.cwd);process.argv=[process.execPath,__filename,...request.args];process.send({id:request.id,...execute(process.argv.slice(2))})}catch(error){process.send({id:request.id,code:1,stdout:'',stderr:String(error)})}});
}else{const result=execute(process.argv.slice(2));process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exitCode=result.code;}
`,
    { mode: 0o600 },
  );
  const executeFixture = promisify(execFile);
  const oneShot = await executeFixture(process.execPath, [gh, '--version'], {
    encoding: 'utf8',
  });
  assert.match(
    oneShot.stdout,
    /gh version 2\.83\.2/,
    'one-shot real Node CLI portability remains covered',
  );
  const fixtureProcess = await startNodeCliFixture(gh);
  t.after(() => fixtureProcess.close());
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const transports: { file: string; args: string[]; cwd: string }[] = [];
  // Only CLI startup is shared. The actual child receives every argv/cwd and
  // checks real Git HEAD/branch/files; DeliveryService still owns PR/CI gates.
  t.mock.method(
    DeliveryService.prototype,
    'gh',
    async function (this: DeliveryService, args: string[]) {
      transports.push({
        file: process.execPath,
        args: [gh, ...args],
        cwd: this.root,
      });
      return fixtureProcess.call(args, this.root);
    },
  );
  const handler = async (request: any) => ({
    message: request.messages.some((m: any) => m.role === 'tool')
      ? assistant('candidate ready')
      : assistant('', [
          {
            id: randomUUID(),
            name: 'write_file',
            args: {
              file_path: 'app.cjs',
              content: `exports.answer=42;exports.readyForCI=${request.messages.some((m: any) => typeof m.content === 'string' && m.content.includes('Repair the failed CI'))};`,
            },
          },
        ]),
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  });
  const f = await setup(t, Array(80).fill(handler), true, {
    workspaceTools: {
      nodeExecutable: process.execPath,
      runtimeExecutable: process.execPath,
      adapterPath: 'unused',
      ghPath: gh,
    },
  });
  const controller = f.controller as any;
  const profile = controller.githubConnection();
  let finishGrant!: () => void;
  t.mock.method(profile.login, 'spawn', () => ({
    onData: () => {},
    onExit: (callback: any) => {
      finishGrant = () => callback({ exitCode: 0 });
    },
    write: () => {},
    kill: () => finishGrant?.(),
  }));
  t.mock.method(profile.login, 'credentialCommand', async () => ({
    stdout: 'synthetic-explicit-fixture-grant',
  }));
  t.mock.method(
    profile,
    'command',
    async (
      args: string[],
      env: NodeJS.ProcessEnv,
      cwd: string,
      signal?: AbortSignal,
    ) => {
      assert.equal(env.GH_TOKEN, 'synthetic-explicit-fixture-grant');
      signal?.throwIfAborted();
      const result = await fixtureProcess.call(args, cwd);
      signal?.throwIfAborted();
      return result;
    },
  );

  const actualVerifier = controller.taskVerifier.bind(controller);
  const wrappedVerifiers = new WeakMap<Function, Function>();
  t.mock.method(
    controller,
    'taskVerifier',
    (workspace: string, baseline: string) => {
      const verifier = actualVerifier(workspace, baseline);
      let wrapped = wrappedVerifiers.get(verifier);
      if (!wrapped) {
        wrapped = (task: any, context: any) =>
          timed(
            'task.verify',
            {
              taskId: task.spec.id,
              baseline: task.spec.baseline,
              cwd: context.worktree,
              attempt: task.attempt,
            },
            () => verifier(task, context),
          );
        wrappedVerifiers.set(verifier, wrapped);
      }
      return wrapped;
    },
  );
  try {
    execFileSync('git', ['-C', f.workspace, 'config', 'user.name', 'Fixture']);
    execFileSync('git', [
      '-C',
      f.workspace,
      'config',
      'user.email',
      'fixture@example.invalid',
    ]);
    await mkdir(join(f.workspace, '.circle'));
    await writeFile(
      join(f.workspace, 'app.cjs'),
      'exports.answer=0;exports.readyForCI=false;',
    );
    await writeFile(
      join(f.workspace, 'package.json'),
      JSON.stringify({ scripts: { test: 'node oracle.cjs' } }),
    );
    await writeFile(
      join(f.workspace, 'oracle.cjs'),
      "require('node:assert/strict').equal(require('./app.cjs').answer,42)",
    );
    await writeFile(
      join(f.workspace, '.circle/verification.json'),
      JSON.stringify({
        version: 1,
        checks: [
          {
            criterion: 'answer equals 42',
            script: 'test',
            oraclePaths: ['oracle.cjs'],
          },
        ],
      }),
    );
    execFileSync('git', [
      '-C',
      f.workspace,
      'add',
      'app.cjs',
      'package.json',
      'oracle.cjs',
      '.circle/verification.json',
    ]);
    execFileSync('git', ['-C', f.workspace, 'commit', '-qm', 'Baseline']);
    const remote = join(f.root, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['-C', f.workspace, 'remote', 'add', 'origin', remote]);
    execFileSync('git', [
      '-C',
      f.workspace,
      'push',
      '-q',
      '-u',
      'origin',
      'HEAD',
    ]);
    // Only this trusted fixture substitutes a local bare transport after the
    // production URL/epoch/grant checks. No token is sent to that transport.
    const githubPushUrl = 'https://github.com/fixture/repo.git';
    execFileSync('git', [
      '-C',
      f.workspace,
      'config',
      'remote.origin.pushurl',
      githubPushUrl,
    ]);
    const actualAuthentication = profile.gitPushAuthentication.bind(profile);
    t.mock.method(
      profile,
      'gitPushAuthentication',
      (
        epoch: number,
        repository: string,
        signal?: AbortSignal,
        guard?: () => void,
      ) => {
        const authentication = actualAuthentication(
          epoch,
          repository,
          signal,
          guard,
        );
        return {
          repository,
          withCredentials: (
            run: (env: NodeJS.ProcessEnv, config: string[]) => Promise<string>,
          ) =>
            authentication.withCredentials(
              (env: NodeJS.ProcessEnv, config: string[]) => {
                assert.equal(env.GH_TOKEN, 'synthetic-explicit-fixture-grant');
                return run({ ...env, GH_TOKEN: undefined }, [
                  ...config,
                  '-c',
                  'protocol.file.allow=always',
                  '-c',
                  `url.${remote.replaceAll('\\', '/')}.insteadOf=${githubPushUrl}`,
                ]);
              },
            ),
        };
      },
    );
    const enabled = await f.call('save-settings', {
      settings: {},
      extensions: [{ name: 'github', enabled: true }],
    });
    assert.equal(enabled.ok, true, enabled.error);
    await wait(() =>
      f.controller
        .snapshot()
        .extensions.some(
          (entry) =>
            entry.name === 'github' &&
            entry.enabled &&
            (entry.view as { provider?: string })?.provider === 'github',
        ),
    );
    const grant = await f.call('custom-command', {
      name: 'github',
      args:
        'connect ' +
        JSON.stringify({ storage: 'session', repositories: ['fixture/repo'] }),
    });
    assert.equal(grant.ok, true, grant.error);
    finishGrant();
    await wait(() =>
      f.controller
        .snapshot()
        .extensions.some(
          (entry) => (entry.view as { state?: string })?.state === 'connected',
        ),
    );
    assert(
      !JSON.stringify(f.controller.snapshot()).includes(
        'synthetic-explicit-fixture-grant',
      ),
    );
    const ownerA = f.controller.snapshot().activeSessionId;
    await f.call('new-session');
    const ownerB = f.controller.snapshot().activeSessionId;
    for (const owner of [ownerA, ownerB]) {
      await wait(
        () =>
          controller.runtimes
            .get(owner)
            ?.extensions.commands()
            .has('github') === true,
      );
      const created = await f.service(
        'cycles',
        'create',
        {
          id: 'same-cycle',
          operationId: 'create-' + owner,
          title: 'Implement answer',
          body: 'Set app answer to42',
          acceptanceCriteria: ['answer equals 42'],
        },
        owner,
      );
      assert.equal(created.ok, true, created.error);
    }
    // A wall-clock bound for the whole scenario, not a product target. Two real
    // cycles take about 6 s on Apple silicon; the work is CPU-bound and the
    // Intel macOS runner needed 33 s and once more than 60 s, so the bound leaves room for that runner.
    const end = Date.now() + 150000;
    const final = new Map<string, any>();
    const observedAt = new Map<string, number>();
    const timeline: unknown[] = [];
    let answering = true;
    // Human approval remains responsive while a cycle is doing Git/verification;
    // awaiting an advance must not suspend the test's independent user actor.
    const approvalActor = (async () => {
      while (answering) {
        for (const interaction of f.controller
          .snapshot()
          .interactions.filter((item) => item.status === 'pending')) {
          await f.call(
            'answer',
            {
              id: interaction.id,
              revision: interaction.revision,
              answer: 'approve',
            },
            interaction.sessionId,
          );
        }
        await delay(10);
      }
    })();
    try {
      while (Date.now() < end) {
        // Independent owner worktrees must advance concurrently. A slow B Git
        // operation cannot prevent observing A's background delivery progress.
        await Promise.all(
          [ownerA, ownerB].map(async (owner) => {
            const advanced = await f.service(
              'cycles',
              'advance',
              { id: 'same-cycle' },
              owner,
            );
            assert.equal(advanced.ok, true, advanced.error);
            // The return value can predate background timer progress while the
            // other owner was doing work. Read the authoritative ledger snapshot.
            const observed = await f.service(
              'cycles',
              'snapshot',
              { id: 'same-cycle' },
              owner,
            );
            assert.equal(observed.ok, true, observed.error);
            if (
              JSON.stringify(final.get(owner)) !== JSON.stringify(observed.data)
            )
              timeline.push({ at: Date.now(), owner, cycle: observed.data });
            final.set(owner, observed.data);
            observedAt.set(owner, Date.now());
          }),
        );
        if (
          [...final.values()].every(
            (cycle) => cycle.state === 'pending_human_merge',
          )
        )
          break;
        await delay(30);
      }
    } finally {
      answering = false;
      await approvalActor;
    }
    const passed =
      final.size === 2 &&
      [...final.entries()].every(
        ([owner, cycle]) =>
          cycle.state === 'pending_human_merge' &&
          Date.parse(cycle.updatedAt) <= end &&
          observedAt.get(owner)! <= end,
      );
    let failureReceipt: string | undefined;
    if (!passed) {
      const taskReply = await f.service('tasks', 'list', {}, ownerA);
      const records = (taskReply.data ?? []) as any[];
      const receipt = {
        cliTranscript,
        operationTimings,
        cycles: [...final.values()],
        deadline: end,
        finalObservations: Object.fromEntries(observedAt),
        observedAt: Date.now(),
        authoritativeAfterFailure: await Promise.all(
          [ownerA, ownerB].map(async (owner) => ({
            owner,
            reply: await f.service(
              'cycles',
              'snapshot',
              { id: 'same-cycle' },
              owner,
            ),
          })),
        ),
        timeline,
        tasks: await Promise.all(
          records.map(async (task) => ({
            ...task,
            actualCandidate: task.worktree
              ? await readFile(join(task.worktree, 'app.cjs'), 'utf8').catch(
                  (error) => String(error),
                )
              : undefined,
          })),
        ),
        interactions: f.controller.snapshot().interactions,
        modelRequestCount: f.model.requests.length,
        events: f.events,
      };
      const directory = join(import.meta.dirname, '../artifacts/runtime');
      await mkdir(directory, { recursive: true });
      failureReceipt = join(
        directory,
        `controller-cycle-failure-${randomUUID()}.json`,
      );
      await writeFile(failureReceipt, JSON.stringify(receipt, null, 2));
    }
    assert.deepEqual(
      [...final.values()].map((cycle) => cycle.state),
      ['pending_human_merge', 'pending_human_merge'],
      JSON.stringify({ failureReceipt, cycles: [...final.values()] }),
    );
    assert.ok(
      passed,
      JSON.stringify({
        failureReceipt,
        deadline: end,
        readyAt: [...final.values()].map((cycle) => cycle.updatedAt),
      }),
    );
    const tasks = await f.service('tasks', 'list', {}, ownerA);
    const owners = new Set(
      (tasks.data as any[]).map((task) => task.spec.sessionId),
    );
    assert.ok(owners.has(ownerA) && owners.has(ownerB));
    assert.ok(
      (tasks.data as any[]).length >= 4,
      'both cycles spawned independent repair tasks',
    );
    assert.equal(
      await readFile(join(f.workspace, 'app.cjs'), 'utf8'),
      'exports.answer=0;exports.readyForCI=false;',
    );
    const calls = await readFile(join(tools, 'calls'), 'utf8');
    assert.ok(calls.includes('"ready"'));
    assert.equal(calls.includes('"merge"'), false);
    const commandRecords = calls
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const allIPCRecords = commandRecords.filter(
      (record) => record.pid === fixtureProcess.pid,
    );
    const identityRecords = allIPCRecords.filter(
      (record) => record.args[0] === 'api',
    );
    assert.equal(
      identityRecords.length,
      1,
      'the explicit grant verifies identity through the real local Node fixture',
    );
    assert.deepEqual(identityRecords[0].args, [
      'api',
      'user',
      '--include',
      '--jq',
      '{login: .login, id: .id}',
    ]);
    const ipcRecords = allIPCRecords.filter(
      (record) => record.args[0] !== 'api',
    );
    assert.equal(
      allIPCRecords.length,
      transports.length + identityRecords.length,
    );
    assert.equal(
      ipcRecords.length,
      transports.length,
      'each requested CLI action has a persisted child-process record',
    );
    for (const [index, record] of ipcRecords.entries()) {
      assert.deepEqual(record.args, transports[index].args.slice(1));
      assert.deepEqual(
        record.argv.slice(2),
        record.args,
        'actual child argv tracks the current request',
      );
      assert.equal(
        realpathSync.native(record.cwd),
        realpathSync.native(transports[index].cwd),
      );
    }
    assert.equal(
      new Set(ipcRecords.map((record) => record.pid)).size,
      1,
      'one owned Node fixture process serves all CLI actions',
    );
    assert.equal(
      ipcRecords.filter(
        (record) => record.args[0] === 'pr' && record.args[1] === 'create',
      ).length,
      2,
    );
    assert.equal(
      ipcRecords.filter(
        (record) => record.args[0] === 'pr' && record.args[1] === 'ready',
      ).length,
      2,
    );
    assert.ok(
      ipcRecords.some((record) => record.result.code !== 0),
      'missing-PR CLI errors retain their real nonzero status',
    );
    const checkRecords = ipcRecords.filter(
      (record) => record.args[0] === 'pr' && record.args[1] === 'checks',
    );
    assert.ok(
      checkRecords.some((record) =>
        JSON.parse(record.result.stdout).some(
          (check: any) => check.bucket === 'fail',
        ),
      ),
    );
    assert.ok(
      checkRecords.some((record) =>
        JSON.parse(record.result.stdout).every(
          (check: any) => check.bucket === 'pass',
        ),
      ),
    );

    assert.ok(transports.length > 0);
    assert.ok(
      transports.every(
        (call) => call.file === process.execPath && call.args[0] === gh,
      ),
    );
    assert.ok(
      transports.every(
        (call) =>
          realpathSync.native(call.cwd) !== realpathSync.native(f.workspace),
      ),
      'CLI operates only in the owned integration worktrees',
    );
    assert.equal(
      process.env.NODE_OPTIONS,
      originalNodeOptions,
      'fixture transport does not change global Node options',
    );
  } finally {
    await f.controller.close();
    await fixtureProcess.close();
    assert.equal(
      fixtureProcess.exited,
      true,
      'owned fixture process close is awaited',
    );
  }
});

test('nested agent patch reports committed paths to the next model after a real competing disk write', async (t) => {
  const f = await setup(t, [
    {
      message: assistant('', [
        {
          id: 'partial-patch',
          name: 'apply_patch',
          args: {
            patchText:
              '*** Begin Patch\n*** Update File: nested/a.ts\n@@\n-old A\n+agent A\n*** Update File: nested/b.ts\n@@\n-old B\n+agent B\n*** End Patch',
          },
        },
      ]),
    },
    { message: assistant('inspect partial result') },
  ]);
  await mkdir(join(f.workspace, 'nested'));
  await writeFile(join(f.workspace, 'nested/a.ts'), 'old A\n');
  await writeFile(join(f.workspace, 'nested/b.ts'), 'old B\n');
  await f.service('documents', 'read', { path: 'nested/a.ts' });
  const documents = (f.controller as any).services(
    realpathSync.native(f.workspace),
  ).documents;
  const readTarget = documents.readTarget.bind(documents);
  let triggered = false;
  t.mock.method(documents, 'readTarget', async (...args: any[]) => {
    const result = await readTarget(...args);
    if (
      args[1] === 'nested/a.ts' &&
      result.content === 'agent A\n' &&
      !triggered
    ) {
      triggered = true;
      await writeFile(join(f.workspace, 'nested/b.ts'), 'external B\n');
    }
    return result;
  });
  const started = await f.call('prompt', { text: 'update both nested files' });
  assert.equal(started.ok, true, started.error);
  await wait(() =>
    f.controller.snapshot().interactions.some((i) => i.status === 'pending'),
  );
  const approval = f.controller
    .snapshot()
    .interactions.find((i) => i.status === 'pending')!;
  await f.call(
    'answer',
    { id: approval.id, revision: approval.revision, answer: 'approve' },
    approval.sessionId,
  );
  await wait(() => f.model.requests.length >= 2);
  assert.equal(
    await readFile(join(f.workspace, 'nested/a.ts'), 'utf8'),
    'agent A\n',
  );
  assert.equal(
    await readFile(join(f.workspace, 'nested/b.ts'), 'utf8'),
    'external B\n',
  );
  const result = f.model.requests[1].messages
    .filter((m) => m.role === 'tool')
    .map((m) => m.content)
    .join('\n');
  assert.match(result, /committed paths: nested\/a\.ts/);
  assert.match(result, /failures: nested\/b\.ts/);
});

test('native document access applies trusted project credential file rules', async (t) => {
  const f = await setup(t);
  await mkdir(join(f.workspace, '.circle'));
  await writeFile(
    join(f.workspace, '.circle/settings.json'),
    JSON.stringify({ credential_files: ['private.fixture'] }),
  );
  await writeFile(
    join(f.workspace, 'private.fixture'),
    'synthetic protected value',
  );
  for (const [method, params] of [
    ['read', { path: 'private.fixture' }],
    [
      'save',
      { path: 'private.fixture', content: 'bad', expectedRevision: null },
    ],
    [
      'applyEdits',
      {
        edits: [
          { path: 'private.fixture', content: 'bad', expectedRevision: null },
        ],
      },
    ],
  ] as const) {
    const reply = await f.service('documents', method, params);
    if (reply.ok) assert.equal((reply.data as any)?.status, 'rejected');
    assert.equal(
      JSON.stringify(reply).includes('synthetic protected value'),
      false,
    );
    assert.equal(
      await readFile(join(f.workspace, 'private.fixture'), 'utf8'),
      'synthetic protected value',
    );
    if (method === 'read') assert.equal(reply.ok, false);
  }
});

test('controller preserves queued input across restart and requires explicit idempotent recovery', async (t) => {
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      ),
  ]);
  await f.call('prompt', { text: 'stay busy' });
  await wait(() => f.model.requests.length === 1);
  const sessionId = f.controller.snapshot().activeSessionId;
  const queued = {
    id: randomUUID(),
    name: 'prompt',
    sessionId,
    payload: {
      text: 'recover exact original content',
      display: 'short shown draft',
      kind: 'follow-up',
    },
  };
  assert.equal((await f.controller.dispatch(queued)).ok, true);
  await f.controller.close();
  const model = new ScriptedModel([{ message: assistant('recovered once') }]);
  const restarted = new RuntimeController({
    home: f.home,
    workspace: f.workspace,
    userHome: f.home,
    model,
    emit: () => {},
  });
  const service = (method: string, params: Record<string, unknown> = {}) =>
    restarted.dispatch({
      id: randomUUID(),
      name: 'workspace-service',
      sessionId,
      payload: { service: 'inputs', method, params },
    });
  try {
    const listing = await service('list');
    assert.equal(listing.ok, true, listing.error);
    const recovery = listing.data as any;
    assert.equal(recovery.items.length, 1);
    assert.equal(recovery.items[0].payload.text, queued.payload.text);
    assert.equal(recovery.items[0].payload.display, queued.payload.display);
    await delay(30);
    assert.equal(model.requests.length, 0);
    const oldRPC = await restarted.dispatch(queued);
    assert.equal(oldRPC.ok, true, oldRPC.error);
    assert.equal(
      model.requests.length,
      0,
      'lost queued receipt cannot turn into a new prompt after restart',
    );
    const toDraft = await service('resolve', {
      ids: [queued.id],
      expectedVersion: recovery.version,
      operationId: 'return-draft',
      action: 'returnToDraft',
    });
    assert.equal(toDraft.ok, true, toDraft.error);
    assert.equal(
      ((await service('list')).data as any).items.length,
      1,
      'draft return retains durable source',
    );
    const fresh = (await service('list')).data as any;
    const request = {
      ids: [queued.id],
      expectedVersion: fresh.version,
      operationId: 'resume-once',
      action: 'resume',
    };
    const resumed = await service('resolve', request);
    assert.equal(resumed.ok, true, resumed.error);
    await wait(() => model.requests.length === 1);
    assert.ok(
      model.requests[0].messages.some(
        (message) =>
          message.role === 'user' && message.content === queued.payload.text,
      ),
    );
    const repeat = await service('resolve', request);
    assert.equal(repeat.ok, true, repeat.error);
    assert.equal((repeat.data as any).applied, false);
    await delay(30);
    assert.equal(model.requests.length, 1);
  } finally {
    await restarted.close();
  }
});

test('private input drafts remain recoverable after workspace trust is revoked', async (t) => {
  const f = await setup(t, [
    async (request) =>
      new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      ),
  ]);
  await f.call('prompt', { text: 'busy' });
  await wait(() => f.model.requests.length === 1);
  await f.call('prompt', { text: 'private durable draft' });
  await f.controller.close();
  const restarted = new RuntimeController({
    home: f.home,
    workspace: f.workspace,
    userHome: f.home,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  const sessionId = restarted.snapshot().activeSessionId;
  saveSettings(defaultSettings(), f.home);
  const call = (method: string, params: Record<string, unknown> = {}) =>
    restarted.dispatch({
      id: randomUUID(),
      name: 'workspace-service',
      sessionId,
      payload: { service: 'inputs', method, params },
    });
  try {
    const listing = await call('list');
    assert.equal(listing.ok, true, listing.error);
    const value = listing.data as any;
    const request = {
      ids: [value.items[0].id],
      expectedVersion: value.version,
      operationId: 'revoked-copy',
      action: 'returnToDraft',
    };
    const copy = await call('resolve', request);
    assert.equal(copy.ok, true, copy.error);
    assert.equal(
      (copy.data as any).items[0].payload.text,
      'private durable draft',
    );
    const resume = await call('resolve', {
      ...request,
      operationId: 'revoked-resume',
      action: 'resume',
    });
    assert.equal(resume.ok, false);
    assert.match(resume.error!, /trust/);
    const fresh = (await call('list')).data as any;
    const discard = await call('resolve', {
      ...request,
      expectedVersion: fresh.version,
      operationId: 'revoked-discard',
      action: 'discard',
    });
    assert.equal(discard.ok, true, discard.error);
    assert.equal(((await call('list')).data as any).items.length, 0);
  } finally {
    await restarted.close();
  }
});

test('late events after normal service disposal do not become storage failures or cancel live models', async (t) => {
  let signal: AbortSignal | undefined;
  const f = await setup(t, [
    async (request) => {
      signal = request.signal;
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
    },
  ]);
  await f.call('prompt', { text: 'keep model active' });
  await wait(() => !!signal);
  await writeFile(join(f.workspace, 'file.txt'), 'fixture');
  assert.equal(
    (await f.service('documents', 'read', { path: 'file.txt' })).ok,
    true,
  );
  const root = realpathSync.native(f.workspace),
    controller = f.controller as any;
  const service = controller.workspaceServices.get(root);
  await service.dispose();
  const event = {
    workspaceId: createHash('sha256').update(root).digest('hex').slice(0, 24),
    sessionId: f.controller.snapshot().activeSessionId,
    service: 'tasks',
    resourceId: 'late',
    epoch: 'late',
    seq: 1,
    at: new Date().toISOString(),
    data: { type: 'late-cleanup' },
  };
  await assert.rejects(
    () => service.publishSource(event),
    (error: any) => error.code === 'WORKSPACE_SERVICES_CLOSED',
  );
  controller.workspaceEvent(root, event);
  await delay(30);
  assert.equal(
    signal!.aborted,
    false,
    'normal closed stream must not abort another ongoing model',
  );
  assert.equal(controller.workspaceStreamFailures.size, 0);
  assert.equal(service.eventHealth.error, undefined);
  await f.controller.close();
  const count = controller.workspaceServices.size;
  controller.workspaceEvent(join(f.root, 'never-opened'), event);
  await delay(10);
  assert.equal(
    controller.workspaceServices.size,
    count,
    'closing does not create a new service',
  );
  assert.equal(controller.workspaceStreamFailures.size, 0);
});

test('native controller mutations share a canonical root across actual filesystem path aliases', async (t) => {
  const f = await setup(t);
  await f.controller.close();
  const canonical = realpathSync.native(f.workspace);
  let alias: string;
  if (process.platform === 'win32') {
    // Call Windows' API directly: cmd/execFile's quote re-escaping can return
    // literal \" characters rather than a filesystem path.
    const script = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CircleShortPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetShortPathName(string path, StringBuilder buffer, uint length);
}
'@
$buffer = New-Object System.Text.StringBuilder 32768
$result = [CircleShortPath]::GetShortPathName($env:CIRCLE_TEST_ALIAS_PATH, $buffer, $buffer.Capacity)
if ($result -eq 0 -or $result -ge $buffer.Capacity) { throw "GetShortPathName failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
[Console]::WriteLine($buffer.ToString())
`;
    alias = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CIRCLE_TEST_ALIAS_PATH: canonical },
      },
    ).trim();
    assert.ok(
      alias && realpathSync.native(alias) === canonical,
      'Windows short name must resolve to the exact granted directory',
    );
    if (alias.toLowerCase() === canonical.toLowerCase()) {
      assert.notEqual(
        f.workspace.toLowerCase(),
        canonical.toLowerCase(),
        'runner fixture must expose a real 8.3 alias',
      );
      alias = f.workspace;
    }
  } else {
    alias = join(f.root, 'project-alias');
    await symlink(canonical, alias, 'dir');
  }
  await mkdir(join(canonical, 'nested'));
  await writeFile(
    join(canonical, 'nested/current.ts'),
    'export const current = 0;\n',
  );
  saveSettings(trustFolder(defaultSettings(), canonical), f.home);
  const model = new ScriptedModel([
    {
      message: assistant('', [
        {
          id: 'alias-create',
          name: 'write_file',
          args: {
            file_path: 'nested/created.ts',
            content: 'export const created = 42;\n',
          },
        },
      ]),
    },
    { message: assistant('created using the native document coordinator') },
  ]);
  const controller = new RuntimeController({
    home: f.home,
    workspace: alias,
    userHome: f.home,
    model,
    emit: () => {},
  });
  const call = (name: string, payload: Record<string, unknown> = {}) =>
    controller.dispatch({
      id: randomUUID(),
      name,
      sessionId: controller.snapshot().activeSessionId,
      payload,
    });
  const document = (method: string, params: Record<string, unknown>) =>
    call('workspace-service', { service: 'documents', method, params });
  try {
    const read = await document('read', { path: 'nested/current.ts' });
    assert.equal(read.ok, true, read.error);
    const mutations = (controller as any).fileMutations(canonical);
    const aliasedRead = await mutations.read(join(alias, 'nested/current.ts'));
    assert.equal(aliasedRead.revision, (read.data as any).revision);
    await mutations.apply([
      {
        path: join(alias, 'nested/by-alias.ts'),
        content: 'export const alias = true;\n',
        expectedRevision: null,
      },
    ]);
    assert.equal(
      await readFile(join(canonical, 'nested/by-alias.ts'), 'utf8'),
      'export const alias = true;\n',
    );
    assert.equal(
      (await call('prompt', { text: 'create a nested file' })).ok,
      true,
    );
    await wait(() =>
      controller
        .snapshot()
        .interactions.some((row) => row.status === 'pending'),
    );
    const approval = controller
      .snapshot()
      .interactions.find((row) => row.status === 'pending')!;
    await call('answer', {
      id: approval.id,
      revision: approval.revision,
      answer: 'approve',
    });
    await wait(() => model.requests.length >= 2);
    assert.equal(
      await readFile(join(canonical, 'nested/created.ts'), 'utf8'),
      'export const created = 42;\n',
    );
    const save = await document('save', {
      path: 'nested/current.ts',
      content: 'export const current = 1;\n',
      expectedRevision: (read.data as any).revision,
    });
    assert.equal(save.ok, true, save.error);
    assert.equal(
      await readFile(join(canonical, 'nested/current.ts'), 'utf8'),
      'export const current = 1;\n',
    );
    await assert.rejects(
      () =>
        mutations.apply([
          {
            path: join(f.root, 'outside.ts'),
            content: 'escape',
            expectedRevision: null,
          },
        ]),
      /outside|invalid|workspace|path/i,
    );
    assert.equal(
      await readFile(join(canonical, 'nested/created.ts'), 'utf8'),
      'export const created = 42;\n',
    );
  } finally {
    await controller.close();
  }
});
