import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScreenRenderer } from '../src/ink/screen.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { renderScreen, type ScreenState } from '../src/tui/render.js';
import { emptyUsage } from '../src/types.js';

function screenState(draft: string, draftCursor: number): ScreenState {
  return {
    messages: [],
    notices: [],
    welcome: [],
    draft,
    draftCursor,
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

test('a changed row is erased before it is written, so a full-width row keeps its last cell', () => {
  const writes: string[] = [];
  const screen = new ScreenRenderer((text) => writes.push(text));
  // A row as wide as the screen: after its last character the cursor sits on the last cell
  // with the wrap pending, and an EL there would erase that cell (the input box's right
  // border lost its ╮ │ ╯ that way).
  const row = 'x'.repeat(160);
  screen.render([row], { row: 1, col: 5 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0], `\x1b[1;1H\x1b[K${row}\x1b[1;5H\x1b[?25h`);
});

test('only changed rows are painted, and a row that went away is erased', () => {
  const writes: string[] = [];
  const screen = new ScreenRenderer((text) => writes.push(text));
  screen.render(['one', 'two']);
  screen.render(['one', 'two']);
  assert.equal(writes.length, 1);
  screen.render(['one']);
  assert.equal(writes.length, 2);
  assert.equal(writes[1], '\x1b[2;1H\x1b[K\x1b[?25l');
});

test('the real cursor parks on the given cell and hides when no cell is given, re-parked after every paint', () => {
  const writes: string[] = [];
  const screen = new ScreenRenderer((text) => writes.push(text));
  screen.render(['a'], { row: 1, col: 5 });
  assert.ok(writes[0]!.endsWith('\x1b[1;5H\x1b[?25h'));
  // Nothing new to paint and the same cell: nothing is written.
  screen.render(['a'], { row: 1, col: 5 });
  assert.equal(writes.length, 1);
  // The cell moved: re-parked without repainting the rows.
  screen.render(['a'], { row: 1, col: 7 });
  assert.equal(writes.length, 2);
  assert.equal(writes[1], '\x1b[1;7H\x1b[?25h');
  // A paint moves the cursor, so the park is re-issued even when the cell is unchanged.
  screen.render(['b'], { row: 1, col: 7 });
  assert.ok(writes[2]!.endsWith('\x1b[1;7H\x1b[?25h'));
  // No composer on screen (a dialog owns it): the cursor hides.
  screen.render(['b'], undefined);
  assert.equal(writes[3], '\x1b[?25l');
});

test('the parked cell is the composer cursor: the ▏ cell of its draft line', () => {
  const cursor: { value?: { row: number; col: number } } = {};
  const rows = renderScreen(screenState('hello', 2), 40, 24, cursor);
  assert.ok(cursor.value, 'the composer is on screen');
  const line = stripAnsi(rows[cursor.value!.row - 1]!);
  assert.ok(line.includes('he▏llo'), line);
  assert.equal(cursor.value!.col, line.indexOf('▏') + 1);
});

test('a dialog owns the screen: no cell is parked', () => {
  const cursor: { value?: { row: number; col: number } } = {};
  const state = screenState('hello', 2);
  state.dialog = {
    title: 'question',
    body: 'pick one',
    options: ['yes', 'no'],
    focus: 0,
  };
  renderScreen(state, 40, 24, cursor);
  assert.equal(cursor.value, undefined);
});
