import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { InputParser } from '../src/ink/parse_keypress.js';
import { stripAnsi, stringWidth } from '../src/ink/string_width.js';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  setPalette,
} from '../src/ink/theme.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { cursorRow, visualLines } from '../src/tui/composer.js';
import { renderScreen } from '../src/tui/render.js';
import { SessionApp } from '../src/tui/session_app.js';
import type { ModelResponse } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

function session(
  t: Parameters<typeof scratch>[0],
  replies: Partial<ModelResponse>[] = [],
) {
  const root = scratch(t);
  const settings = defaultSettings();
  const model = new ScriptedModel(replies);
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
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  const parser = new InputParser();
  /** Bytes as a terminal sends them, through the real parser and key handling. */
  const feed = (bytes: string): void => {
    for (const event of parser.feed(bytes)) ui.handle(event);
  };
  const key = (name: string, char = ''): void =>
    ui.handle({ type: 'key', key: name, char });
  const type = (text: string): void => {
    for (const char of text) key(char, char);
  };
  const box = (): string[] => {
    const rows = rendered.map(stripAnsi);
    const top = rows.findLastIndex((row) => row.startsWith('╭'));
    const bottom = rows.findLastIndex((row) => row.startsWith('╰'));
    return rows.slice(top + 1, bottom).map((row) => row.slice(1, -1));
  };
  return {
    root,
    app,
    ui,
    runtime,
    model,
    feed,
    key,
    type,
    box,
    screen: () => rendered.map(stripAnsi),
    // Read through a call: an assert on the field must not narrow the next read
    list: () => app.state.completion,
    picker: () => app.state.picker,
  };
}
function key(ui: any, name: string, char = ''): void {
  ui.handle({ type: 'key', key: name, char });
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await delay(10);
  assert.ok(check());
}
const answer = (content: string): Partial<ModelResponse> => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
});

test('word keys move and delete by word, ctrl+k and ctrl+u clear, and ctrl+y puts back the last cut', (t) => {
  const { app, feed, type } = session(t);
  type('one two three');
  feed('\x1bb'); // alt+b
  assert.equal(app.state.draftCursor, 8);
  feed('\x17'); // ctrl+w
  assert.equal(app.state.draft, 'one three');
  assert.equal(app.state.draftCursor, 4);
  feed('\x19'); // ctrl+y
  assert.equal(app.state.draft, 'one two three');
  assert.equal(app.state.draftCursor, 8);
  feed('\x1b[1;3D'); // alt+left
  assert.equal(app.state.draftCursor, 4);
  feed('\x1b[1;5D'); // ctrl+left
  assert.equal(app.state.draftCursor, 0);
  feed('\x1bf'); // alt+f
  assert.equal(app.state.draftCursor, 3);
  feed('\x1b[1;5C'); // ctrl+right
  assert.equal(app.state.draftCursor, 7);
  feed('\x1b[1;3C'); // alt+right
  assert.equal(app.state.draftCursor, 13);
  feed('\x1b\x7f'); // alt+backspace
  assert.equal(app.state.draft, 'one two ');
  feed('\x01\x1bd'); // ctrl+a, alt+d
  assert.equal(app.state.draft, ' two ');
  assert.equal(app.state.draftCursor, 0);
  feed('\x1b[1;3C\x0b'); // alt+right, ctrl+k
  assert.equal(app.state.draft, ' two');
  feed('\x01\x19'); // ctrl+a, ctrl+y: the last cut was the trailing space
  assert.equal(app.state.draft, '  two');
  // A line break separates words as a space does
  feed('\x05\x0aline\x17\x17'); // ctrl+e, ctrl+j, "line", ctrl+w twice
  assert.equal(app.state.draft, '  ');
  feed('\x15'); // ctrl+u
  assert.equal(app.state.draft, '');
  assert.equal(app.state.draftCursor, 0);
});

test('backslash then enter breaks the line and enter then sends the draft with the break', async (t) => {
  const { app, model, feed, type, runtime } = session(t, [answer('ok')]);
  type('first\\');
  feed('\r');
  assert.equal(app.state.draft, 'first\n');
  assert.equal(model.requests.length, 0);
  type('second');
  feed('\r');
  await until(() => model.requests.length === 1 && !runtime.busy);
  assert.equal(model.requests[0]!.messages.at(-1)!.content, 'first\nsecond');
  assert.equal(app.state.draft, '');
});

test('up and down move between the rows of a multiline draft and browse the history only from the first or last row', async (t) => {
  const { app, key, type, feed, runtime, model } = session(t, [answer('ok')]);
  type('older');
  key('enter', '\r');
  await until(() => model.requests.length === 1 && !runtime.busy);
  type('abcdef');
  feed('\x0a'); // ctrl+j
  type('xy');
  feed('\x0a');
  type('last line');
  assert.equal(app.state.draft, 'abcdef\nxy\nlast line');
  key('left');
  key('left'); // column 7 of the last row
  key('up'); // "xy" is shorter: its end
  assert.equal(app.state.draftCursor, 9);
  key('up'); // back to column 2 of the first row
  assert.equal(app.state.draftCursor, 2);
  key('up'); // the first row: the history
  assert.equal(app.state.draft, 'older');
  key('down'); // browsing: ↓ goes back to the draft, not down a row
  assert.equal(app.state.draft, 'abcdef\nxy\nlast line');
  key('ctrl+a');
  key('down');
  assert.equal(app.state.draftCursor, 7);
  key('down');
  key('down'); // the last row going down: nothing to browse, the draft stays
  assert.equal(app.state.draft, 'abcdef\nxy\nlast line');
  // A long line wraps at spaces, and ↑ ↓ move between its rows too
  key('ctrl+u');
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  type(words);
  const before = app.state.draftCursor;
  key('up');
  assert.ok(app.state.draftCursor < before);
  assert.equal(app.state.draft, words);
});

test('the box wraps long lines at spaces and follows the cursor instead of always showing the last rows', (t) => {
  const { app, ui, box, key, type } = session(t);
  const words = Array.from({ length: 40 }, (_, i) => `w${i}xyz`).join(' ');
  type(words);
  ui.repaint();
  const wrapped = box();
  assert.ok(wrapped.length > 1);
  const text = wrapped.map((row) => row.slice(3).replace('▏', '').trimEnd());
  for (const row of text)
    assert.match(row, /^(w\d+xyz)( w\d+xyz)*$/, `cut inside a word: ${row}`);
  assert.equal(text.join(' '), words);
  for (const row of ui.frameRows) assert.equal(stringWidth(row), 80);
  key('ctrl+u');
  for (let line = 1; line <= 12; line++) {
    type(`line ${line}`);
    if (line < 12) key('ctrl+j');
  }
  ui.repaint();
  // 24 rows: at most 7 in the box (30%), the last ones while the cursor is at the end
  let rows = box();
  assert.equal(rows.length, 7);
  assert.equal(rows.at(-1), '   line 12▏'.padEnd(78));
  assert.ok(rows[0]!.startsWith('   line 6'));
  key('ctrl+a');
  ui.repaint();
  rows = box();
  assert.equal(rows[0], ' › ▏line 1'.padEnd(78));
  assert.ok(rows.at(-1)!.startsWith('   line 7'));
  // Going down only scrolls once the cursor leaves the view
  for (let i = 0; i < 7; i++) key('down');
  ui.repaint();
  rows = box();
  assert.ok(rows[0]!.startsWith('   line 2'));
  assert.ok(rows.at(-1)!.startsWith('   ▏line 8'));
  assert.equal(app.state.draftTop, 1);
});

test('rows break after the last space that fits and the cursor at a wrap shows on the next row', () => {
  const chars = Array.from('alpha beta gamma');
  const text = (rows: [number, number][]): string[] =>
    rows.map(([start, end]) => chars.slice(start, end).join(''));
  assert.deepEqual(text(visualLines(chars, 11)), ['alpha beta ', 'gamma']);
  assert.deepEqual(text(visualLines(chars, 10)), ['alpha beta', 'gamma']);
  assert.deepEqual(text(visualLines(chars, 8)), ['alpha ', 'beta ', 'gamma']);
  // The space at the break starts no row; a word longer than the row is cut
  const long = Array.from('abcdefghij klm');
  assert.deepEqual(
    visualLines(long, 4).map(([s, e]) => long.slice(s, e).join('')),
    ['abcd', 'efgh', 'ij ', 'klm'],
  );
  const cut = visualLines(Array.from('abcdefgh'), 4);
  assert.equal(cursorRow(cut, 4), 1);
  const broken = visualLines(Array.from('ab\ncd'), 10);
  assert.equal(cursorRow(broken, 2), 0);
  assert.equal(cursorRow(broken, 3), 1);
  // Chinese takes two columns
  const wide = Array.from('中文中文');
  assert.deepEqual(visualLines(wide, 5), [
    [0, 2],
    [2, 4],
  ]);
});

test('a long paste becomes a placeholder: the model reads the paste, the transcript and history keep the placeholder, and /fork brings both back', async (t) => {
  const { app, ui, model, feed, type, runtime, screen, picker } = session(t, [
    answer('first'),
    answer('second'),
    answer('again'),
  ]);
  const pasted = 'line a\r\nline b\nline c\nline d';
  feed('\x1b[200~' + pasted + '\x1b[201~');
  assert.equal(app.state.draft, '[Pasted text #1 +3 lines]');
  type(' explain');
  feed('\x1b[200~short\npaste\x1b[201~');
  assert.equal(
    app.state.draft,
    '[Pasted text #1 +3 lines] explainshort\npaste',
  );
  key(ui, 'ctrl+u');
  feed('\x1b[200~' + 'x'.repeat(801) + '\x1b[201~');
  assert.equal(app.state.draft, '[Pasted text #2]');
  key(ui, 'ctrl+u');
  feed('\x1b[200~' + pasted + '\x1b[201~');
  type(' explain');
  feed('\r');
  await until(() => model.requests.length === 1 && !runtime.busy);
  assert.equal(
    model.requests[0]!.messages.at(-1)!.content,
    'line a\nline b\nline c\nline d explain',
  );
  const stored = runtime.harness.messages.find(
    (message) => message.role === 'user',
  )!;
  assert.equal(stored.display, '[Pasted text #3 +3 lines] explain');
  assert.deepEqual(stored.pastes, { '3': 'line a\nline b\nline c\nline d' });
  ui.repaint();
  assert.ok(
    screen().some((row) => row.includes('› [Pasted text #3 +3 lines] explain')),
  );
  assert.ok(!screen().some((row) => row.includes('line b')));
  assert.equal(
    (ui.history.items as string[]).at(-1),
    '[Pasted text #3 +3 lines] explain',
  );
  // Another message first, so the paste is known only from the stored message
  type('thanks');
  feed('\r');
  await until(() => model.requests.length === 2 && !runtime.busy);
  // /fork puts your message back with its paste, and sending it again sends the paste
  await app.command('fork', '');
  assert.match(picker()!.items[0]!.label, /Pasted text #3/);
  picker()!.handle('enter', '');
  await until(() => app.state.draft === '[Pasted text #3 +3 lines] explain');
  feed('\r');
  await until(() => model.requests.length === 3 && !runtime.busy);
  assert.equal(
    model.requests[2]!.messages.at(-1)!.content,
    'line a\nline b\nline c\nline d explain',
  );
});

test('typing / or @ lists completions above the box: arrows move, tab takes, enter runs a command, esc hides it until the text changes', async (t) => {
  const { app, ui, root, model, feed, type, screen, list } = session(t);
  type('/hotk');
  assert.deepEqual(
    list()?.items.map((item) => item.value),
    ['/hotkeys'],
  );
  ui.repaint();
  const rows = screen();
  const title = rows.findIndex((row) => row.trim() === 'commands');
  assert.ok(title >= 0);
  assert.match(rows[title + 1]!, /^ {3}\/hotkeys {5}Show keyboard shortcuts/);
  assert.ok(rows[title + 2]!.startsWith('╭'));
  // esc closes the list and keeps the text; it opens again when the text changes
  key(ui, 'escape');
  assert.equal(list(), undefined);
  assert.equal(app.state.draft, '/hotk');
  type('e');
  assert.equal(list()?.items[0]!.value, '/hotkeys');
  feed('\r');
  assert.equal(app.state.draft, '');
  assert.match(app.state.notices.at(-1)!, /model\.select/);
  assert.equal(model.requests.length, 0);
  // ↑ ↓ wrap around the list; tab takes the marked entry
  type('/e');
  const names = list()!.items.map((item) => item.value);
  assert.ok(names.includes('/editor') && names.includes('/effort'));
  key(ui, 'up');
  assert.equal(list()!.focus, names.length - 1);
  key(ui, 'down');
  key(ui, 'down');
  assert.equal(list()!.focus, 1);
  key(ui, 'tab', '\t');
  assert.equal(app.state.draft, names[1] + ' ');
  assert.equal(list(), undefined);
  // Files: a folder lists what is in it, enter takes a file without sending
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'alpha.ts'), '');
  writeFileSync(join(root, 'src', 'beta.ts'), '');
  key(ui, 'ctrl+u');
  type('see @sr');
  assert.deepEqual(
    list()?.items.map((item) => item.label),
    ['src/'],
  );
  key(ui, 'tab', '\t');
  assert.equal(app.state.draft, 'see @src/');
  assert.deepEqual(
    list()?.items.map((item) => item.label),
    ['src/alpha.ts', 'src/beta.ts'],
  );
  ui.repaint();
  assert.ok(screen().some((row) => row.trim() === 'files'));
  key(ui, 'down');
  feed('\r');
  assert.equal(app.state.draft, 'see @src/beta.ts ');
  assert.equal(list(), undefined);
  assert.equal(model.requests.length, 0);
  // With the list closed, tab completes as far as the matches agree
  key(ui, 'ctrl+u');
  type('@src/a');
  key(ui, 'escape');
  key(ui, 'tab', '\t');
  assert.equal(app.state.draft, '@src/alpha.ts ');
});

test('the completion list draws on the panel at full width on dark and light palettes', (t) => {
  const { app, ui, type } = session(t);
  type('/');
  for (const palette of [
    buildPalette(...DEFAULT_DARK),
    buildPalette(...DEFAULT_LIGHT),
  ]) {
    setPalette(palette);
    ui.repaint();
    const rows: string[] = ui.frameRows;
    const title = rows.findIndex((row) =>
      stripAnsi(row).startsWith(' commands'),
    );
    assert.ok(title >= 0);
    assert.match(stripAnsi(rows[title]!), /^ commands · 1\/\d+/);
    const background = (sgr: string): string => sgr.slice(2, -1);
    for (const row of rows.slice(title, title + 7)) {
      assert.equal(stringWidth(row), 80);
      assert.ok(
        row.includes(background(palette.panel_bg)) !==
          row.includes(background(palette.sel_bg)),
      );
    }
    assert.ok(rows[title + 1]!.includes(background(palette.sel_bg)));
    // A narrow screen cuts the labels, never past the width
    for (const width of [24, 40]) {
      const narrow = renderScreen({ ...app.state, welcome: [] }, width, 24);
      const at = narrow.findIndex((row) =>
        stripAnsi(row).startsWith(' commands'),
      );
      assert.ok(at >= 0);
      for (const row of narrow.slice(at))
        assert.equal(stringWidth(row), width, stripAnsi(row));
    }
  }
  setPalette(buildPalette(...DEFAULT_DARK));
});

test('an empty box shows the shortcuts on ? at once, and its scroll keys and arrows scroll the conversation', async (t) => {
  const { app, ui, type } = session(t);
  key(ui, '?', '?');
  assert.equal(app.state.draft, '');
  assert.match(app.state.notices.at(-1)!, /model\.select/);
  type('why?');
  assert.equal(app.state.draft, 'why?');
  key(ui, 'ctrl+u');
  app.state.notices.length = 0;
  app.state.notices.push(
    Array.from({ length: 80 }, (_, i) => `note ${i}`).join('\n'),
  );
  ui.repaint();
  const top = app.state.view!.maxScroll;
  assert.ok(top > 20);
  const shown = (note: string): boolean =>
    ui.frameRows.some((row: string) => stripAnsi(row).trim() === note);
  assert.ok(shown('note 79') && !shown('note 0'));
  key(ui, 'home');
  assert.equal(app.state.scroll, top);
  assert.ok(shown('note 0') && !shown('note 79'));
  key(ui, 'end');
  assert.equal(app.state.scroll, 0);
  assert.ok(shown('note 79'));
  key(ui, 'pageup');
  const half = Math.floor(app.state.view!.rows / 2);
  assert.equal(app.state.scroll, half);
  key(ui, 'pagedown');
  assert.equal(app.state.scroll, 0);
  // No history: ↑ ↓ scroll by 3 rows
  key(ui, 'up');
  assert.equal(app.state.scroll, 3);
  key(ui, 'down');
  assert.equal(app.state.scroll, 0);
  // With text, home and end move the cursor and the conversation stays
  type('abc');
  key(ui, 'home');
  assert.equal(app.state.draftCursor, 0);
  key(ui, 'pageup');
  assert.equal(app.state.scroll, 0);
  key(ui, 'end');
  assert.equal(app.state.draftCursor, 3);
});

test('esc clears the box, only esc esc on an empty box opens the tree, and ctrl+c clears it but keeps it in the history', (t) => {
  const { app, ui, type, picker } = session(t);
  type('draft one');
  key(ui, 'escape');
  assert.equal(app.state.draft, '');
  key(ui, 'escape'); // the first esc on an empty box: no tree yet
  assert.equal(picker(), undefined);
  key(ui, 'escape');
  assert.equal(picker()?.title, 'tree');
  key(ui, 'escape');
  assert.equal(picker(), undefined);
  type('draft two');
  key(ui, 'ctrl+c');
  assert.equal(app.state.draft, '');
  assert.deepEqual(ui.history.items, ['draft two']);
  key(ui, 'up');
  assert.equal(app.state.draft, 'draft two');
});
