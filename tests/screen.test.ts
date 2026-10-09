import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ScreenRenderer } from '../src/ink/screen.js';

test('a changed row is erased before it is written, so a full-width row keeps its last cell', () => {
  const writes: string[] = [];
  const screen = new ScreenRenderer((text) => writes.push(text));
  // A row as wide as the screen: after its last character the cursor sits on the last cell
  // with the wrap pending, and an EL there would erase that cell (the input box's right
  // border lost its ╮ │ ╯ that way).
  const row = 'x'.repeat(160);
  screen.render([row]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0], `\x1b[1;1H\x1b[K${row}`);
});

test('only changed rows are painted, and a row that went away is erased', () => {
  const writes: string[] = [];
  const screen = new ScreenRenderer((text) => writes.push(text));
  screen.render(['one', 'two']);
  screen.render(['one', 'two']);
  assert.equal(writes.length, 1);
  screen.render(['one']);
  assert.equal(writes.length, 2);
  assert.equal(writes[1], '\x1b[2;1H\x1b[K');
});
