import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encode, ExtData } from '@msgpack/msgpack';
import { SessionApp } from '../src/tui/session_app.js';
import { ScreenRenderer } from '../src/ink/screen.js';
import { editorCommand } from '../src/tui/external_editor.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { Picker } from '../src/ink/components/picker.js';
import { stringWidth, stripAnsi } from '../src/ink/string_width.js';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  palette,
  setPalette,
  sgrJoin,
} from '../src/ink/theme.js';
import {
  emptyUsage,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

type Reply =
  Partial<ModelResponse> | ((request: ModelRequest) => Promise<ModelResponse>);
const answer = (content: string, input = 0): Reply => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
  usage: { ...emptyUsage(), input_tokens: input, output_tokens: input && 5 },
});
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await delay(10);
  }
}
// A full-screen session without a terminal: the real runtime, store and key handling, with
// ScriptedModel for the endpoint and the terminal and process calls recorded in `log`.
async function session(
  t: Parameters<typeof scratch>[0],
  replies: Reply[] = [],
  options: { home?: string; workspace?: string; session?: string } = {},
) {
  const home = options.home ?? scratch(t);
  const workspace = options.workspace ?? scratch(t);
  const settings = defaultSettings();
  const model = new ScriptedModel(replies);
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  const log: [string, unknown][] = [];
  ui.screen = new ScreenRenderer((text) => log.push(['screen', text]));
  app.terminal = {
    platform: 'darwin',
    write: (text) => log.push(['write', text]),
    input: (on) => log.push(['input', on]),
    kill: (signal) => log.push(['kill', signal]),
  };
  await app.attach({
    workspace,
    home,
    settings,
    model,
    headless: true,
    ...(options.session ? { session: options.session } : {}),
  });
  const runtime = app.runtime!;
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    await runtime.close();
  });
  const key = (name: string, char = ''): void =>
    ui.handle({ type: 'key', key: name, char });
  const type = (text: string): void => {
    for (const char of text) key(char, char);
  };
  const script = (name: string, code: string): string => {
    writeFileSync(join(workspace, name), code);
    return `"${process.execPath}" "${join(workspace, name)}"`;
  };
  return { app, ui, runtime, model, home, workspace, log, key, type, script };
}

test('ctrl+z gives the shell the terminal with SIGTSTP and takes it back with the whole screen drawn again', async (t) => {
  const home = scratch(t);
  writeFileSync(
    join(home, 'keybindings.json'),
    JSON.stringify({ suspend: ['ctrl+z', 'alt+z'] }),
  );
  const { app, ui, log, key, type } = await session(t, [], { home });
  type('half a thought');
  ui.repaint();
  log.length = 0;
  let drawnWhileStopped = '';
  app.terminal.kill = (signal) => {
    log.push(['kill', signal]);
    // Stopped: nothing is drawn and keys are not read until the shell continues us
    ui.repaint();
    drawnWhileStopped = log
      .filter(([kind]) => kind === 'screen')
      .map(([, text]) => text)
      .join('');
  };
  key('ctrl+z', '\x1a');
  const kinds = log.map(([kind, value]) =>
    kind === 'write' || kind === 'screen' ? kind : `${kind} ${value}`,
  );
  assert.deepEqual(kinds, [
    'write',
    'input false',
    'kill SIGTSTP',
    'input true',
    'write',
    'screen',
  ]);
  assert.equal(drawnWhileStopped, '');
  const [leave, back] = log
    .filter(([kind]) => kind === 'write')
    .map(([, text]) => String(text));
  // Mouse, paste and theme reports off, the cursor shown, the shell's screen and title back
  for (const part of [
    '\x1b[?1000l',
    '\x1b[?2004l',
    '\x1b[?2031l',
    '\x1b[?25h',
    '\x1b[?1049l',
    '\x1b[23;0t',
  ])
    assert.ok(leave!.includes(part), JSON.stringify(part));
  for (const part of [
    '\x1b[22;0t',
    '\x1b[?1049h',
    '\x1b[?25l',
    '\x1b[?2004h',
    '\x1b[?2031h',
    '\x1b[?1000h',
    '\x1b[2J',
  ])
    assert.ok(back!.includes(part), JSON.stringify(part));
  // Every row is written again, not only the ones that changed
  const frame = String(log.at(-1)![1]);
  for (let row = 1; row <= 24; row++)
    assert.ok(frame.includes(`\x1b[${row};1H`), `row ${row}`);
  assert.equal(app.state.draft, 'half a thought');
  assert.equal(ui.externalEditor, false);
  // keybindings.json can give the action "suspend" another key
  log.length = 0;
  key('alt+z', 'z');
  assert.ok(
    log.some(([kind, value]) => kind === 'kill' && value === 'SIGTSTP'),
  );
});

test('ctrl+z on Windows only says suspending is not supported', async (t) => {
  const { app, log, key, type } = await session(t);
  app.terminal.platform = 'win32';
  type('kept');
  log.length = 0;
  key('ctrl+z', '\x1a');
  assert.deepEqual(
    log.filter(([kind]) => kind !== 'screen'),
    [],
  );
  assert.equal(app.state.flash, 'Suspending is not supported here');
  assert.equal(app.state.draft, 'kept');
});

test('ctrl+c on an empty prompt says how to leave, and a second press within 1.5 s leaves; text is cleared first', async (t) => {
  const { app, ui, runtime, key, type, script } = await session(t);
  key('ctrl+c');
  assert.equal(app.state.flash, 'Press ctrl+c again to exit');
  assert.equal(ui.ended, false);
  // Too late for the second press: it asks again
  ui.lastCtrlC = Date.now() - 1600;
  key('ctrl+c');
  assert.equal(ui.ended, false);
  assert.equal(app.state.flash, 'Press ctrl+c again to exit');
  // Text in the box: the press clears it and does not count toward leaving
  type('draft');
  key('ctrl+c');
  assert.equal(app.state.draft, '');
  assert.equal(ui.ended, false);
  // With a job running the hint says it will be stopped; its page does not keep the key
  const job = runtime.jobs.startShell(
    script('slow.cjs', 'setTimeout(()=>{},30000)'),
    { sessionId: runtime.session.id },
  );
  await app.submit(`/jobs ${job.id}`);
  assert.equal(app.state.jobDetail?.id, job.id);
  key('ctrl+c');
  assert.equal(app.state.flash, 'Press ctrl+c again to exit · stops 1 job');
  assert.equal(ui.ended, false);
  key('ctrl+c');
  assert.equal(ui.ended, true);
  assert.equal(await app.wait(), 0);
});

test('esc esc opens the tree only within half a second, as 0.5.0 timed it', async (t) => {
  const { app, ui, key } = await session(t, [answer('an answer')]);
  const list = (): string | undefined => app.state.picker?.title;
  await app.submit('a question');
  key('escape');
  ui.lastEscape = Date.now() - 550;
  key('escape');
  assert.equal(list(), undefined);
  key('escape');
  assert.equal(list(), 'Session tree');
});

test('stopping a turn marks it interrupted, and the mark goes once the next turn starts', async (t) => {
  const { app, ui, runtime, model } = await session(t, [
    (request) =>
      new Promise((_resolve, reject) =>
        request.signal.addEventListener('abort', () =>
          reject(request.signal.reason),
        ),
      ),
    answer('after'),
  ]);
  const turn = app.submit('think forever');
  await until(() => model.requests.length === 1 && runtime.busy);
  ui.handle({ type: 'key', key: 'escape', char: '' });
  await turn;
  assert.equal(runtime.busy, false);
  assert.ok(app.state.notices.includes('✖ Interrupted'));
  // A failure from another cause stays; only the stop mark belongs to the old turn.
  app.state.notices.push('✖ Incorrect API key');
  await app.submit('continue');
  assert.equal(model.requests.length, 2);
  assert.ok(!app.state.notices.includes('✖ Interrupted'));
  assert.ok(app.state.notices.includes('✖ Incorrect API key'));
});

test('ctrl+c during a turn stops it, and a second press right after leaves', async (t) => {
  const { app, ui, runtime, model } = await session(t, [
    (request) =>
      new Promise((_resolve, reject) =>
        request.signal.addEventListener('abort', () =>
          reject(request.signal.reason),
        ),
      ),
  ]);
  const turn = app.submit('think forever');
  await until(() => model.requests.length === 1 && runtime.busy);
  ui.handle({ type: 'key', key: 'ctrl+c', char: '' });
  await turn;
  assert.equal(runtime.busy, false);
  assert.equal(ui.ended, false);
  ui.handle({ type: 'key', key: 'ctrl+c', char: '' });
  assert.equal(ui.ended, true);
});

test('/tree draws the branches as 0.5.0 did: yours ›, answers ⏺, ├ where a branch starts, here and · on the way', async (t) => {
  const { app, ui, runtime, workspace } = await session(t, [
    {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'let me look',
        tool_calls: [
          { id: 'r1', name: 'read_file', args: { file_path: 'notes.txt' } },
        ],
      },
    },
    answer('**answer** `one`'),
    answer('answer two'),
    answer('answer changed'),
  ]);
  writeFileSync(join(workspace, 'notes.txt'), 'notes\n');
  await app.submit('# question one');
  await app.submit('question two');
  await app.submit('/tree');
  const labels = (): string[] =>
    app.state.picker!.matches().map((item) => item.label);
  // The tool call and its result are steps of the turn, not entries
  assert.deepEqual(labels(), [
    '› question one',
    '⏺ answer one',
    '› question two',
    '⏺ answer two',
  ]);
  // Back before "question two" and something else instead: a second branch
  const picker = app.state.picker!;
  picker.focus = labels().indexOf('› question two');
  ui.handle({ type: 'key', key: 'enter', char: '' });
  await until(() => app.state.draft === 'question two');
  ui.composer.clear();
  await app.submit('question changed');
  await app.submit('/tree');
  const items = app.state.picker!.matches();
  assert.deepEqual(
    items.map((item) => [item.label, item.meta]),
    [
      ['› question one', '·'],
      ['⏺ answer one', '·'],
      ['├ › question two', ''],
      ['  ⏺ answer two', ''],
      ['├ › question changed', '·'],
      ['  ⏺ answer changed', 'here'],
    ],
  );
  assert.equal(items[app.state.picker!.focus]!.label, '  ⏺ answer changed');
  assert.ok(items.at(-1)!.current);
  // ctrl+u: only your messages, drawn as they were
  ui.handle({ type: 'key', key: 'ctrl+u', char: '' });
  await until(() => labels().length === 3);
  assert.deepEqual(labels(), [
    '› question one',
    '├ › question two',
    '├ › question changed',
  ]);
  ui.handle({ type: 'key', key: 'escape', char: '' });
  // /fork lists your messages in the same order, numbered, the last one marked
  await app.submit('/fork');
  const fork = app.state.picker!;
  assert.deepEqual(
    fork.matches().map((item) => [item.label, item.meta]),
    [
      ['question one', '1/3'],
      ['question two', '2/3'],
      ['question changed', '3/3'],
    ],
  );
  assert.equal(fork.matches()[fork.focus]!.label, 'question changed');
  assert.equal(runtime.store.list(workspace).length, 1);
});

test('/jobs follows the jobs while it is open: one that starts appears and one that ends says so', async (t) => {
  const { app, ui, runtime, script, workspace } = await session(t);
  const slow = runtime.jobs.startShell(
    script('slow.cjs', 'setTimeout(()=>{},30000)'),
    { sessionId: runtime.session.id },
  );
  await app.submit('/jobs');
  const list = app.state.picker!;
  assert.deepEqual(
    list.items.map((item) => item.key),
    [slow.id],
  );
  const quick = runtime.jobs.startShell(
    script(
      'quick.cjs',
      "setTimeout(() => require('node:fs').writeFileSync('ended', ''), 300)",
    ),
    { sessionId: runtime.session.id },
  );
  // Started while the list is open: it is listed without opening the list again
  assert.equal(app.state.picker, list);
  assert.deepEqual(
    list.items.map((item) => item.key),
    [slow.id, quick.id],
  );
  await until(() => existsSync(join(workspace, 'ended')));
  await until(() => list.items.some((item) => item.meta?.startsWith('done')));
  assert.deepEqual(
    list.items.map((item) => item.key),
    [slow.id, quick.id],
  );
  assert.match(list.items[1]!.meta!, /^done · \d+s$/);
  // Closed, the list no longer follows
  ui.handle({ type: 'key', key: 'escape', char: '' });
  assert.equal(app.state.picker, undefined);
  await runtime.jobs.stop(slow.id, 'user');
  assert.equal(ui.jobsList, undefined);
  assert.match(list.items[0]!.meta!, /^running/);
});

test('/undo and /redo clear the context meter until the next answer, as 0.5.0 did', async (t) => {
  const { app, ui, model } = await session(t, [
    answer('one', 1200),
    answer('two', 2400),
    answer('three', 3600),
  ]);
  await app.submit('first');
  await app.submit('second');
  ui.repaint();
  assert.equal(app.state.contextInput, 2400);
  await app.submit('/undo');
  ui.repaint();
  assert.equal(app.state.contextInput, undefined);
  await app.submit('/redo');
  ui.repaint();
  assert.equal(app.state.contextInput, undefined);
  await app.submit('third');
  ui.repaint();
  assert.equal(model.requests.length, 3);
  assert.equal(app.state.contextInput, 3600);
});

test('the editor is $VISUAL, $EDITOR, then nvim, vim or nano, then notepad on Windows', () => {
  const on =
    (...names: string[]) =>
    (command: string) =>
      names.includes(command) ? '/usr/bin/' + command : undefined;
  assert.deepEqual(
    editorCommand({ VISUAL: ' code -w ', EDITOR: 'vim' }, 'linux', on('vim')),
    ['code', '-w'],
  );
  assert.deepEqual(editorCommand({ EDITOR: 'emacs' }, 'linux', on()), [
    'emacs',
  ]);
  assert.deepEqual(editorCommand({}, 'linux', on('nano', 'vim')), ['vim']);
  assert.deepEqual(editorCommand({}, 'linux', on('nano', 'nvim')), ['nvim']);
  assert.deepEqual(editorCommand({}, 'darwin', on('nano', 'vi')), ['nano']);
  assert.equal(editorCommand({}, 'linux', on('vi')), undefined);
  assert.deepEqual(editorCommand({}, 'win32', on()), ['notepad']);
  assert.deepEqual(editorCommand({ VISUAL: '  ' }, 'win32', on('vim')), [
    'vim',
  ]);
  // A program that exists as written stays one word, spaces and all
  assert.deepEqual(
    editorCommand({ EDITOR: 'C:\\Program Files\\Ed\\ed.exe' }, 'win32', (c) =>
      c.startsWith('C:\\') ? c : undefined,
    ),
    ['C:\\Program Files\\Ed\\ed.exe'],
  );
});

test('/editor hands the terminal to the editor and loads what it wrote, whatever it exits with; without an editor it says so', async (t) => {
  const { app, ui, log, type, workspace, model } = await session(t, [
    answer('read'),
  ]);
  const saved = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR };
  const path = process.env.PATH;
  t.after(() => {
    for (const [name, value] of Object.entries({ ...saved, PATH: path }))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const editor = join(workspace, 'editor.cjs');
  writeFileSync(
    editor,
    "const fs = require('node:fs'); const file = process.argv[2];" +
      "fs.writeFileSync(__dirname + '/given.txt', fs.readFileSync(file, 'utf8'));" +
      "fs.writeFileSync(file, 'line one\\nline two\\n\\n'); process.exit(3);",
  );
  process.env.VISUAL = `"${process.execPath}" "${editor}"`;
  type('before');
  log.length = 0;
  await app.command('editor', '');
  assert.equal(readFileSync(join(workspace, 'given.txt'), 'utf8'), 'before');
  assert.equal(app.state.draft, 'line one\nline two');
  assert.equal(app.state.flash, 'Loaded from the editor · enter sends');
  assert.deepEqual(
    log
      .filter(([kind]) => kind !== 'screen')
      .map(([kind, value]) => (kind === 'write' ? kind : `${kind} ${value}`)),
    ['write', 'input false', 'input true', 'write'],
  );
  assert.equal(ui.externalEditor, false);
  ui.handle({ type: 'key', key: 'enter', char: '' });
  await until(() => model.requests.length === 1);
  assert.equal(
    model.requests[0]!.messages.at(-1)!.content,
    'line one\nline two',
  );
  // No editor anywhere
  delete process.env.VISUAL;
  delete process.env.EDITOR;
  process.env.PATH = scratch(t);
  app.terminal.platform = 'linux';
  await until(() => !app.runtime!.busy);
  await app.command('editor', '');
  assert.equal(
    app.state.notices.at(-1),
    '✖ No $VISUAL / $EDITOR set, and no nvim, vim or nano found',
  );
  // One that cannot be started
  process.env.EDITOR = join(workspace, 'missing-editor');
  await app.command('editor', '');
  assert.match(app.state.notices.at(-1)!, /^✖ Could not open the editor: /);
  assert.equal(ui.externalEditor, false);
});

test('ctrl+l draws the screen again from scratch and opens the model list; ctrl+b says when there is nothing to move', async (t) => {
  const { app, ui, log, key, runtime, script, workspace } = await session(t);
  ui.loadModels = async () => ['scripted', 'other'];
  ui.repaint();
  log.length = 0;
  key('ctrl+l');
  await until(() => Boolean(app.state.picker));
  assert.equal(app.state.picker!.title, 'Model');
  assert.deepEqual(log[0], ['write', '\x1b[2J']);
  const frame = log
    .filter(([kind]) => kind === 'screen')
    .map(([, text]) => String(text))
    .join('');
  for (let row = 1; row <= 24; row++)
    assert.ok(frame.includes(`\x1b[${row};1H`), `row ${row}`);
  key('escape');
  key('ctrl+b');
  assert.equal(app.state.flash, 'Nothing to move');
  const command = runtime.userShells.run(
    script(
      'wait.cjs',
      "require('node:fs').writeFileSync('started', ''); setTimeout(()=>{}, 400)",
    ),
    true,
  );
  await until(() => existsSync(join(workspace, 'started')));
  key('ctrl+b');
  assert.equal(app.state.flash, 'Moved to the background');
  assert.ok((await command).job);
});

test('a session from 0.5.0 keeps its pastes: /fork and /tree put them back and the model reads them whole', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const paste = 'alpha\nbeta\ngamma\ndelta';
  const legacy = (module: string, name: string, data: object): ExtData =>
    new ExtData(5, encode([module, name, data, 'model_validate_json']));
  const messages = [
    legacy('langchain_core.messages.human', 'HumanMessage', {
      id: 'u1',
      type: 'human',
      content: `${paste} explain`,
      additional_kwargs: {
        circle_shown: '[Pasted text #2 +3 lines] explain',
        circle_pastes: { '2': paste, x: 'not a number' },
      },
    }),
    legacy('langchain_core.messages.ai', 'AIMessage', {
      id: 'a1',
      type: 'ai',
      content: 'explained',
      additional_kwargs: {},
      tool_calls: [],
    }),
  ];
  const sessions = new DatabaseSync(join(home, 'sessions.sqlite'));
  sessions.exec(
    "CREATE TABLE sessions (thread_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', created REAL NOT NULL, updated REAL NOT NULL, leaf TEXT NOT NULL DEFAULT '')",
  );
  sessions
    .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      'circle-pastes',
      workspace,
      'pasted',
      'old',
      1791463528,
      1791463528,
      '',
    );
  sessions.close();
  const checkpoints = new DatabaseSync(join(home, 'checkpoints.sqlite'));
  checkpoints.exec(
    "CREATE TABLE checkpoints (thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL, parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB, PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id))",
  );
  checkpoints.exec(
    "CREATE TABLE writes (thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB, PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx))",
  );
  checkpoints
    .prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(
      'circle-pastes',
      '',
      '1',
      null,
      'msgpack',
      encode({
        channel_values: { messages },
        ts: '2026-10-08T00:00:00Z',
      }),
      null,
    );
  checkpoints.close();
  const { app, ui, runtime, model } = await session(t, [answer('again')], {
    home,
    workspace,
    session: 'circle-pastes',
  });
  assert.deepEqual(runtime.migration.errors, []);
  const sent = runtime.harness.messages[0]!;
  assert.equal(sent.display, '[Pasted text #2 +3 lines] explain');
  assert.deepEqual(sent.pastes, { '2': paste });
  // /tree: back before the message, which comes back folded with its paste
  await app.submit('/tree');
  const tree = app.state.picker!;
  tree.focus = tree
    .matches()
    .findIndex((item) => item.label === '› [Pasted text #2 +3 lines] explain');
  ui.handle({ type: 'key', key: 'enter', char: '' });
  await until(() => app.state.draft === '[Pasted text #2 +3 lines] explain');
  assert.equal(ui.composer.modelText(app.state.draft), `${paste} explain`);
  ui.composer.clear();
  // /fork: the same, in a new session; sending it again sends the paste
  await app.submit('/fork');
  ui.handle({ type: 'key', key: 'enter', char: '' });
  await until(() => app.state.draft === '[Pasted text #2 +3 lines] explain');
  ui.handle({ type: 'key', key: 'enter', char: '' });
  await until(() => model.requests.length === 1 && !runtime.busy);
  assert.equal(model.requests[0]!.messages.at(-1)!.content, `${paste} explain`);
  assert.deepEqual(runtime.harness.messages.at(-2)!.pastes, { '2': paste });
});

test('esc on the /tree label line leaves the label as it was; enter on an empty one removes it', async (t) => {
  const original = palette();
  t.after(() => setPalette(original));
  const { app, runtime, key, type } = await session(t, [answer('answer one')]);
  await app.submit('question one');
  const reply = runtime.harness.messages.find(
    (message) => message.role === 'assistant',
  )!;
  runtime.store.setLabel(runtime.session.id, reply.id, 'start');
  await app.submit('/tree');
  const list = app.state.picker!;
  list.focus = list
    .matches()
    .findIndex((item) => item.label === '⏺ [start] answer one');
  assert.ok(list.focus >= 0);
  // esc leaves the label as it was (it used to remove it)
  key('L');
  await until(() => list.asking || app.state.dialog !== undefined);
  type(' here');
  key('escape');
  await delay(20);
  assert.deepEqual(runtime.store.labels(runtime.session.id), {
    [reply.id]: 'start',
  });
  // Asked in the list, on its own line, the current label filled in: not a card
  key('L');
  await until(() => list.asking);
  assert.equal(app.state.dialog, undefined);
  assert.equal(app.state.picker, list);
  for (const colours of [
    buildPalette(...DEFAULT_DARK),
    buildPalette(...DEFAULT_LIGHT),
  ]) {
    setPalette(colours);
    const rows = list.rows(80);
    assert.equal(
      stripAnsi(rows[1]!).trimEnd(),
      '   Label (empty removes it): start▏  enter saves · esc cancels',
    );
    assert.ok(rows[1]!.startsWith(sgrJoin(colours.panel_bg, colours.dim)));
    for (const row of rows.slice(0, -1)) assert.equal(stringWidth(row), 80);
  }
  key('escape');
  assert.ok(!list.asking);
  assert.equal(app.state.picker, list);
  key('L');
  await until(() => list.asking);
  key('ctrl+u');
  key('enter');
  await until(
    () => !Object.keys(runtime.store.labels(runtime.session.id)).length,
  );
  assert.ok(list.items.some((item) => item.label === '⏺ answer one'));
});

test('/resume: esc on the new name or on the delete question leaves the session as it was', async (t) => {
  const { app, runtime, key, type, workspace } = await session(t, [
    answer('answer one'),
  ]);
  await app.submit('question one');
  const other = runtime.session.id;
  await app.submit('/new');
  await app.submit('/resume');
  const list = app.state.picker!;
  list.focus = list.matches().findIndex((item) => item.key === other);
  key('ctrl+r');
  await until(() => list.asking);
  assert.equal(
    stripAnsi(list.rows(80)[1]!).trimEnd(),
    '   New name: question one▏  enter saves · esc cancels',
  );
  type(' renamed');
  key('escape');
  assert.equal(runtime.store.get(other)!.title, 'question one');
  key('ctrl+d');
  await until(() => list.asking);
  assert.equal(
    stripAnsi(list.rows(80)[1]!).trimEnd(),
    '   Delete “question one” and its messages?  enter confirms · esc cancels',
  );
  key('escape');
  assert.ok(!list.asking);
  assert.ok(runtime.store.get(other));
  assert.ok(runtime.store.list(workspace).some((item) => item.id === other));
});

test('lists jump a page with pageup and pagedown, as 0.5.0 did, without scrolling the conversation', async (t) => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    key: String(i),
    label: `row ${i}`,
  }));
  const list = new Picker(
    'Rows',
    items,
    () => {},
    () => {},
  );
  list.rows(80, 10);
  const steps: number[] = [];
  for (const name of ['pagedown', 'pagedown', 'pagedown', 'pagedown']) {
    list.handle(name, '');
    steps.push(list.focus);
  }
  for (const name of ['pageup', 'pageup', 'pageup', 'pageup']) {
    list.handle(name, '');
    steps.push(list.focus);
  }
  // A page is what the list shows; it stops at the ends instead of wrapping
  assert.deepEqual(steps, [10, 20, 29, 29, 19, 9, 0, 0]);
  const { app, key } = await session(t);
  await app.submit('/effort');
  const effort = app.state.picker!;
  key('pagedown');
  assert.equal(effort.focus, effort.items.length - 1);
  key('pageup');
  assert.equal(effort.focus, 0);
  assert.equal(app.state.scroll, 0);
});

test('/approvals: j k and tab move, a digit picks, other keys go to the input box, and ctrl+c closes it first', async (t) => {
  const { app, ui, runtime, key, type } = await session(t);
  const store = runtime.policy.store;
  const id = runtime.session.id;
  store.record(id, 'always', 'execute', 'npm *', 'npm …');
  store.record(id, 'always', 'execute', 'git *', 'git …');
  await app.submit('/approvals');
  const list = app.state.picker!;
  // Nothing to search: no search line
  assert.ok(
    !list.rows(80).some((row) => stripAnsi(row).includes('type to search')),
  );
  const moves: number[] = [];
  for (const name of ['j', 'j', 'k', 'tab']) {
    key(name, name);
    await delay(5);
    moves.push(list.focus);
  }
  assert.deepEqual(moves, [1, 2, 1, 2]);
  // Other letters are not a search: they go to the input box, and the list stays
  type('hi');
  assert.equal(list.query, '');
  assert.equal(app.state.draft, 'hi');
  assert.equal(app.state.picker, list);
  key('backspace');
  key('backspace');
  assert.equal(app.state.draft, '');
  // ctrl+c closes it, then does what it does in the input box
  key('ctrl+c');
  assert.equal(app.state.picker, undefined);
  assert.equal(app.state.flash, 'Press ctrl+c again to exit');
  assert.equal(ui.ended, false);
  // A digit picks its row at once
  await app.submit('/approvals');
  key('2', '2');
  await until(() => store.rules(id).length === 1);
  assert.equal(app.state.picker, undefined);
  assert.equal(store.rules(id)[0]!.pattern, 'npm *');
  assert.match(app.state.notices.at(-1)!, /^Revoked · execute · git …/);
  await app.submit('/approvals');
  key('escape');
  assert.equal(app.state.picker, undefined);
});
