import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.js';
import { LiveRuntime } from '../../workbench/src/model/live.js';
import type { DesktopBridge } from '../src/contracts.js';
import type { RuntimeCommand, RuntimeUpdate } from '../src/runtime-protocol.js';
import type {
  RecoverableInputs,
  ResolveInputsResult,
} from '../../../src/input_outbox.js';
import { ScriptedModel } from '../../../src/testing.js';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.js';
import type {
  Message,
  ModelRequest,
  ModelResponse,
} from '../../../src/types.js';
import { cleanup, scratch } from '../../../tests/helpers.js';
import { patience } from './helpers/patience.mjs';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xkAAAAASUVORK5CYII=';
const long = Array.from(
  { length: 600 },
  (_, i) => `retained pasted line ${i + 1}`,
).join('\n');
const answer = (content = 'done'): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
});
const waitForAbort = async (request: ModelRequest): Promise<ModelResponse> =>
  new Promise((_resolve, reject) => {
    const abort = () => reject(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
async function until(check: () => boolean) {
  const end = Date.now() + patience(8000);
  while (!check()) {
    if (Date.now() > end) throw new Error('recovery fixture timed out');
    await delay(5);
  }
}
async function fixture(t: TestContext) {
  const root = scratch(t),
    home = join(root, 'home'),
    workspace = join(root, 'project');
  await mkdir(home);
  await mkdir(workspace);
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const storageValues = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageValues.set(key, value);
    },
  };
  return { root, home, workspace, storage };
}
function host(
  f: Awaited<ReturnType<typeof fixture>>,
  model: ScriptedModel,
  workspace = f.workspace,
) {
  let sequence = 0;
  const listeners = new Set<(update: RuntimeUpdate) => void>();
  const commands: RuntimeCommand[] = [];
  const controller = new RuntimeController({
    home: f.home,
    userHome: f.home,
    workspace,
    model,
    emit(update) {
      for (const listener of listeners)
        listener({ ...update, seq: ++sequence });
    },
  });
  const state = (): RuntimeUpdate => ({
    seq: ++sequence,
    connected: true,
    snapshot: controller.snapshot(),
  });
  const bridge = {
    runtimeState: async () => state(),
    runtimeCommand: (command: RuntimeCommand) => {
      commands.push(structuredClone(command));
      return controller.dispatch(command);
    },
    onRuntime: (listener: (update: RuntimeUpdate) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as DesktopBridge;
  const view = () => new LiveRuntime(bridge, state(), f.storage);
  const call = (
    name: RuntimeCommand['name'],
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
    id = randomUUID(),
  ) => controller.dispatch({ id, name, payload, sessionId });
  const inputs = async <T = RecoverableInputs>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ): Promise<T> => {
    const reply = await call(
      'workspace-service',
      { service: 'inputs', method, params },
      sessionId,
    );
    assert.equal(reply.ok, true, reply.error);
    return reply.data as T;
  };
  return { controller, model, view, call, commands, inputs };
}
function current(view: LiveRuntime) {
  const state = view.getSnapshot();
  return state.sessions.find((item) => item.id === state.activeSessionId)!;
}

test('real renderer and controller lifecycle preserves full input, stable edited RPC identity and receipt deduplication without startup replay', async (t) => {
  const f = await fixture(t);
  let server = host(f, new ScriptedModel([waitForAbort]));
  let view = server.view();
  cleanup(t, async () => {
    view.dispose();
    await server.controller.close();
  });
  view.change((state) => {
    state.sessions.find((item) => item.id === state.activeSessionId)!.draft =
      'held initial turn';
  });
  await view.send();
  await until(() => server.model.requests.length === 1);
  const sessionId = current(view).id;
  view.change((state) => {
    state.sessions.find((item) => item.id === state.activeSessionId)!.draft =
      'original steering';
  });
  await view.send('steering');
  const queued = server.commands.at(-1)!;
  view.change((state) => {
    const row = state.sessions.find(
      (item) => item.id === state.activeSessionId,
    )!;
    row.draft = 'long follow-up';
    row.attachments = [
      { id: 'long', kind: 'paste', name: '600 lines', content: long },
    ];
  });
  await view.send('follow-up');
  view.change((state) => {
    const row = state.sessions.find(
      (item) => item.id === state.activeSessionId,
    )!;
    row.draft = 'media follow-up';
    row.attachments = [
      {
        id: 'image',
        kind: 'image',
        name: 'pixel.png',
        mime: 'image/png',
        content: png,
      },
    ];
  });
  await view.send('follow-up');
  const version = current(view).queueVersion!;
  const edited = await server.call('edit-queued', {
    kind: 'steering',
    index: 0,
    text: 'original steering',
    updatedText: 'edited steering',
    expectedQueueVersion: version,
  });
  assert.equal(edited.ok, true, edited.error);
  view.change((state) => {
    const row = state.sessions.find(
      (item) => item.id === state.activeSessionId,
    )!;
    row.draft = 'unsent separate draft';
    row.attachments = [
      {
        id: 'unsent',
        kind: 'paste',
        name: 'draft text',
        content: 'unsent bytes',
      },
    ];
  });
  view.dispose();
  view = server.view();
  assert.equal(current(view).queue.length, 3);
  assert.equal(current(view).queue[0]!.text, 'edited steering');
  assert.equal(current(view).draft, 'unsent separate draft');
  assert.equal(current(view).attachments[0]!.content, 'unsent bytes');
  assert.equal(
    (await server.inputs('list')).items.length,
    0,
    'renderer reload cannot convert live queue to recovery',
  );
  assert.equal(server.model.requests.length, 1);
  view.dispose();
  await server.controller.close();
  server = host(
    f,
    new ScriptedModel(Array.from({ length: 4 }, () => ({ message: answer() }))),
  );
  view = server.view();
  assert.equal(current(view).id, sessionId);
  assert.equal(current(view).queue.length, 0);
  assert.equal(current(view).draft, 'unsent separate draft');
  assert.equal(server.model.requests.length, 0);
  const recovery = await server.inputs('list');
  assert.equal(recovery.items.length, 3);
  assert.equal(recovery.items[0]!.id, queued.id);
  assert.equal(recovery.items[0]!.payload.text, 'edited steering');
  assert.ok(
    recovery.items[1]!.payload.text.includes('retained pasted line 600'),
  );
  assert.equal(recovery.items[2]!.payload.attachments?.[0]?.data, png);
  assert.equal((await server.controller.dispatch(queued)).ok, true);
  assert.equal(server.model.requests.length, 0);
  assert.equal(
    (await server.call('prompt', { text: 'unrelated fresh turn' })).ok,
    true,
  );
  await until(
    () =>
      server.model.requests.length === 1 &&
      server.controller.snapshot().sessions.find((row) => row.id === sessionId)!
        .state === 'idle',
  );
  assert.equal(
    (await server.inputs('list')).items.length,
    3,
    'new prompt must not silently drain recovered inputs',
  );
  const fresh = await server.inputs('list'),
    request = {
      ids: fresh.items.map((item) => item.id),
      expectedVersion: fresh.version,
      operationId: 'explicit-resume',
      action: 'resume',
    };
  const resumed = await server.inputs<ResolveInputsResult>('resolve', request);
  assert.equal(resumed.applied, true);
  await until(
    () =>
      server.model.requests.length === 4 &&
      server.controller.snapshot().sessions.find((row) => row.id === sessionId)!
        .state === 'idle',
  );
  const messages = server.model.requests.at(-1)!.messages;
  assert.equal(
    messages.find((item) => item.id === queued.id)!.content,
    'edited steering',
  );
  assert.ok(
    messages.some((item) => item.content.includes('retained pasted line 600')),
  );
  assert.equal(
    messages.find((item) => item.content === 'media follow-up')!
      .attachments?.[0]?.data,
    png,
  );
  for (let i = 0; i < 105; i++)
    assert.equal(
      (
        await server.call('rename-session', {
          id: sessionId,
          title: 'receipt eviction fixture',
        })
      ).ok,
      true,
    );
  assert.equal(
    (await server.controller.dispatch(queued)).ok,
    true,
    'original queued RPC stays idempotent after controller cache eviction',
  );
  assert.equal(
    (await server.inputs<ResolveInputsResult>('resolve', request)).applied,
    false,
    'durable resume receipt survives transient controller cache eviction',
  );
  assert.equal(server.model.requests.length, 4);
  assert.equal((await server.inputs('list')).items.length, 0);
});

test('application close during real pending write approval preserves queued media but never replays the unapproved side effect', async (t) => {
  const f = await fixture(t);
  let server = host(
    f,
    new ScriptedModel([
      {
        message: {
          ...answer(''),
          tool_calls: [
            {
              id: 'write-before-close',
              name: 'write_file',
              args: { file_path: 'must-not-exist.txt', content: 'unapproved' },
            },
          ],
        },
      },
    ]),
  );
  cleanup(t, () => server.controller.close());
  assert.equal(
    (await server.call('prompt', { text: 'requires approval' })).ok,
    true,
  );
  await until(() =>
    server.controller
      .snapshot()
      .interactions.some((row) => row.status === 'pending'),
  );
  const sessionId = server.controller.snapshot().activeSessionId;
  const queue = await server.call('prompt', {
    text: 'queued after pending approval',
    kind: 'follow-up',
    attachments: [{ name: 'pixel.png', mime: 'image/png', content: png }],
  });
  assert.equal(queue.ok, true, queue.error);
  await server.controller.close();
  await assert.rejects(access(join(f.workspace, 'must-not-exist.txt')));
  server = host(f, new ScriptedModel([]));
  assert.equal(server.controller.snapshot().activeSessionId, sessionId);
  const pending = await server.inputs('list');
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0]!.payload.attachments?.[0]?.data, png);
  assert.equal(
    server.controller
      .snapshot()
      .interactions.some((row) => row.status === 'pending'),
    false,
    'old approvals must not be silently revived',
  );
  assert.equal(server.model.requests.length, 0);
  await assert.rejects(access(join(f.workspace, 'must-not-exist.txt')));
});

test('private recovery can copy and discard an inactive known input after its project directory disappears without changing selection', async (t) => {
  const f = await fixture(t);
  let server = host(f, new ScriptedModel([waitForAbort]));
  cleanup(t, () => server.controller.close());
  await server.call('prompt', { text: 'held' });
  await until(() => server.model.requests.length === 1);
  await server.call('prompt', { text: 'private recovery bytes' });
  const original = server.controller.snapshot().activeSessionId;
  await server.controller.close();
  const other = join(f.root, 'another-project');
  await mkdir(other);
  saveSettings(trustFolder(defaultSettings(), other), f.home);
  await rm(f.workspace, { recursive: true });
  server = host(f, new ScriptedModel([]), other);
  const selected = server.controller.snapshot().activeSessionId;
  assert.notEqual(selected, original);
  const recovered = await server.inputs('list', {}, original);
  assert.equal(recovered.items[0]!.payload.text, 'private recovery bytes');
  const request = {
    ids: [recovered.items[0]!.id],
    expectedVersion: recovered.version,
    operationId: 'missing-project-copy',
    action: 'returnToDraft',
  };
  const copied = await server.inputs<ResolveInputsResult>(
    'resolve',
    request,
    original,
  );
  assert.equal(copied.items[0]!.payload.text, 'private recovery bytes');
  assert.equal(server.controller.snapshot().activeSessionId, selected);
  assert.equal(server.model.requests.length, 0);
  const resume = await server.call(
    'workspace-service',
    {
      service: 'inputs',
      method: 'resolve',
      params: { ...request, operationId: 'must-refuse-run', action: 'resume' },
    },
    original,
  );
  assert.equal(resume.ok, false);
  const fresh = await server.inputs('list', {}, original);
  await server.inputs(
    'resolve',
    {
      ...request,
      expectedVersion: fresh.version,
      operationId: 'human-discard',
      action: 'discard',
    },
    original,
  );
  assert.equal((await server.inputs('list', {}, original)).items.length, 0);
  assert.equal(server.controller.snapshot().activeSessionId, selected);
  assert.equal(server.model.requests.length, 0);
});
