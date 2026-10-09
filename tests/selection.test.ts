import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Clipboard,
  osc52,
  tmuxPassthrough,
  type CommandRunner,
} from '../src/ink/clipboard.js';
import { InputParser } from '../src/ink/parse_keypress.js';
import {
  Grid,
  createSelectionState,
  getSelectedText,
  hasSelection,
  paintRow,
  paintSelection,
  selectionBounds,
} from '../src/ink/selection.js';
import { stringWidth, stripAnsi } from '../src/ink/string_width.js';
import {
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  buildPalette,
  palette,
  setPalette,
  sgrJoin,
} from '../src/ink/theme.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { SessionApp } from '../src/tui/session_app.js';
import { cleanup, scratch } from './helpers.js';

interface Call {
  command: string;
  args: string[];
  input: Buffer;
}
/** A command runner that records what it was asked to run and answers from `codes`
 * (exit code; null: not installed). Nothing outside the test is run. */
function fakeRunner(codes: Record<string, number | null> = {}): {
  run: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: CommandRunner = async (command, args, input) => {
    calls.push({ command, args, input });
    return command in codes ? codes[command]! : 0;
  };
  return { run, calls };
}

async function session(t: TestContext, replies: string[] = []) {
  const root = scratch(t);
  const settings = defaultSettings();
  const model = new ScriptedModel(
    replies.map((content) => ({
      message: { id: randomUUID(), role: 'assistant' as const, content },
    })),
  );
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const app = new SessionApp(root, root, settings);
  app.runtime = runtime;
  const ui = app as any;
  let frame: string[] = [];
  ui.screen.render = (rows: string[]) => {
    frame = rows;
  };
  const writes: string[] = [];
  const runner = fakeRunner();
  ui.clipboard = new Clipboard({
    env: {},
    platform: 'darwin',
    run: runner.run,
    write: (text) => writes.push(text),
  });
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    ui.selection.close();
  });
  const parser = new InputParser();
  const feed = (data: string): void => {
    for (const event of parser.feed(data)) ui.handle(event);
  };
  const mouse = {
    press: (x: number, y: number) => feed(`\x1b[<0;${x + 1};${y + 1}M`),
    drag: (x: number, y: number) => feed(`\x1b[<32;${x + 1};${y + 1}M`),
    release: (x: number, y: number) => feed(`\x1b[<0;${x + 1};${y + 1}m`),
    wheelUp: () => feed('\x1b[<64;2;2M'),
    wheelDown: () => feed('\x1b[<65;2;2M'),
  };
  if (replies.length) await app.submit('question');
  ui.repaint();
  return {
    app,
    ui,
    runtime,
    root,
    writes,
    calls: runner.calls,
    feed,
    mouse,
    frame: () => frame,
    plain: () => frame.map(stripAnsi),
    /** Screen column and row of `text` in the painted frame. */
    find(text: string): { x: number; y: number } {
      const y = frame.findIndex((row) => stripAnsi(row).includes(text));
      assert.ok(y >= 0, `${text} is on screen`);
      const plain = stripAnsi(frame[y]!);
      return { x: stringWidth(plain.slice(0, plain.indexOf(text))), y };
    },
  };
}

/** The row carries the palette's selection background, alone or joined to a foreground. */
function selectedIn(row: string): boolean {
  return row.includes(palette().sel_bg.slice(2, -1));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await delay(1);
}

test('the parser reads the SGR mouse reports that button-event tracking sends', () => {
  const events = new InputParser().feed(
    '\x1b[<0;5;3M\x1b[<32;9;3M\x1b[<0;9;3m\x1b[<35;9;4M\x1b[<64;1;1M',
  );
  assert.deepEqual(
    events.map((event) =>
      event.type === 'mouse'
        ? [event.action, event.button, event.x, event.y]
        : [],
    ),
    [
      ['press', 0, 4, 2],
      ['move', 0, 8, 2],
      ['release', 0, 8, 2],
      ['move', 3, 8, 3],
      ['wheel', 0, 0, 0],
    ],
  );
});

test('dragging over the transcript selects its text, paints it from the palette and copies it on release', async (t) => {
  const s = await session(t, ['alpha beta-gamma delta']);
  const { x, y } = s.find('alpha beta');
  s.mouse.press(x, y);
  s.mouse.drag(x, y); // still the pressed cell: a click, not a selection
  assert.equal(hasSelection(s.ui.selection.state), false);
  s.mouse.drag(x + 9, y);
  assert.equal(
    getSelectedText(s.ui.selection.state, s.ui.selection.grid),
    'alpha beta',
  );
  assert.ok(selectedIn(s.frame()[y]!));
  assert.equal(stripAnsi(s.frame()[y]!), stripAnsi(s.ui.frameRows[y]));
  s.mouse.release(x + 9, y);
  await settle();
  assert.deepEqual(
    s.calls.map((call) => [call.command, call.input.toString()]),
    [['pbcopy', 'alpha beta']],
  );
  assert.deepEqual(s.writes, ['\x1b]52;c;YWxwaGEgYmV0YQ==\x07']);
  assert.equal(s.app.state.flash, 'Copied 10 chars');
  // the selection stays up after the copy, and follows a theme change on the next paint
  assert.ok(hasSelection(s.ui.selection.state));
  try {
    setPalette(buildPalette(...DEFAULT_LIGHT));
    s.ui.repaint();
    assert.ok(selectedIn(s.frame()[y]!));
  } finally {
    setPalette(buildPalette(...DEFAULT_DARK));
  }
  // a click elsewhere drops it without copying
  s.mouse.press(1, y);
  s.mouse.release(1, y);
  await settle();
  assert.equal(s.writes.length, 1);
  assert.ok(!selectedIn(s.frame()[y]!));
});

test('a double click selects a word and a triple click the line, each copied on release', async (t) => {
  const s = await session(t, ['alpha beta-gamma delta']);
  let now = 1000;
  s.ui.selection.now = () => now;
  const { x, y } = s.find('beta-gamma');
  const click = (): void => {
    s.mouse.press(x + 2, y);
    s.mouse.release(x + 2, y);
    now += 100;
  };
  click();
  click();
  await settle();
  assert.equal(
    Buffer.from(s.writes.at(-1)!.slice(7, -1), 'base64').toString(),
    'beta-gamma',
  );
  assert.equal(s.ui.selection.state.anchorSpan.kind, 'word');
  click();
  await settle();
  const line = s.plain()[y]!.trimEnd();
  assert.ok(line.endsWith('alpha beta-gamma delta'));
  assert.equal(s.writes.at(-1), osc52(line));
  assert.equal(s.ui.selection.state.anchorSpan.kind, 'line');
  // a word drag extends by whole words and keeps the first word
  now += 1000;
  click();
  s.mouse.press(x + 2, y);
  s.mouse.drag(x + 13, y);
  assert.equal(
    getSelectedText(s.ui.selection.state, s.ui.selection.grid),
    'beta-gamma delta',
  );
  s.mouse.release(x + 13, y);
});

test('with a selection, ctrl+c copies it again instead of clearing the draft, and esc clears it', async (t) => {
  const s = await session(t, ['alpha beta-gamma delta']);
  const { x, y } = s.find('alpha');
  s.mouse.press(x, y);
  s.mouse.drag(x + 4, y);
  s.mouse.release(x + 4, y);
  await settle();
  s.ui.setDraft('draft');
  s.feed('\x03');
  await settle();
  assert.equal(s.app.state.draft, 'draft');
  assert.deepEqual(s.writes, [osc52('alpha'), osc52('alpha')]);
  s.ui.handle({ type: 'key', key: 'escape', char: '' });
  assert.equal(hasSelection(s.ui.selection.state), false);
  assert.ok(!selectedIn(s.frame()[y]!));
  s.feed('\x03');
  await settle();
  assert.equal(s.app.state.draft, '');
  assert.equal(s.writes.length, 2);
});

test('wheel scrolling moves the selection with its text and keeps the rows that scroll out of sight', async (t) => {
  const lines = Array.from(
    { length: 60 },
    (_, i) => `line ${String(i + 1).padStart(2, '0')}`,
  );
  const s = await session(t, [lines.join('\n\n')]);
  const viewport = s.app.state.viewport!;
  assert.ok(viewport.total > viewport.height);
  const start = s.find('line 57');
  const end = s.find('line 59');
  s.mouse.press(start.x, start.y);
  s.mouse.drag(end.x + 6, end.y);
  s.mouse.release(end.x + 6, end.y);
  await settle();
  const text = Buffer.from(s.writes[0]!.slice(7, -1), 'base64').toString();
  assert.equal(
    text,
    s
      .plain()
      .slice(start.y, end.y + 1)
      .map((row, index) => (index ? row : row.slice(start.x)).trimEnd())
      .join('\n'),
  );
  assert.match(text, /^line 57\n[\s\S]*line 58\n[\s\S]*line 59$/);
  const selected = (): string =>
    getSelectedText(s.ui.selection.state, s.ui.selection.grid);
  s.mouse.wheelUp();
  assert.equal(s.app.state.scroll, 3);
  assert.equal(selectionBounds(s.ui.selection.state)![0].row, start.y + 3);
  assert.equal(selected(), text);
  const painted = s.frame().findIndex((row) => selectedIn(row));
  assert.equal(stripAnsi(s.frame()[painted]!).trim(), 'line 57');
  // further up the end of the selection leaves the screen; its text is kept
  s.mouse.wheelUp();
  assert.ok(s.ui.selection.state.scrolledOffBelow.length > 0);
  assert.equal(selected(), text);
  // and back down, the same rows are on screen and selected again
  s.mouse.wheelDown();
  s.mouse.wheelDown();
  assert.equal(s.app.state.scroll, 0);
  assert.deepEqual(s.ui.selection.state.scrolledOffBelow, []);
  assert.equal(selectionBounds(s.ui.selection.state)![0].row, start.y);
  s.feed('\x03');
  await settle();
  assert.equal(s.writes.at(-1), osc52(text));
});

test('on a transcript scrolled back, the selection stays on its text when rows arrive below', async (t) => {
  const lines = Array.from(
    { length: 60 },
    (_, i) => `line ${String(i + 1).padStart(2, '0')}`,
  );
  const s = await session(t, [lines.join('\n\n')]);
  s.mouse.wheelUp();
  const { x, y } = s.find('line 55');
  s.mouse.press(x, y);
  s.mouse.drag(x + 6, y);
  s.mouse.release(x + 6, y);
  await settle();
  s.ui.notice('one more row');
  s.ui.notice('and another');
  const selected = getSelectedText(s.ui.selection.state, s.ui.selection.grid);
  assert.equal(selected, 'line 55');
  const painted = s.frame().findIndex((row) => selectedIn(row));
  assert.notEqual(painted, y, 'the text moved up');
  assert.equal(stripAnsi(s.frame()[painted]!).trim(), 'line 55');
});

test('dragging to the top of the transcript scrolls it and the selection grows onto the rows that come in', async (t) => {
  const lines = Array.from(
    { length: 60 },
    (_, i) => `line ${String(i + 1).padStart(2, '0')}`,
  );
  const s = await session(t, [lines.join('\n\n')]);
  const top = s.app.state.viewport!.top;
  const firstShown = s
    .plain()
    .slice(top)
    .find((row) => row.trim())!
    .trim();
  const from = s.find('line 60');
  s.mouse.press(from.x + 7, from.y);
  s.mouse.drag(0, top);
  await delay(400);
  s.mouse.release(0, top);
  await settle();
  assert.ok(s.app.state.scroll >= 4);
  const text = Buffer.from(s.writes.at(-1)!.slice(7, -1), 'base64').toString();
  const copied = text.split('\n').map((row) => row.trim());
  assert.equal(copied.at(-1), 'line 60');
  assert.ok(copied.length > s.app.state.viewport!.height);
  assert.ok(copied.indexOf(firstShown) > 0, 'rows above the first one shown');
  assert.equal(s.ui.selection.state.isDragging, false);
});

test('the selection keeps each cell’s foreground and takes the selection background on dark and light palettes', () => {
  try {
    for (const colours of [DEFAULT_DARK, DEFAULT_LIGHT]) {
      setPalette(buildPalette(...colours));
      const p = palette();
      const row =
        sgrJoin(p.read_bg, p.dim) +
        ' > 读 abc' +
        p.reset +
        p.blue +
        ' : x' +
        p.reset +
        '   ';
      const painted = paintRow(row, 3, 10, p.sel_bg);
      assert.equal(stripAnsi(painted), stripAnsi(row));
      assert.equal(stringWidth(painted), stringWidth(row));
      assert.ok(painted.includes(sgrJoin(p.dim, p.sel_bg)));
      assert.ok(painted.includes(sgrJoin(p.blue, p.sel_bg)));
      assert.ok(!painted.includes(sgrJoin(p.read_bg, p.dim, p.sel_bg)));
      // the read background comes back after the selected cells
      const short = paintRow(row, 3, 5, p.sel_bg);
      assert.ok(
        short.lastIndexOf(p.reset + sgrJoin(p.read_bg, p.dim)) >
          short.indexOf(p.sel_bg.slice(2, -1)),
      );
      const s = createSelectionState();
      s.anchor = { col: 3, row: 0 };
      s.focus = { col: 2, row: 1 };
      const rows = paintSelection([row, row], s, p.sel_bg);
      const grid = new Grid([row, row]);
      assert.equal(getSelectedText(s, grid), '读 abc : x\n >');
      assert.ok(rows.every((item) => stringWidth(item) === stringWidth(row)));
    }
  } finally {
    setPalette(buildPalette(...DEFAULT_DARK));
  }
});

test('a selection copy writes OSC 52, through tmux when its buffer took the text, after a local tool', async () => {
  const plain = fakeRunner();
  const writes: string[] = [];
  const write = (text: string): number => writes.push(text);
  await new Clipboard({
    env: {},
    platform: 'darwin',
    run: plain.run,
    write,
  }).copySelection('héllo 世界');
  assert.deepEqual(
    plain.calls.map((call) => call.command),
    ['pbcopy'],
  );
  assert.equal(plain.calls[0]!.input.toString(), 'héllo 世界');
  const raw = '\x1b]52;c;aMOpbGxvIOS4lueVjA==\x07';
  assert.deepEqual(writes, [raw]);

  const tmux = fakeRunner();
  await new Clipboard({
    env: { TMUX: '/tmp/tmux-1/default,1,0' },
    platform: 'darwin',
    run: tmux.run,
    write,
  }).copySelection('héllo 世界');
  assert.deepEqual(
    tmux.calls.map((call) => [call.command, ...call.args]),
    [['pbcopy'], ['tmux', 'load-buffer', '-w', '-']],
  );
  assert.equal(
    writes.at(-1),
    '\x1bPtmux;\x1b\x1b]52;c;aMOpbGxvIOS4lueVjA==\x07\x1b\\',
  );
  assert.equal(writes.at(-1), tmuxPassthrough(raw));

  // tmux refused the buffer: the plain sequence, for tmux's own set-clipboard
  const refused = fakeRunner({ tmux: 1 });
  await new Clipboard({
    env: { TMUX: 'x', LC_TERMINAL: 'iTerm2' },
    platform: 'darwin',
    run: refused.run,
    write,
  }).copySelection('héllo 世界');
  assert.deepEqual(refused.calls.at(-1)!.args, ['load-buffer', '-']);
  assert.equal(writes.at(-1), raw);

  // over ssh the local clipboard is the wrong machine's: no local tool
  const ssh = fakeRunner();
  await new Clipboard({
    env: { SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 22', TMUX: 'x' },
    platform: 'darwin',
    run: ssh.run,
    write,
  }).copySelection('héllo 世界');
  assert.deepEqual(
    ssh.calls.map((call) => call.command),
    ['tmux'],
  );
  assert.equal(writes.at(-1), tmuxPassthrough(raw));
  assert.equal(
    await new Clipboard({ env: {}, run: ssh.run, write }).copySelection(''),
    '',
  );
  assert.equal(writes.length, 4);
});

test('on Linux a selection copy tries wl-copy, xclip, then xsel, and keeps to the first that starts', async () => {
  const first = fakeRunner({ 'wl-copy': null, xclip: 1 });
  const clipboard = new Clipboard({
    env: {},
    platform: 'linux',
    run: first.run,
    write: () => {},
  });
  await clipboard.copySelection('a');
  await clipboard.pending;
  await clipboard.copySelection('b');
  await clipboard.pending;
  assert.deepEqual(
    first.calls.map((call) => [call.command, ...call.args]),
    [
      ['wl-copy'],
      ['xclip', '-selection', 'clipboard'],
      ['xclip', '-selection', 'clipboard'],
    ],
  );
  const none = fakeRunner({ 'wl-copy': null, xclip: null, xsel: null });
  const bare = new Clipboard({
    env: {},
    platform: 'linux',
    run: none.run,
    write: () => {},
  });
  await bare.copySelection('a');
  await bare.pending;
  await bare.copySelection('b');
  await bare.pending;
  assert.deepEqual(
    none.calls.map((call) => [call.command, ...call.args]),
    [
      ['wl-copy'],
      ['xclip', '-selection', 'clipboard'],
      ['xsel', '--clipboard', '--input'],
    ],
  );
});

test('/copy uses pbcopy, wl-copy, then xclip, and clip on Windows with UTF-16 text', async () => {
  const runner = fakeRunner({ pbcopy: null, 'wl-copy': 1 });
  assert.equal(
    await new Clipboard({
      env: {},
      platform: 'linux',
      run: runner.run,
    }).copyNative('text'),
    true,
  );
  assert.deepEqual(
    runner.calls.map((call) => [call.command, ...call.args]),
    [['pbcopy'], ['wl-copy'], ['xclip', '-selection', 'clipboard']],
  );
  const none = fakeRunner({ pbcopy: null, 'wl-copy': null, xclip: null });
  assert.equal(
    await new Clipboard({
      env: {},
      platform: 'darwin',
      run: none.run,
    }).copyNative('text'),
    false,
  );
  const windows = fakeRunner();
  assert.equal(
    await new Clipboard({
      env: {},
      platform: 'win32',
      run: windows.run,
    }).copyNative('é\n世😀'),
    true,
  );
  assert.equal(windows.calls[0]!.command, 'clip');
  assert.deepEqual(
    windows.calls[0]!.input,
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('é\r\n世😀', 'utf16le'),
    ]),
  );
});

test('ctrl+x copies the last answer with a local tool, or writes it to a file when there is none', async (t) => {
  const s = await session(t, ['  the answer  ']);
  s.feed('\x18');
  await settle();
  assert.deepEqual(
    s.calls.map((call) => [call.command, call.input.toString()]),
    [['pbcopy', 'the answer']],
  );
  assert.deepEqual(s.writes, [], 'no OSC 52 for /copy, as in 0.5.0');
  assert.equal(s.app.state.flash, 'Copied 10 chars');

  const none = fakeRunner({ pbcopy: null, 'wl-copy': null, xclip: null });
  s.ui.clipboard = new Clipboard({
    env: {},
    platform: 'darwin',
    run: none.run,
  });
  s.feed('\x18');
  await settle();
  const path = join(s.root, 'exports', 'last-copy.txt');
  assert.equal(readFileSync(path, 'utf8'), 'the answer\n');
  assert.equal(s.app.state.notices.at(-1), `No clipboard tool · wrote ${path}`);

  const empty = await session(t);
  empty.feed('\x18');
  await settle();
  assert.equal(empty.app.state.flash, 'No assistant message to copy');
  assert.ok(!existsSync(join(empty.root, 'exports')));
});
