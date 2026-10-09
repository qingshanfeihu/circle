import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  loadCredentials,
  saveCredentials,
} from '../src/settings.js';
import { transcriptRows, type ScreenState } from '../src/tui/render.js';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  setPalette,
} from '../src/ink/theme.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { emptyUsage, type Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await delay(5);
  }
}

const user = (id: string, content: string): Message => ({
  id,
  role: 'user',
  content,
});
const reply = (id: string, content: string): Message => ({
  id,
  role: 'assistant',
  content,
});
function screen(messages: Message[]): ScreenState {
  return {
    messages,
    notices: [],
    welcome: [],
    draft: '',
    draftCursor: 0,
    model: 'model-x',
    workspace: '/project/app',
    version: '1.0.0',
    busy: false,
    waiting: false,
    planMode: false,
    autoMode: false,
    todos: [],
    showThinking: true,
    showTools: false,
    streaming: '',
    thinking: '',
    usage: emptyUsage(),
    flash: '',
    started: Date.now(),
    scroll: 0,
    hiddenTurns: 0,
  };
}

test('the store serves one shared messages array while the head stands still, and writes move it', () => {
  const store = new CheckpointStore();
  const session = store.create('/w', 'm');
  const firstHead = store.append(session.id, [
    user('u1', 'one'),
    reply('a1', 'first answer'),
  ])!;
  // Same head: the array and its messages are the same objects, not a rewalk.
  const first = store.messages(session.id);
  assert.equal(store.messages(session.id), first);
  assert.equal(store.messages(session.id, firstHead), first);
  // An append extends the cache: the old messages keep their identity.
  const version = store.version;
  store.append(session.id, [user('u2', 'two')]);
  assert.ok(store.version > version);
  const second = store.messages(session.id);
  assert.equal(second.length, 3);
  assert.ok(second.slice(0, 2).every((message, i) => message === first[i]));
  // Selecting the older head walks that branch, and the current head follows it.
  store.select(session.id, firstHead);
  assert.deepEqual(
    store.messages(session.id).map((message) => message.id),
    ['u1', 'a1'],
  );
});

test('frozen message rows replay from the cache, and every input that changes them re-renders', () => {
  const messages: Message[] = [
    user('u1', 'compile the batches'),
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', name: 'execute', args: { command: 'npm test' } },
      ],
    },
    {
      id: 't1',
      role: 'tool',
      tool_call_id: 'c1',
      name: 'execute',
      content: 'ok\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8',
    },
    reply('a2', 'Final report: all pass.'),
  ];
  const dark = buildPalette(...DEFAULT_DARK);
  const light = buildPalette(...DEFAULT_LIGHT);
  setPalette(dark);
  const first = transcriptRows(screen(messages), 80);
  // A repaint with fresh state objects but the same messages replays byte-identical rows.
  assert.deepEqual(transcriptRows(screen(messages), 80), first);
  // The fold flag, the width and the theme each produce different rows.
  assert.notDeepEqual(
    transcriptRows({ ...screen(messages), showTools: true }, 80),
    first,
  );
  assert.notDeepEqual(transcriptRows(screen(messages), 100), first);
  setPalette(light);
  const flipped = transcriptRows(screen(messages), 80);
  assert.notDeepEqual(flipped, first);
  // The words are the same; only the colours moved.
  assert.deepEqual(flipped.map(stripAnsi), first.map(stripAnsi));
  setPalette(dark);
  // A turn that is still working is never cached: the lamp follows the turn.
  const pending = messages.slice(0, 2);
  const running = transcriptRows({ ...screen(pending), busy: true }, 80);
  assert.ok(running.some((row) => stripAnsi(row).includes('Bash(npm test)')));
  assert.notDeepEqual(
    transcriptRows({ ...screen(pending), busy: true, waiting: true }, 80),
    running,
  );
  // Once the result is in, the answer is frozen and stays stable.
  const done = transcriptRows(screen(messages), 80);
  assert.deepEqual(transcriptRows(screen(messages), 80), done);
  assert.ok(done.some((row) => stripAnsi(row).includes('+2 lines')));
});

test('requestRender coalesces a burst into one frame and a direct repaint supersedes it', async (t) => {
  const root = scratch(t);
  const app = new SessionApp(root, root, defaultSettings());
  const ui = app as any;
  let frames = 0;
  ui.screen.render = (): void => {
    frames++;
  };
  try {
    ui.repaint();
    assert.equal(frames, 1);
    for (let i = 0; i < 50; i++) ui.requestRender();
    await delay(60);
    assert.equal(frames, 2);
    // A queued frame gives way to the direct draw.
    ui.requestRender();
    ui.repaint();
    await delay(60);
    assert.equal(frames, 3);
  } finally {
    if (ui.renderTimer) clearTimeout(ui.renderTimer);
    ui.input.close();
  }
});

test('a streaming turn keeps the loop responsive: a key works right away and frames coalesce', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  let frames = 0;
  ui.screen.render = (): void => {
    frames++;
  };
  await app.attach({
    workspace: root,
    home: root,
    settings,
    model: new ScriptedModel(),
  });
  const runtime = app.runtime!;
  cleanup(t, () => void runtime.close());
  cleanup(t, () => {
    if (ui.renderTimer) clearTimeout(ui.renderTimer);
    if (ui.animation) clearInterval(ui.animation);
    ui.input.close();
  });
  // A burst of stream tokens, as a fast model answer produces.
  const started = performance.now();
  for (let i = 0; i < 200; i++)
    runtime.bus.emit('llm_token', { payload: { text: 'answer ' + i + ' ' } });
  // A key in the middle of it is the user's, not the stream's.
  ui.handle({ type: 'key', key: 'ctrl+o', char: '' });
  assert.equal(app.state.showTools, true, 'the key was handled at once');
  await delay(80);
  assert.ok(app.state.streaming.includes('answer 199'));
  assert.ok(
    performance.now() - started < 1000,
    'a 200-token burst and a key stay well under a second',
  );
  assert.ok(
    frames <= 5,
    `frames coalesced (${frames} drawn, not one per token)`,
  );
});

test('/logout and /skill run during a turn instead of waiting for it', async (t) => {
  const root = scratch(t);
  const settings = defaultSettings();
  saveCredentials({ api_key: 'sk-live' }, root);
  const model = new ScriptedModel([
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () =>
          reject(request.signal.reason),
        );
      }) as never,
  ]);
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  ui.screen.render = (): void => {};
  await app.attach({ workspace: root, home: root, settings, model });
  const runtime = app.runtime!;
  cleanup(t, () => void runtime.close());
  cleanup(t, () => {
    if (ui.renderTimer) clearTimeout(ui.renderTimer);
    if (ui.animation) clearInterval(ui.animation);
    ui.input.close();
  });
  const turn = runtime.harness.run('work').catch(() => {});
  await until(() => runtime.busy);
  assert.equal(loadCredentials(root).api_key, 'sk-live');
  await app.command('logout', '');
  assert.equal(app.state.busy, true, 'the turn still runs');
  assert.equal(loadCredentials(root).api_key, undefined);
  assert.ok(app.state.notices.some((note) => note.includes('Signed out')));
  await app.command('skill', '');
  assert.ok(
    app.state.notices.some((note) => note.includes('Skills:')),
    'the skill list is answered while the turn runs',
  );
  await runtime.cancel();
  await turn;
});
