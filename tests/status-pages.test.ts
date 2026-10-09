import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  setPalette,
  sgrJoin,
  type Palette,
} from '../src/ink/theme.js';
import { stringWidth, stripAnsi } from '../src/ink/string_width.js';
import { dialogRows } from '../src/ink/components/dialog_card.js';
import { renderScreen, type ScreenState } from '../src/tui/render.js';
import { CompactionProgress } from '../src/compaction.js';
import { SessionApp } from '../src/tui/session_app.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, saveSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { emptyUsage, type Message, type ModelResponse } from '../src/types.js';
import type { Job } from '../src/jobs.js';
import { cleanup, scratch } from './helpers.js';

const PALETTES: [string, Palette][] = [
  ['dark', buildPalette(...DEFAULT_DARK)],
  ['light', buildPalette(...DEFAULT_LIGHT)],
];
function screen(): ScreenState {
  return {
    messages: [],
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
// Every colour in `text` must be one the palette makes.
function coloursFrom(p: Palette, text: string): void {
  const allowed = new Set(
    [
      p.text,
      p.dim,
      p.faint,
      p.em,
      p.green,
      p.yellow,
      p.red,
      p.blue,
      p.reason,
      p.reason_dim,
      p.muted_strike,
      p.reset,
    ]
      .flatMap((sgr) => [...sgr.matchAll(/\x1b\[([\d;]*)m/g)])
      .map((match) => match[1]),
  );
  const bg = [
    p.panel_bg,
    p.sel_bg,
    p.read_bg,
    p.write_bg,
    p.think_bg,
    p.agent_bg,
  ].map((sgr) => sgr.slice(2, -1));
  for (const [, params] of text.matchAll(/\x1b\[([\d;]*)m/g)) {
    const parts = params!.split(';');
    for (let index = 0; index < parts.length; index++) {
      const code = parts[index]!;
      if (code === '38' || code === '48') {
        const value = parts.slice(index, index + 5).join(';');
        index += 4;
        assert.ok(
          allowed.has(value) || bg.includes(value),
          `colour ${value} is not from the palette`,
        );
      } else if (/^(3|4|9|10)\d$/.test(code))
        assert.ok(
          allowed.has(code) ||
            [...allowed].some((sgr) => sgr?.split(';').includes(code)),
          `colour ${code} is not from the palette`,
        );
    }
  }
}
function reply(
  id: string,
  content: string,
  calls: Message['tool_calls'] = [],
  usage = emptyUsage(),
): ModelResponse {
  return {
    message: {
      id,
      role: 'assistant',
      content,
      ...(calls.length ? { tool_calls: calls } : {}),
    },
    usage,
  };
}
async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await delay(10);
  }
}
// A screen big enough that nothing the test reads scrolls away or gives way.
function bigScreen(t: Parameters<typeof scratch>[0]): void {
  for (const [name, value] of [
    ['rows', 60],
    ['columns', 110],
  ] as const) {
    const before = Object.getOwnPropertyDescriptor(process.stdout, name);
    Object.defineProperty(process.stdout, name, {
      value,
      configurable: true,
      writable: true,
    });
    cleanup(t, () => {
      if (before) Object.defineProperty(process.stdout, name, before);
      else delete (process.stdout as { rows?: number; columns?: number })[name];
    });
  }
}
// A session on the full screen whose frames the test reads instead of a terminal.
async function attached(
  t: Parameters<typeof scratch>[0],
  model: ScriptedModel,
  folders: { root?: string; home?: string; headless?: boolean } = {},
) {
  bigScreen(t);
  const root = folders.root ?? scratch(t);
  const home = folders.home ?? root;
  const settings = trustFolder(defaultSettings(), root);
  const app = new SessionApp(root, home, settings);
  const ui = app as any;
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  await app.attach({
    workspace: root,
    home,
    settings,
    model,
    // Extensions load only outside headless runs.
    headless: folders.headless ?? true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    await app.runtime?.close();
  });
  const frame = (): string[] => {
    ui.repaint();
    return rendered;
  };
  return { app, ui, root, frame };
}

test('compaction runs in a row above the input box, before what waits to be read, while the frame keeps the busy word', () => {
  for (const [, p] of PALETTES) {
    setPalette(p);
    const state = screen();
    state.busy = true;
    state.busyVerb = 'Brewing';
    state.queue = { steering: ['look at the tests'], followUp: [] };
    state.compaction = new CompactionProgress('auto');
    for (const phase of ['start', 'saving', 'saved', 'summarizing'] as const)
      state.compaction.apply({ sessionId: 's', phase, trigger: 'auto' });
    state.compaction.apply({
      sessionId: 's',
      phase: 'chunks',
      trigger: 'auto',
      chunks: 200,
    });
    let rows = renderScreen(state, 100, 24);
    let plain = rows.map(stripAnsi);
    const top = plain.findIndex((row) => row.startsWith('╭'));
    assert.match(plain[top]!, /^╭──Brewing… · \d+\.\ds · ↓ 0─/);
    assert.equal(plain[top - 1]!.trim(), 'steering: look at the tests');
    const row = plain[top - 2]!;
    assert.match(row, /^ auto-compacting · [█░]{16} summarizing · \d+s +$/);
    // Not full before the summary is in; the filled cells are text, the rest faint.
    const filled = [...row].filter((char) => char === '█').length;
    assert.ok(filled > 1 && filled < 16, row);
    assert.ok(rows[top - 2]!.includes(p.text + '█'));
    assert.ok(rows[top - 2]!.includes(p.faint + '░'));
    // (the frame runs the rainbow while busy; the rest of the screen is the palette's)
    coloursFrom(p, rows.slice(0, top).join('\n'));
    state.compaction.apply({
      sessionId: 's',
      phase: 'summarized',
      trigger: 'auto',
    });
    plain = renderScreen(state, 100, 24).map(stripAnsi);
    assert.ok(plain.some((line) => /█{16} summarized/.test(line)));
    // A narrow screen drops the stage and the clock before the bar.
    state.queue = undefined;
    plain = renderScreen(state, 40, 24).map(stripAnsi);
    const narrow = plain.findIndex((line) => line.startsWith('╭')) - 1;
    assert.equal(
      plain[narrow]!.trimEnd(),
      ' auto-compacting · ████████████████',
    );
    rows = renderScreen(state, 24, 24);
    assert.ok(rows.every((line) => stringWidth(line) === 24));
    // Gone when it ends.
    state.compaction = undefined;
    plain = renderScreen(state, 100, 24).map(stripAnsi);
    assert.ok(!plain.some((line) => line.includes('compacting')));
  }
});

test('a subagent folds under its Agent row while it runs and when it is done, and its page has the band and record of 0.5.0', async (t) => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_tokens: 0,
  };
  let running: string[] = [];
  let capture = (): string[] => [];
  const read = (id: string, file: string) =>
    reply(
      id,
      '',
      [{ id: 'r-' + id, name: 'read_file', args: { file_path: file } }],
      usage,
    );
  const model = new ScriptedModel([
    reply('p1', '', [
      {
        id: 'task-1',
        name: 'task',
        args: {
          description: 'count the notes',
          subagent_type: 'general-purpose',
        },
      },
    ]),
    async (request) => {
      request.token('**Scan the notes**\n\nOne file at a time.', true);
      await delay(20);
      return {
        message: {
          ...read('c1', 'a.txt').message,
          thinking: '**Scan the notes**\n\nOne file at a time.',
        },
        usage,
      };
    },
    read('c2', 'b.txt'),
    read('c3', 'c.txt'),
    read('c4', 'd.txt'),
    async () => {
      running = capture();
      return reply('c5', 'Four notes, nine lines.', [], usage);
    },
    reply('p2', 'Done.'),
  ]);
  const { app, ui, root, frame } = await attached(t, model);
  capture = () => [...frame()];
  for (const name of ['a', 'b', 'c', 'd'])
    writeFileSync(join(root, `${name}.txt`), `${name}1\n${name}2\n`);
  await app.submit('count them');
  for (const [, p] of PALETTES) {
    setPalette(p);
    // While it ran: the meta line, the earlier calls folded, the last three calls lit.
    let plain = running.map(stripAnsi);
    const at = plain.findIndex((row) =>
      row.startsWith(' ● Agent(count the notes)'),
    );
    assert.ok(at >= 0, plain.join('\n'));
    assert.match(
      plain[at + 1]!,
      /^ {3}⎿ general-purpose · 4 calls · \d+s · 4\.4k tokens +$/,
    );
    assert.equal(plain[at + 2]!.trimEnd(), '     … +1 earlier · ctrl+o');
    assert.deepEqual(
      plain.slice(at + 3, at + 6).map((row) => row.trimEnd()),
      ['     ● Read(b.txt)', '     ● Read(c.txt)', '     ● Read(d.txt)'],
    );
    // Done: the meta line only, then what the task returned; ctrl+o lists every call.
    app.state.showTools = false;
    let rows = frame();
    plain = rows.map(stripAnsi);
    const done = plain.findIndex((row) =>
      row.startsWith(' ● Agent(count the notes)'),
    );
    assert.match(
      plain[done + 1]!,
      /^ {3}⎿ general-purpose · 4 calls · \d+s · 5\.5k tokens +$/,
    );
    assert.equal(plain[done + 2]!.trimEnd(), '   ⎿ Four notes, nine lines.');
    for (const index of [done, done + 1, done + 2])
      assert.ok(rows[index]!.includes(p.agent_bg.slice(2, -1)));
    // (the welcome's logo above keeps its own colours)
    coloursFrom(p, rows.slice(done).join('\n'));
    app.state.showTools = true;
    plain = frame().map(stripAnsi);
    const all = plain.findIndex((row) =>
      row.startsWith(' ● Agent(count the notes)'),
    );
    assert.deepEqual(
      plain.slice(all + 2, all + 6).map((row) => row.trimEnd()),
      [
        '     ● Read(a.txt)',
        '     ● Read(b.txt)',
        '     ● Read(c.txt)',
        '     ● Read(d.txt)',
      ],
    );
    app.state.showTools = false;
    // The page: a band under the header and the record under it.
    const agent = app.state.subagents![0]!;
    ui.agents.detail = agent.id;
    rows = frame();
    plain = rows.map(stripAnsi);
    assert.match(
      plain[2]!,
      /^ ● general-purpose·\w+ \(1 of 1\) · done · 4 calls · ↑5\.5k · \d+s +main {4}prev {4}next {2}$/,
    );
    assert.ok(rows[2]!.includes(p.panel_bg.slice(2, -1)));
    assert.ok(rows[2]!.includes(sgrJoin(p.panel_bg, p.green) + ' · done'));
    assert.equal(plain[3]!.trimEnd(), ' Task · count the notes');
    assert.equal(plain[4]!.trim(), '');
    assert.match(
      plain[5]!,
      /^ ⎿ ∴ Thought \d+s · Scan the notes · 39 chars {2}ctrl\+t +$/,
    );
    assert.ok(rows[5]!.includes(p.reason.slice(2, -1)));
    assert.ok(!rows[5]!.includes(p.think_bg.slice(2, -1)));
    assert.ok(!rows[5]!.includes('\x1b[48'));
    assert.equal(plain[6]!.trimEnd(), ' ● Read(a.txt) 1: a1');
    assert.ok(rows[6]!.includes(p.read_bg.slice(2, -1)));
    assert.equal(plain[9]!.trimEnd(), ' ● Read(d.txt) 1: d1');
    assert.equal(plain[10]!.trim(), '');
    assert.equal(plain[11]!.trimEnd(), ' 4 tool calls · 1 thinking');
    assert.match(plain[12]!, /^ Result · done · 4 calls · ↑5\.5k · \d+s +$/);
    assert.equal(plain[13]!.trimEnd(), '    ⎿ Four notes, nine lines.');
    coloursFrom(p, rows.join('\n'));
    // ctrl+t shows the reasoning under its row, still without a tint.
    app.state.thinkingExpanded = true;
    const openRows = frame();
    plain = openRows.map(stripAnsi);
    const body = openRows.find(
      (row) => stripAnsi(row).trim() === 'One file at a time.',
    );
    assert.ok(body);
    assert.ok(body!.includes(p.faint.slice(2, -1)));
    assert.ok(!body!.includes(p.think_bg.slice(2, -1)));
    app.state.thinkingExpanded = false;
    // `main` on the band goes back to the conversation.
    plain = frame().map(stripAnsi);
    const band = app.state.pageButtons!;
    assert.deepEqual(
      band.spans.map(([start, end, action]) => [
        plain[band.row]!.slice(start, end),
        action,
      ]),
      [
        [' main ', 'back'],
        [' prev ', 'prev'],
        [' next ', 'next'],
      ],
    );
    ui.handle({
      type: 'mouse',
      action: 'press',
      button: 0,
      x: band.spans[0]![0],
      y: band.row,
    });
    assert.equal(app.state.agentDetail, undefined);
    assert.equal(app.state.pageButtons, undefined);
  }
});

test('a background job is one faint line under its call and a notice row whose glyph says how it ended', async (t) => {
  const root = scratch(t);
  writeFileSync(
    join(root, 'fail.cjs'),
    "process.stdout.write('boom\\n'); process.exit(3);",
  );
  writeFileSync(
    join(root, 'slow.cjs'),
    "process.stdout.write('ready\\n'); setTimeout(() => {}, 4000);",
  );
  const node = JSON.stringify(process.execPath);
  let runtime!: AgentRuntime;
  const model = new ScriptedModel([
    reply('p1', '', [
      {
        id: 'bg',
        name: 'execute',
        args: { command: `${node} fail.cjs`, background: true },
      },
    ]),
    async () => {
      // ctrl+b once the command has printed, as you would: a fixed delay lost the race
      // against a slow start on a busy runner.
      const printed = (): boolean =>
        readdirSync(root, { recursive: true })
          .map((name) => join(root, String(name)))
          .filter((path) => path.endsWith('.log'))
          .some((path) => readFileSync(path, 'utf8').includes('ready\n'));
      void (async () => {
        for (const end = Date.now() + 15000; !printed() && Date.now() < end;)
          await delay(20);
        runtime.jobs.backgroundForeground();
      })();
      return reply('p2', '', [
        { id: 'fg', name: 'execute', args: { command: `${node} slow.cjs` } },
      ]);
    },
    reply('p3', 'Both are going.'),
  ]);
  runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('start them');
  const failed = runtime.jobs
    .list()
    .find((job) => job.title.includes('fail.cjs'))!;
  await runtime.jobs.wait([failed.id], 5, new AbortController().signal);
  const notices = runtime.jobs.takeNotices(runtime.session.id, [failed.id]);
  // The model still reads the whole sentence about the job.
  const results = runtime.harness.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.match(
    results[0]!.content,
    /^In background: j1 · shell · .*do not poll or sleep\.$/,
  );
  // what the command printed before it moved stays with the result, as in 0.5.0
  assert.match(
    results[1]!.content,
    /^ready\n\nThe command was moved to the background\.\nCommand continues in background: j2 · shell · /,
  );
  for (const [, p] of PALETTES) {
    setPalette(p);
    const state = screen();
    state.messages = [...runtime.harness.messages, ...notices];
    const rows = renderScreen(state, 100, 30);
    const plain = rows.map(stripAnsi);
    const [first, second] = plain.flatMap((row, index) =>
      row.startsWith(' ● Bash(') ? [index] : [],
    );
    assert.equal(plain[first! + 1]!.trimEnd(), '   ⎿ in background · j1');
    assert.ok(
      rows[first! + 1]!.includes(
        sgrJoin(p.write_bg, p.faint) + 'in background',
      ),
    );
    // what it printed before, then the job; the sentences for the model are not shown
    assert.equal(plain[second! + 1]!.trimEnd(), '   ⎿ ready');
    assert.equal(
      plain[second! + 2]!.trimEnd(),
      '     moved to background · j2',
    );
    assert.ok(!plain.some((row) => row.includes('The command was')));
    assert.ok(!plain.some((row) => row.includes('do not poll')));
    const notice = plain.findIndex((row) => row.startsWith(' ◆ j1'));
    assert.match(plain[notice]!, /^ ◆ j1 failed · exit 3 · .+ · \d+s +$/);
    assert.ok(
      rows[notice]!.startsWith(` ${p.red}◆${p.reset} ${p.dim}j1 failed`),
    );
    coloursFrom(p, rows.join('\n'));
  }
  // A session of the Python releases: the job is in `circle_job`, the output before it stays.
  const state = screen();
  state.messages = [
    reply('a', '', [{ id: 'old', name: 'execute', args: { command: 'make' } }])
      .message,
    {
      id: 'r',
      role: 'tool',
      tool_call_id: 'old',
      name: 'execute',
      status: 'success',
      content:
        'compiling\nlinking\n\n[The command was still running after 120 seconds. It continues as job j7; stop it with stop_job.]\n[Command succeeded with exit code 0]',
      legacy_data: {
        type: 'tool',
        data: { additional_kwargs: { circle_job: { id: 'j7', how: 'moved' } } },
      },
    },
  ];
  const plain = renderScreen(state, 100, 30).map(stripAnsi);
  const make = plain.findIndex((row) => row.startsWith(' ● Bash(make)'));
  assert.deepEqual(
    plain.slice(make + 1, make + 4).map((row) => row.trimEnd()),
    ['   ⎿ compiling', '     linking', '     moved to background · j7'],
  );
});

test("an extension's result lines fold like a built-in result, and a renderer that fails or returns nothing gives the built-in lines", async (t) => {
  const home = scratch(t);
  const root = scratch(t);
  writeFileSync(join(root, 'notes.txt'), 'alpha\n');
  mkdirSync(join(home, 'extensions', 'fold'), { recursive: true });
  writeFileSync(
    join(home, 'extensions', 'fold', 'extension.mjs'),
    `export function register(api) {
      api.registerRenderer('tool_result:ls', () => Array.from({ length: 9 }, (_, i) => '   custom ' + i));
      api.registerRenderer('tool_result:glob', () => { throw new Error('broken'); });
      api.registerRenderer('tool_result:grep', () => []);
    }`,
  );
  const model = new ScriptedModel([
    reply('p1', '', [
      { id: 'l', name: 'ls', args: { path: '.' } },
      { id: 'g', name: 'glob', args: { pattern: '*.txt' } },
      { id: 's', name: 'grep', args: { pattern: 'alpha' } },
    ]),
    reply('p2', 'Listed.'),
  ]);
  const { app, frame } = await attached(t, model, {
    root,
    home,
    headless: false,
  });
  await app.submit('look around');
  for (const [, p] of PALETTES) {
    setPalette(p);
    app.state.showTools = false;
    let rows = frame();
    let plain = rows.map(stripAnsi);
    const ls = plain.findIndex((row) => row.startsWith(' ● Ls('));
    assert.deepEqual(
      plain.slice(ls + 1, ls + 8).map((row) => row.trimEnd()),
      [0, 1, 2, 3, 4, 5]
        .map((i) => '   custom ' + i)
        .concat('     … +3 lines · ctrl+o'),
    );
    for (const index of [ls + 1, ls + 7])
      assert.ok(rows[index]!.includes(p.read_bg.slice(2, -1)));
    const glob = plain.findIndex((row) => row.startsWith(' ● Glob(*.txt)'));
    assert.match(plain[glob + 1]!, /^ {3}⎿ /);
    assert.ok(
      plain
        .slice(glob + 1, glob + 3)
        .join('')
        .includes('notes.txt'),
    );
    const grep = plain.findIndex((row) => row.startsWith(' ● Grep(alpha)'));
    assert.match(plain[grep + 1]!, /^ {3}⎿ .*notes\.txt/);
    coloursFrom(p, rows.slice(ls).join('\n'));
    app.state.showTools = true;
    plain = frame().map(stripAnsi);
    const shown = plain.findIndex((row) => row.startsWith(' ● Ls('));
    assert.deepEqual(
      plain.slice(shown + 1, shown + 10).map((row) => row.trimEnd()),
      [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => '   custom ' + i),
    );
  }
});

test('a card waiting for you has a yellow frame with the mode word, and a card that only says what Circle is doing has a faint one', () => {
  for (const [, p] of PALETTES) {
    setPalette(p);
    const waiting = dialogRows(
      {
        title: 'Bash needs your permission',
        body: 'npm test',
        options: ['Allow once', 'Reject'],
        focus: 0,
        tint: 'write_bg',
      },
      60,
      20,
      { word: 'read-only', sgr: p.green },
    );
    assert.ok(waiting[0]!.startsWith(p.yellow + '╭'));
    assert.match(stripAnsi(waiting.at(-1)!), /^╰─+ read-only ─╯$/);
    assert.ok(waiting.at(-1)!.includes(p.green + ' read-only '));
    assert.ok(waiting[1]!.includes(p.write_bg.slice(2, -1)));
    assert.ok(waiting[1]!.includes(';36m●'));
    const busy = dialogRows(
      {
        title: 'Looking for models…',
        body: 'asking https://example.test/v1',
        options: [],
        focus: 0,
        lamp: 'running',
      },
      60,
      20,
    );
    assert.ok(busy[0]!.startsWith(p.faint + '╭'));
    assert.match(busy[1]!, /\x1b\[(2;)?33m●/);
    for (const rows of [waiting, busy]) {
      assert.ok(rows.every((row) => stringWidth(row) === 60));
      coloursFrom(p, rows.join('\n'));
    }
  }
});

test('with --init the welcome shows no model and unlit lamps until a new one is saved, and the card says while it looks for models', async (t) => {
  const home = scratch(t);
  const root = scratch(t);
  writeFileSync(join(root, 'AGENTS.md'), '# rules\n');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (request, response) => {
    await held;
    response.setHeader('content-type', 'application/json');
    response.end(
      request.url?.endsWith('/models')
        ? JSON.stringify({ data: [{ id: 'new-model' }] })
        : '{}',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(
    t,
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const settings = trustFolder(defaultSettings(), root);
  settings.initialized = true;
  settings.auth.base_url = 'https://old.example.test/v1';
  settings.auth.model = 'old-model';
  saveSettings(settings, home);
  const app = new SessionApp(root, home, settings);
  const ui = app as any;
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  cleanup(t, () => {
    release();
    ui.input.close();
  });
  const frame = (): string[] => {
    ui.repaint();
    return rendered;
  };
  const p = buildPalette(...DEFAULT_DARK);
  setPalette(p);
  const type = (text: string): void => {
    for (const char of text) ui.handle({ type: 'key', key: char, char });
  };
  const enter = (): void => ui.handle({ type: 'key', key: 'enter', char: '' });
  const setup = app.initialize(true);
  await until(() => app.state.dialog?.title === "What is the API's base URL?");
  let plain = frame().map(stripAnsi);
  assert.ok(
    plain.some((row) => row.includes('not connected yet')),
    plain.join('\n'),
  );
  assert.ok(!plain.some((row) => row.includes('old-model')));
  const rules = frame().find((row) => stripAnsi(row).includes('AGENTS.md'))!;
  assert.ok(!rules.includes('●'), 'the lamp is unlit while setup asks');
  type(url);
  enter();
  await until(() => app.state.dialog?.title === 'What is the API key?');
  type('secret-key');
  enter();
  await until(() => app.state.dialog?.lamp === 'running');
  let rows = frame();
  plain = rows.map(stripAnsi);
  const top = plain.findIndex((row) => row.startsWith('╭'));
  assert.ok(rows[top]!.startsWith(p.faint + '╭'));
  assert.match(plain[top + 1]!, /^│ ● Looking for models… +│$/);
  assert.match(
    plain[top + 2]!,
    new RegExp(`^│ {3}asking ${url.replace(/[./]/g, '\\$&')} +│$`),
  );
  assert.ok(!plain.some((row) => row.includes('old-model')));
  release();
  await until(() => app.state.dialog?.title === 'Which model?');
  enter();
  assert.equal(await setup, true);
  rows = frame();
  plain = rows.map(stripAnsi);
  assert.ok(
    plain.some((row) => row.includes('new-model · 127.0.0.1')),
    plain.join('\n'),
  );
  assert.equal(app.settings.auth.model, 'new-model');
});

test("a job's page has 0.5.0's band: lamp, id and command, state and time, and the file its output goes to", (t) => {
  const root = scratch(t);
  const output = join(root, 'j3.log');
  writeFileSync(output, 'line one\nline two\n');
  const job: Job = {
    id: 'j3',
    kind: 'shell',
    title: 'npm test',
    status: 'running',
    reason: '',
    started: Date.now() - 12_000,
    outputPath: output,
    virtualPath: '/jobs/j3.log',
    sessionId: 's',
  };
  const ended: Job = {
    ...job,
    status: 'failed',
    reason: 'exit',
    exitCode: 1,
    ended: job.started + 4_000,
  };
  for (const [, p] of PALETTES) {
    setPalette(p);
    let rows = renderScreen({ ...screen(), jobDetail: job }, 80, 24);
    let plain = rows.map(stripAnsi);
    // Under the header: the band on the panel, then the output
    assert.match(plain[2]!, /^ ● j3 npm test +running · 12s $/);
    assert.equal(plain[3]!.trimEnd(), '   /jobs/j3.log');
    assert.ok(rows[2]!.includes(sgrJoin(p.panel_bg, p.em) + ' j3 npm test'));
    assert.ok(rows[2]!.includes(p.yellow.slice(2, -1) + 'm●'));
    assert.ok(rows[3]!.startsWith(sgrJoin(p.panel_bg, p.faint)));
    assert.deepEqual(
      plain.slice(4, 6).map((row) => row.trimEnd()),
      ['line one', 'line two'],
    );
    assert.ok(!plain.some((row) => row.includes('esc back')));
    for (const row of rows) assert.equal(stringWidth(row), 80);
    coloursFrom(p, rows.join('\n'));
    rows = renderScreen({ ...screen(), jobDetail: ended }, 80, 24);
    plain = rows.map(stripAnsi);
    assert.match(plain[2]!, /^ ● j3 npm test +failed · exit 1 · 4s $/);
    assert.ok(rows[2]!.includes(sgrJoin(p.panel_bg, p.red) + '●'));
    coloursFrom(p, rows.join('\n'));
  }
});

test('a press on a subagent row in the strip opens its page, as in 0.5.0', async (t) => {
  let check = (): void => {};
  const model = new ScriptedModel([
    reply('p1', '', [
      {
        id: 'task-1',
        name: 'task',
        args: { description: 'look around', subagent_type: 'general-purpose' },
      },
    ]),
    async () => {
      check();
      return reply('c1', 'Nothing here.');
    },
    reply('p2', 'Done.'),
  ]);
  const { app, ui, frame } = await attached(t, model);
  let row = '';
  let opened: string | undefined;
  let header: string | undefined;
  check = () => {
    const plain = frame().map(stripAnsi);
    const strip = app.state.stripAgents!;
    row = plain[strip.row]!;
    // the strip's header is not a row to open
    ui.handle({
      type: 'mouse',
      action: 'press',
      button: 0,
      x: 4,
      y: strip.row - 1,
    });
    header = app.state.agentDetail?.id;
    ui.handle({
      type: 'mouse',
      action: 'press',
      button: 0,
      x: 4,
      y: strip.row,
    });
    opened = app.state.agentDetail?.id;
  };
  await app.submit('look');
  assert.match(
    row,
    /^ ● general-purpose·\w+ +look around +\d+s · \d+ tokens $/,
  );
  assert.equal(header, undefined);
  assert.equal(opened, app.state.subagents![0]!.id);
  assert.equal(app.state.agentDetail?.id, opened);
});
