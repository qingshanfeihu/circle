import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stripAnsi } from '../src/ink/string_width.js';
import { SessionApp } from '../src/tui/session_app.js';
import { parseSlash, closeMatch } from '../src/tui/slash_commands.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  loadCredentials,
  loadSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
  type CircleSettings,
} from '../src/settings.js';
import { emptyUsage, type Message, type ModelResponse } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const answer = (content: string): { message: Message } => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
});
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await delay(10);
  }
}
// A full-screen session without a terminal: the real runtime, store and event handling, with
// ScriptedModel in place of the endpoint and a clipboard of its own.
async function session(
  t: Parameters<typeof scratch>[0],
  replies: ConstructorParameters<typeof ScriptedModel>[0] = [],
  options: {
    settings?: CircleSettings;
    home?: string;
    workspace?: string;
    headless?: boolean;
  } = {},
) {
  const home = options.home ?? scratch(t);
  const workspace = options.workspace ?? scratch(t);
  const settings = options.settings ?? defaultSettings();
  const model = new ScriptedModel(replies);
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  const copied: string[] = [];
  app.clipboard.copyNative = async (text: string) => {
    copied.push(text);
    return true;
  };
  await app.attach({
    workspace,
    home,
    settings,
    model,
    headless: options.headless ?? true,
  });
  const runtime = app.runtime!;
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    await runtime.close();
  });
  const key = async (name: string, char = ''): Promise<void> => {
    ui.handle({ type: 'key', key: name, char });
    await delay(20);
  };
  const screen = (): string => {
    ui.repaint();
    return JSON.stringify(app.state.messages) + app.state.notices.join('\n');
  };
  return { app, ui, runtime, model, home, workspace, copied, key, screen };
}
const said = (request: { messages: Message[] }): string[] =>
  request.messages
    .filter((message) => !message.internal)
    .map((message) => message.content);

test('/undo and /redo put the screen back; the model keeps every turn, as in 0.5.0', async (t) => {
  const { app, runtime, model, screen } = await session(t, [
    answer('answer one'),
    answer('answer two'),
    answer('answer three'),
  ]);
  await app.submit('first question');
  await app.submit('second question');
  await app.submit('/undo');
  assert.ok(!screen().includes('second question'));
  assert.ok(!screen().includes('answer two'));
  assert.ok(screen().includes('answer one'));
  assert.ok(app.state.notices.includes('Undid the last turn'));
  await app.submit('/undo');
  assert.ok(!screen().includes('first question'));
  await app.submit('/undo');
  assert.equal(app.state.flash, 'Nothing to undo');
  await app.submit('/redo');
  assert.ok(screen().includes('answer one'));
  assert.ok(!screen().includes('answer two'));
  assert.ok(app.state.notices.includes('Redid the turn'));
  // A new turn after /undo: the undone turn stays off the screen but goes to the model.
  await app.submit('third question');
  assert.deepEqual(said(model.requests[2]!), [
    'first question',
    'answer one',
    'second question',
    'answer two',
    'third question',
  ]);
  assert.ok(screen().includes('answer three'));
  assert.ok(!screen().includes('second question'));
  assert.equal(
    runtime.store
      .messages(runtime.session.id)
      .filter((message) => message.role === 'user').length,
    3,
  );
  await app.submit('/redo');
  assert.equal(app.state.flash, 'Nothing to redo');
  // As in 0.5.0 the history spans sessions: /undo after /new goes back to the old one.
  const first = runtime.session.id;
  await app.submit('/new');
  assert.notEqual(runtime.session.id, first);
  await app.submit('/undo');
  assert.equal(runtime.session.id, first);
  assert.ok(!screen().includes('third question'));
  assert.ok(screen().includes('answer one'));
});

test('a mistyped command stays in the box with a suggestion; a space or a path sends it as text', async (t) => {
  const { app, ui, model, key } = await session(t, [
    answer('one'),
    answer('two'),
  ]);
  ui.setDraft('/modles');
  await key('enter');
  assert.equal(app.state.draft, '/modles');
  assert.equal(
    app.state.flash,
    'Unknown command /modles · did you mean /models?',
  );
  ui.setDraft('/qqqqqqq');
  await key('enter');
  assert.equal(app.state.flash, 'Unknown command /qqqqqqq · /help lists them');
  assert.equal(model.requests.length, 0);
  ui.setDraft(' /modles');
  await key('enter');
  await until(() => model.requests.length === 1);
  assert.equal(model.requests[0]!.messages.at(-1)!.content, '/modles');
  await until(() => !app.runtime!.busy);
  await app.submit('/usr/bin/env is missing');
  assert.equal(
    model.requests[1]!.messages.at(-1)!.content,
    '/usr/bin/env is missing',
  );
  assert.equal(closeMatch('hepl', ['help', 'hotkeys']), 'help');
  assert.deepEqual(parseSlash('/tasks'), {
    name: 'jobs',
    rawName: 'tasks',
    args: '',
  });
  assert.deepEqual(parseSlash('/skill:review src'), {
    name: 'skill',
    rawName: 'skill:review',
    args: 'review src',
  });
});

test('while a turn runs, commands that change it wait; the listed ones still work', async (t) => {
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const { app, runtime } = await session(t, [
    async (): Promise<ModelResponse> => {
      await held;
      return { ...answer('late'), usage: emptyUsage() };
    },
  ]);
  const turn = app.submit('long question');
  await until(() => runtime.busy);
  const id = runtime.session.id;
  await app.submit('/new');
  assert.equal(app.state.flash, 'Busy · wait for the current turn to finish');
  assert.equal(runtime.session.id, id);
  await app.submit('/models other');
  assert.equal(
    app.state.flash,
    'Busy · switch models when the turn has finished',
  );
  await app.submit('/session');
  assert.match(app.state.notices.at(-1)!, new RegExp(`^session  ${id}`));
  await app.submit('/yolo');
  assert.ok(runtime.policy.yoloEnabled(id));
  release();
  await turn;
});

test('/settings changes the marked setting and saves only that key', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const saved = trustFolder(defaultSettings(), workspace);
  saved.initialized = true;
  saved.auth.base_url = 'http://127.0.0.1:9/v1';
  saved.auth.model = 'saved-model';
  saved.theme = 'dark';
  saved.future = 'keep';
  saveSettings(saved, home);
  const file = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
  const before = file();
  // What holds for this run only: a project's theme, and --model.
  const settings = structuredClone(saved);
  settings.theme = 'light';
  settings.auth.model = 'flag-model';
  const { app, key } = await session(t, [], { home, workspace, settings });
  await app.submit('/settings');
  const picker = app.state.picker!;
  assert.equal(picker.title, 'Settings');
  assert.deepEqual(
    picker.items.map((item) => [item.label, item.meta]),
    [
      ['theme', 'light'],
      ['show thinking', 'on'],
      ['esc esc opens', 'tree'],
      ['model', 'scripted · /models'],
      ['thinking depth', 'default · /effort'],
      ['endpoint', 'openai · http://127.0.0.1:9/v1'],
      ['trusted folders', '1'],
      ['mcp servers', '0 · /mcp'],
      ['data folder', home],
    ],
  );
  const choose = async (label: string): Promise<void> => {
    const list = app.state.picker!;
    list.focus = list.items.findIndex((item) => item.label === label);
    await key('enter');
  };
  await choose('show thinking');
  assert.equal(app.state.showThinking, false);
  assert.deepEqual(file(), { ...before, hide_thinking: true });
  // The list stays open on the row, showing the new value.
  assert.equal(app.state.picker!.title, 'Settings');
  assert.equal(app.state.picker!.items[app.state.picker!.focus]!.meta, 'off');
  await choose('esc esc opens');
  assert.deepEqual(file(), {
    ...before,
    hide_thinking: true,
    double_escape: 'fork',
  });
  await choose('theme');
  assert.equal(app.settings.theme, 'auto');
  assert.deepEqual(file(), {
    ...before,
    hide_thinking: true,
    double_escape: 'fork',
    theme: 'auto',
  });
  await choose('trusted folders');
  assert.equal(app.state.picker!.title, 'Settings');
  assert.equal(loadSettings(home).auth.model, 'saved-model');
});

test('/help lists custom and extension commands; /hotkeys shows what each key does', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  mkdirSync(join(workspace, '.circle', 'commands'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'commands', 'review.md'),
    '---\ndescription: Review a file\nargument-hint: <path>\n---\nReview $1 carefully.\n',
  );
  mkdirSync(join(home, 'extensions', 'hello'), { recursive: true });
  writeFileSync(
    join(home, 'extensions', 'hello', 'extension.mjs'),
    "export function register(api){api.registerCommand('hello','Say hello',(args,ctx)=>ctx.toast('hello '+args))}",
  );
  const { app } = await session(t, [], {
    home,
    workspace,
    settings: trustFolder(defaultSettings(), workspace),
    headless: false,
  });
  await app.submit('/help');
  const help = app.state.notices.at(-1)!;
  assert.match(help, /^Available commands:/);
  assert.match(
    help,
    /\/jobs {7}Background jobs: open one, or stop it \(\/tasks\)/,
  );
  assert.match(help, /Custom commands:\n {2}\/review <path> Review a file/);
  assert.match(help, /\/hello {6}Say hello/);
  assert.match(help, /Skills also: \/skill:name$/);
  await app.submit('/hello world');
  assert.equal(app.state.notices.at(-1), 'hello world');
  await app.submit('/hotkeys');
  const keys = app.state.notices.at(-1)!;
  assert.match(keys, /^Keyboard shortcuts:/);
  assert.match(keys, /ctrl\+q {10}queue a follow-up: sent when the turn ends/);
  assert.match(keys, /esc esc {9}the session tree \(\/tree\)/);
});

test('/init sends the initialize template with the focus; a custom command replaces a built-in one', async (t) => {
  const { app, model, workspace } = await session(t, [
    answer('written'),
    answer('again'),
    answer('custom'),
  ]);
  await app.submit('/init focus on the tests');
  const prompt = model.requests[0]!.messages.at(-1)!.content;
  assert.match(prompt, /^Create or update `AGENTS.md` for this repository\./);
  assert.match(prompt, /honor these\):\nfocus on the tests\n/);
  assert.ok(!prompt.includes('$ARGUMENTS'));
  await app.submit('/init');
  assert.match(
    model.requests[1]!.messages.at(-1)!.content,
    /honor these\):\n\(none\)\n/,
  );
  mkdirSync(join(workspace, '.circle', 'commands'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'commands', 'init.md'),
    '/not a command: $ARGUMENTS',
  );
  await app.submit('/init now');
  // The template is sent as it is, even though it starts with a slash.
  assert.equal(
    model.requests[2]!.messages.at(-1)!.content,
    '/not a command: now',
  );
});

test('/jobs lists running jobs first; ctrl+d stops one after asking in the list or removes one that ended', async (t) => {
  const { app, runtime, key, workspace } = await session(t);
  const script = (name: string, code: string): string => {
    writeFileSync(join(workspace, name), code);
    return `"${process.execPath}" "${join(workspace, name)}"`;
  };
  const ended = runtime.jobs.startShell(script('quick.cjs', ''), {
    sessionId: runtime.session.id,
  });
  await runtime.jobs.wait([ended.id], 5, new AbortController().signal);
  const running = runtime.jobs.startShell(
    script('slow.cjs', 'setTimeout(()=>{},30000)'),
    { sessionId: 'another' },
  );
  await app.submit('/tasks');
  const picker = app.state.picker!;
  assert.equal(picker.title, 'Background jobs');
  assert.deepEqual(
    picker.items.map((item) => item.key),
    [running.id, ended.id],
  );
  assert.match(picker.items[0]!.meta!, /^running · \d+s · other session$/);
  assert.match(picker.items[1]!.meta!, /^done · \d+s$/);
  // The question is asked in the list, as 0.5.0 did; esc keeps the job running.
  await key('ctrl+d');
  assert.equal(app.state.dialog, undefined);
  assert.equal(app.state.picker, picker);
  assert.ok(picker.asking);
  assert.ok(
    picker
      .rows(400)
      .some((row) =>
        row.includes(
          `Stop ${running.id} ${running.title.slice(0, 40)}?  enter confirms · esc cancels`,
        ),
      ),
  );
  await key('escape');
  assert.ok(!picker.asking);
  assert.equal(runtime.jobs.get(running.id)?.status, 'running');
  await key('ctrl+d');
  await key('enter');
  await until(() => runtime.jobs.get(running.id)?.status === 'stopped');
  assert.equal((app as any).ended, false);
  await until(
    () => app.state.picker?.items[0]?.meta?.startsWith('stopped') === true,
  );
  app.state.picker!.focus = 1;
  await key('ctrl+d');
  assert.equal(runtime.jobs.get(ended.id), undefined);
  assert.deepEqual(
    app.state.picker!.items.map((item) => item.key),
    [running.id],
  );
  await key('enter');
  assert.equal(app.state.jobDetail?.id, running.id);
});

test('/yolo takes off, 0, false and no as off; /plan takes on and off and says when nothing changes', async (t) => {
  const { app, runtime } = await session(t);
  const id = runtime.session.id;
  for (const word of ['off', '0', 'false', 'no', 'OFF']) {
    await app.submit('/yolo');
    assert.ok(runtime.policy.yoloEnabled(id));
    assert.equal(
      app.state.notices.at(-1),
      'Auto on · tool calls run without asking',
    );
    await app.submit(`/yolo ${word}`);
    assert.ok(!runtime.policy.yoloEnabled(id), word);
    assert.equal(
      app.state.notices.at(-1),
      'Auto off · asking for each call again',
    );
  }
  await app.submit('/plan on');
  assert.ok(runtime.harness.planMode);
  assert.equal(
    app.state.notices.at(-1),
    'Read-only on · writes and shell are blocked, /plan.md is allowed',
  );
  await app.submit('/plan on');
  assert.equal(app.state.flash, 'Read-only is already on');
  await app.submit('/plan maybe');
  assert.equal(app.state.flash, 'Usage: /plan [on|off]');
  await app.submit('/plan');
  assert.ok(!runtime.harness.planMode);
  assert.equal(app.state.notices.at(-1), 'Read-only off');
});

test('/export, /share and /unshare write the screen as Markdown under the names 0.5.0 used', async (t) => {
  const { app, runtime, home, workspace, copied } = await session(t, [
    answer('the answer'),
  ]);
  await app.submit('the question');
  await app.submit('/export');
  const exports = readdirSync(join(home, 'exports'));
  assert.equal(exports.length, 1);
  assert.match(
    exports[0]!,
    new RegExp(`^circle-${runtime.session.id}-\\d{8}-\\d{6}\\.md$`),
  );
  const markdown = readFileSync(join(home, 'exports', exports[0]!), 'utf8');
  assert.match(
    markdown,
    new RegExp(`^# Circle session \`${runtime.session.id}\``),
  );
  assert.match(markdown, /- title: `the question`/);
  assert.match(markdown, /› the question/);
  assert.match(markdown, /the answer/);
  assert.equal(
    app.state.notices.at(-1),
    `Exported ${join(home, 'exports', exports[0]!)}`,
  );
  await app.submit('/export HTML');
  assert.ok(!existsSync(join(workspace, 'HTML')));
  assert.ok(
    readdirSync(join(home, 'exports')).some((name) => name.endsWith('.html')),
  );
  await app.submit('/export notes/session.jsonl');
  assert.match(
    readFileSync(join(workspace, 'notes', 'session.jsonl'), 'utf8'),
    /"circle-session"/,
  );
  await app.submit('/share');
  const shared = join(home, 'shares', `${runtime.session.id}.md`);
  assert.match(readFileSync(shared, 'utf8'), /the answer/);
  assert.deepEqual(copied, [shared]);
  assert.equal(
    app.state.notices.at(-1),
    `Local share copy: ${shared} · path copied`,
  );
  await app.submit('/unshare');
  assert.ok(!existsSync(shared));
  assert.equal(app.state.notices.at(-1), `Unshared ${shared}`);
  await app.submit('/unshare');
  assert.equal(app.state.flash, 'No active share file');
});

test('/copy copies the last answer, or writes it to a file when there is no clipboard', async (t) => {
  const { app, home, copied } = await session(t, [answer('copy me')]);
  await app.submit('/copy');
  assert.equal(app.state.flash, 'No assistant message to copy');
  await app.submit('question');
  await app.submit('/copy');
  assert.deepEqual(copied, ['copy me']);
  assert.equal(app.state.flash, 'Copied 7 chars');
  app.clipboard.copyNative = async () => false;
  await app.submit('/copy');
  const path = join(home, 'exports', 'last-copy.txt');
  assert.equal(readFileSync(path, 'utf8'), 'copy me\n');
  assert.equal(app.state.notices.at(-1), `No clipboard tool · wrote ${path}`);
});

test('/import of a text file starts a session that gives the model its start', async (t) => {
  const { app, runtime, model, workspace } = await session(t, [
    answer('continued'),
  ]);
  const previous = runtime.session.id;
  writeFileSync(join(workspace, 'notes.md'), '# earlier chat\nwe chose B\n');
  await app.submit('/import');
  assert.equal(app.state.flash, 'Usage: /import <file.jsonl or file.md>');
  await app.submit('/import missing.md');
  assert.equal(app.state.notices.at(-1), '✖ No such file: missing.md');
  await app.submit('/import notes.md');
  assert.notEqual(runtime.session.id, previous);
  assert.equal(runtime.store.get(runtime.session.id)!.title, 'notes');
  assert.equal(
    app.state.notices.at(-1),
    `Imported ${join(workspace, 'notes.md')}`,
  );
  await app.submit('go on');
  assert.equal(
    model.requests[0]!.messages[0]!.content,
    'Imported prior transcript for continuity.\n# earlier chat\nwe chose B\n',
  );
  await app.submit('/continue');
  assert.equal(runtime.session.id, previous);
});

test('/skill loads a skill into the conversation without starting a turn', async (t) => {
  const workspace = scratch(t);
  mkdirSync(join(workspace, '.circle', 'skills', 'demo'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill\n---\nAlways answer in haiku.\n',
  );
  const { app, model } = await session(t, [answer('ok')], { workspace });
  await app.submit('/skill');
  const list = app.state.notices.at(-1)!;
  assert.match(list, /^Skills:\n\n/);
  assert.match(list, /\n {2}demo {17}A demo skill \(Project Circle\)\n/);
  assert.match(list, /\n\nLoad with \/skill <name>$/);
  await app.submit('/skill demo short');
  assert.equal(model.requests.length, 0);
  assert.equal(app.state.notices.at(-1), "Loaded skill `demo` args='short'");
  await app.submit('/skill nothing');
  assert.match(
    app.state.notices.at(-1)!,
    /^✖ Error: skill 'nothing' not found/,
  );
  await app.submit('write a poem');
  const loaded = model.requests[0]!.messages.find(
    (message) => message.internal === 'skill',
  )!;
  assert.match(
    loaded.content,
    /^\[Circle system\] Skill `demo` loaded via \/skill\.\nUser arguments: short\n/,
  );
  assert.match(loaded.content, /Always answer in haiku\./);
  assert.equal(model.requests[0]!.messages.at(-1)!.content, 'write a poem');
});

test('/name, /session, /approvals, /themes and /effort answer as 0.5.0 did', async (t) => {
  const { app, runtime, home, key } = await session(t);
  await app.submit('/name');
  assert.equal(app.state.notices.at(-1), 'Session name: new');
  assert.equal(app.state.flash, '/name <title> renames it');
  await app.submit('/name  my   work ');
  assert.equal(runtime.store.get(runtime.session.id)!.title, 'my work');
  assert.equal(app.state.notices.at(-1), 'Session name → my work');
  await app.submit('/session');
  const facts = app.state.notices.at(-1)!.split('\n');
  assert.equal(facts[0], `session  ${runtime.session.id} · my work`);
  assert.equal(facts[2], 'model    scripted');
  assert.match(facts[4]!, /^messages 0 · 0 yours · 0 from the model/);
  runtime.policy.store.record(
    runtime.session.id,
    'always',
    'execute',
    'npm *',
    'npm …',
  );
  runtime.policy.store.record(
    runtime.session.id,
    'reject',
    'write_file',
    '',
    '',
  );
  await app.submit('/approvals revoke x');
  assert.equal(app.state.flash, 'Usage: /approvals revoke <number>');
  await app.submit('/approvals revoke 4');
  assert.equal(app.state.flash, 'No rule number 4');
  await app.submit('/approvals');
  assert.equal(app.state.picker!.title, 'Session approvals');
  assert.deepEqual(
    app.state.picker!.items.map((item) => item.label),
    ['1. Revoke: npm …', '2. Close'],
  );
  await key('1');
  assert.deepEqual(runtime.policy.store.rules(runtime.session.id), []);
  assert.match(app.state.notices.at(-1)!, /^Revoked · execute · npm …/);
  await app.submit('/approvals list');
  assert.match(
    app.state.notices.at(-1)!,
    /^No always-allow rules this session\.\nRecent approvals:\n {2}allowed for session · execute\n {2}rejected · write_file\n {2}revoked · execute$/,
  );
  await app.submit('/themes');
  assert.equal(
    app.state.notices.at(-1),
    'Theme: auto · available: auto, dark, light',
  );
  await app.submit('/themes sepia');
  assert.equal(
    app.state.notices.at(-1),
    "✖ Unknown theme 'sepia' · available: auto, dark, light",
  );
  await app.submit('/themes light');
  assert.equal(loadSettings(home).theme, 'light');
  assert.equal(app.state.notices.at(-1), 'Theme → light');
  await app.submit('/effort huge');
  assert.equal(
    app.state.notices.at(-1),
    "✖ Unknown depth 'huge' · choose minimal, low, medium, high, xhigh, max",
  );
  const notes = app.state.notices.length;
  await key('shift+tab');
  assert.equal(runtime.thinkingLevel, 'minimal');
  assert.equal(app.state.flash, 'Thinking depth → minimal');
  assert.equal(app.state.notices.length, notes);
  await app.submit('/thinking HIGH');
  assert.equal(runtime.thinkingLevel, 'high');
  assert.equal(app.state.notices.at(-1), 'Thinking depth → high');
  await app.submit('/thinking');
  assert.equal(app.state.showThinking, false);
  assert.equal(app.state.flash, 'Thinking hidden');
});

test('/logout clears the key and the connection and keeps the session open', async (t) => {
  const home = scratch(t);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = 'http://127.0.0.1:9/v1';
  settings.auth.model = 'saved-model';
  settings.theme = 'dark';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'secret' }, home);
  const { app, ui } = await session(t, [], {
    home,
    settings: structuredClone(settings),
  });
  await app.submit('/logout');
  assert.deepEqual(loadCredentials(home), {});
  const file = loadSettings(home);
  assert.equal(file.initialized, false);
  assert.equal(file.auth.base_url, '');
  assert.equal(file.theme, 'dark');
  assert.equal(ui.ended, false);
  assert.equal(
    app.state.notices.at(-1),
    'Signed out · credentials cleared · /login or `circle --init` before the next turn',
  );
  await app.submit('/login openai');
  assert.equal(
    app.state.notices.at(-1),
    '✖ openai OAuth sign-in is not available yet · use API URL + KEY',
  );
  await app.submit('/login github');
  assert.equal(
    app.state.notices.at(-1),
    "✖ Unknown provider 'github' · choose anthropic, openai",
  );
});

test('/tree, /fork, /clone, /new, /continue and /resume move between branches and sessions', async (t) => {
  const { app, runtime, model, key } = await session(t, [
    answer('answer one'),
    answer('answer two'),
    answer('answer changed'),
  ]);
  await app.submit('/continue');
  assert.equal(app.state.flash, 'No previous session');
  await app.submit('/tree');
  assert.equal(app.state.flash, 'Nothing in this session yet');
  await app.submit('question one');
  await app.submit('question two');
  const pick = async (label: string): Promise<void> => {
    const picker = app.state.picker!;
    picker.focus = picker.matches().findIndex((item) => item.label === label);
    assert.ok(picker.focus >= 0, label);
    await key('enter');
  };
  await app.submit('/tree');
  assert.equal(app.state.picker!.title, 'Session tree');
  await pick('● answer two');
  assert.equal(app.state.flash, 'Already here');
  await app.submit('/tree');
  const picker = app.state.picker!;
  picker.focus = picker
    .matches()
    .findIndex((item) => item.label === '● answer two');
  await key('L');
  assert.equal(app.state.dialog, undefined);
  assert.ok(app.state.picker!.asking);
  for (const char of 'start') await key(char, char);
  await key('enter');
  assert.equal(
    app.state.picker!.items.find((item) => item.label.includes('['))!.label,
    '● [start] answer two',
  );
  assert.deepEqual(Object.values(runtime.store.labels(runtime.session.id)), [
    'start',
  ]);
  await key('escape');
  await app.submit('/tree two');
  assert.equal(app.state.picker!.query, 'two');
  await pick('› question two');
  assert.equal(app.state.draft, 'question two');
  assert.equal(
    app.state.notices.at(-1),
    'Back before your message · your next message starts a new branch · /tree shows them all',
  );
  await app.submit('question changed');
  assert.deepEqual(said(model.requests[2]!), [
    'question one',
    'answer one',
    'question changed',
  ]);
  const first = runtime.session.id;
  await app.submit('/fork');
  assert.equal(app.state.picker!.title, 'Fork from a message');
  await pick('question one');
  assert.notEqual(runtime.session.id, first);
  assert.equal(app.state.draft, 'question one');
  assert.equal(
    app.state.notices.at(-1),
    `Forked → ${runtime.session.id} · your message is back in the box`,
  );
  assert.deepEqual(runtime.harness.messages, []);
  await app.submit('/continue');
  assert.equal(runtime.session.id, first);
  assert.match(app.state.notices.at(-1)!, new RegExp(`^Continued ${first} · `));
  await app.submit('/clone');
  const cloned = runtime.session.id;
  assert.equal(app.state.notices.at(-1), `Cloned this branch → ${cloned}`);
  assert.deepEqual(said({ messages: runtime.harness.messages }), [
    'question one',
    'answer one',
    'question changed',
    'answer changed',
  ]);
  await app.submit('/new');
  assert.equal(app.state.notices.at(-1), `New session ${runtime.session.id}`);
  await app.submit(`/resume ${first.slice(-4)}`);
  assert.equal(runtime.session.id, first);
  assert.equal(app.state.notices.at(-1), `Resumed ${first} · question one`);
  await app.submit(`/resume ${first}`);
  assert.equal(app.state.flash, 'Already in that session');
  await app.submit('/resume nothing');
  assert.equal(
    app.state.notices.at(-1),
    "✖ No session 'nothing' in this folder · /resume lists them",
  );
  // The list: ctrl+r renames, ctrl+d deletes after asking, never the open session.
  await app.submit('/resume');
  assert.equal(app.state.picker!.title, 'Sessions · this folder');
  const focus = (id: string): void => {
    const picker = app.state.picker!;
    picker.focus = picker.matches().findIndex((item) => item.key === id);
  };
  focus(first);
  await key('ctrl+d');
  assert.equal(app.state.flash, 'The session you are in cannot be deleted');
  focus(cloned);
  await key('ctrl+r');
  assert.equal(app.state.dialog, undefined);
  assert.ok(app.state.picker!.asking);
  await key('ctrl+u');
  for (const char of '  the   clone ') await key(char, char);
  await key('enter');
  assert.equal(runtime.store.get(cloned)!.title, 'the clone');
  focus(cloned);
  await key('ctrl+d');
  assert.equal(app.state.dialog, undefined);
  assert.ok(app.state.picker!.asking);
  await key('enter');
  assert.equal(runtime.store.get(cloned), undefined);
  assert.ok(app.state.picker!.items.every((item) => item.key !== cloned));
  await key('tab');
  assert.equal(app.state.picker!.title, 'Sessions · every folder');
});

test('/compact, /mcp, /extensions, /trust and /reload report as 0.5.0 did', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = 'http://127.0.0.1:9/v1';
  settings.auth.model = 'saved-model';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'test-key' }, home);
  const { app, runtime } = await session(t, [], {
    home,
    workspace,
    settings: structuredClone(settings),
  });
  await app.submit('/compact');
  assert.equal(app.state.flash, 'Nothing to compact yet');
  await app.submit('/mcp');
  assert.equal(
    app.state.notices.at(-1),
    'No MCP servers. Add mcp_servers to settings.json.',
  );
  await app.submit('/mcp reload');
  assert.equal(app.state.notices.at(-1), 'MCP reloaded · 0 tools');
  await app.submit('/extensions');
  assert.match(app.state.notices.at(-1)!, /^No extensions\./);
  await app.submit('/trust');
  assert.equal(app.state.notices.at(-1), `Trusted ${workspace}`);
  assert.equal(loadSettings(home).trusted_folders.length, 1);
  await app.submit('/reload');
  assert.equal(app.state.notices.at(-1), 'Reloaded settings and the model');
  assert.equal(runtime.harness.model.model, 'saved-model');
});

test("/login asks for the URL and the key on its list, lists the endpoint's models, and signs in only once a model is chosen", async (t) => {
  // An endpoint that lists its models only under /v1, as setup finds it
  const seen: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request);
    seen.push(
      `${request.method} ${request.url} ${request.headers.authorization ?? ''}`,
    );
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ data: [{ id: 'alpha-one' }, { id: 'beta-two' }] }),
      );
    } else if (
      request.method === 'POST' &&
      request.url === '/v1/chat/completions'
    ) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(
        'data: ' +
          JSON.stringify({
            choices: [
              { index: 0, delta: { content: 'pong' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end('{"error":"not here"}');
    }
  });
  await new Promise<void>((ready) =>
    server.listen(0, '127.0.0.1', () => ready()),
  );
  cleanup(t, async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const home = scratch(t);
  const settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = 'https://gateway.example/v1/';
  settings.auth.model = 'saved-model';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'old-key' }, home);
  const before = readFileSync(join(home, 'settings.json'), 'utf8');
  const { app, ui, runtime, key } = await session(t, [], {
    home,
    settings: structuredClone(settings),
  });
  const typed = async (text: string): Promise<void> => {
    for (const char of text) await key(char, char);
  };
  await app.submit('/login');
  const picker = app.state.picker!;
  assert.equal(picker.title, 'Sign in');
  assert.equal(
    picker.options.hint,
    'now api key · gateway.example/v1 · saved-model',
  );
  assert.deepEqual(
    picker.items.map((item) => [item.label, item.meta ?? '']),
    [
      ['API URL + KEY', ''],
      ['OAuth sign-in', 'not available yet'],
    ],
  );
  // OAuth is listed but cannot be chosen
  picker.focus = 1;
  await key('enter');
  assert.equal(
    app.state.flash,
    'OAuth sign-in is not available yet · use API URL + KEY',
  );
  assert.equal(app.state.picker, picker);
  assert.ok(!picker.asking);
  // The URL on the list's own line, the saved one filled in; esc goes back to the ways in
  const line = (): string => stripAnsi(app.state.picker!.rows(120)[1]!).trim();
  picker.focus = 0;
  await key('enter');
  assert.equal(app.state.dialog, undefined);
  assert.equal(
    line(),
    'base url: https://gateway.example/v1/▏  enter continues · esc goes back',
  );
  await key('escape');
  assert.equal(app.state.picker, picker);
  assert.ok(!picker.asking);
  await key('enter');
  await key('ctrl+u');
  await typed('nonsense');
  await key('enter');
  // Not a URL: the title says why and the line asks again with what was typed
  assert.equal(
    picker.title,
    'Sign in · use an http(s) API base URL without credentials, query or fragment',
  );
  assert.equal(line(), 'base url: nonsense▏  enter continues · esc goes back');
  await key('ctrl+u');
  ui.handle({ type: 'paste', text: base });
  await key('enter');
  // The key as dots; an empty enter would keep the saved one
  assert.equal(
    line(),
    'api key (enter keeps the saved one): ▏  enter continues · esc goes back',
  );
  ui.handle({ type: 'paste', text: 'new-key' });
  assert.equal(
    line(),
    'api key (enter keeps the saved one): •••••••▏  enter continues · esc goes back',
  );
  await key('enter');
  // The endpoint's models, searchable; enter on a search nothing matches uses what was typed
  await until(() => app.state.picker?.items.length === 2);
  const models = app.state.picker!;
  assert.equal(models.options.hint, 'discovered 2 models (openai)');
  assert.deepEqual(
    models.items.map((item) => item.label),
    ['alpha-one', 'beta-two'],
  );
  assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), before);
  await typed('gamma');
  assert.equal(models.matches().length, 0);
  assert.ok(
    models
      .rows(120)
      .some((row) =>
        stripAnsi(row).includes('No model matches · enter uses what you typed'),
      ),
  );
  await key('enter');
  await until(() => app.state.notices.at(-1)?.startsWith('Signed in') === true);
  assert.equal(app.state.picker, undefined);
  assert.equal(
    app.state.notices.at(-1),
    `Signed in to 127.0.0.1:${port}/v1 · model gamma`,
  );
  // Saved: the URL that answered, the model and the new key
  const saved = loadSettings(home);
  assert.equal(saved.auth.base_url, `${base}/v1`);
  assert.equal(saved.auth.model, 'gamma');
  assert.equal(loadCredentials(home).api_key, 'new-key');
  // and the next turn goes there, with the new key
  await app.submit('ping');
  assert.ok(
    seen.includes('POST /v1/chat/completions Bearer new-key'),
    seen.join('\n'),
  );
  assert.equal(runtime.harness.model.model, 'gamma');
});
