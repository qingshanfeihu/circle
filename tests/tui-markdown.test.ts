import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  markdownRows,
  terminalText,
} from '../src/ink/components/markdown_renderer.js';
import { stripAnsi, stringWidth } from '../src/ink/string_width.js';
import {
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  buildPalette,
  setPalette,
} from '../src/ink/theme.js';
import { InputHistory } from '../src/tui/input_history.js';
import {
  TranscriptFind,
  highlightMatches,
} from '../src/tui/transcript_find.js';
import { scratch } from './helpers.js';
const plain = (text: string, width = 80): string =>
  markdownRows(text, width).map(stripAnsi).join('\n');
test('CommonMark emphasis, inline code, links and literal underscore URLs remain distinct in nested formatting', () => {
  const rows = markdownRows(
    '**outer *inner* tail** and ~~old~~; `a_b *literal*` https://example.com/a_b_c',
  );
  const text = rows.map(stripAnsi).join('\n');
  assert.match(text, /outer inner tail and old/);
  assert.match(text, /a_b \*literal\*/);
  assert.match(text, /https:\/\/example.com\/a_b_c/);
  assert.match(rows.join(''), /\x1b\[[0-9;]*1[0-9;]*m/);
  assert.match(rows.join(''), /\x1b\[[0-9;]*3[0-9;]*m/);
  assert.match(rows.join(''), /\x1b\[[0-9;]*9[0-9;]*m/);
  assert.match(
    plain('[Docs](https://example.com/docs)'),
    /Docs \(https:\/\/example.com\/docs\)/,
  );
});
test('streaming fences and indented code retain literal delimiters and use only shared palette colors', () => {
  for (const theme of [DEFAULT_DARK, DEFAULT_LIGHT]) {
    const p = buildPalette(...theme);
    setPalette(p);
    for (const fence of ['```ts', '~~~python', '````markdown']) {
      const rows = markdownRows(fence + '\n**literal** _code_ | data', 32);
      assert.match(
        rows.map(stripAnsi).join('\n'),
        /\*\*literal\*\* _code_ \| data/,
      );
      assert.ok(
        rows.every((row) => row.includes(p.panel_bg) && row.includes(p.text)),
      );
      assert.ok(rows.every((row) => stringWidth(row) <= 32));
    }
    assert.match(plain('    **indented**'), /\*\*indented\*\*/);
    assert.match(plain('```js\na\n```\n**after**'), /after/);
  }
});
test('GFM task lists, nested lists, quotations and tables render as terminal structures at narrow and wide widths', () => {
  const text =
    '# Heading\n\n- [x] done\n- [ ] pending\n  - nested\n\n> quoted\n\n| Name | Value |\n| :--- | ---: |\n| 中文 | 12 |\n| | 23 |';
  const rendered = plain(text, 50);
  assert.match(rendered, /Heading/);
  assert.match(rendered, /☑ done/);
  assert.match(rendered, /☐ pending/);
  assert.match(rendered, /• nested/);
  assert.match(rendered, /│ quoted/);
  assert.match(rendered, /┌/);
  assert.match(rendered, /23/);
  for (const width of [12, 24, 50])
    assert.ok(
      markdownRows(text, width).every((row) => stringWidth(row) <= width),
    );
});
test('long words and Chinese/emoji content wrap within terminal cells while escaped delimiters remain literal', () => {
  for (const width of [8, 20, 60]) {
    const rows = markdownRows(
      'English words stay together. 中文说明 👩‍💻 '.repeat(8) + 'a'.repeat(130),
      width,
    );
    assert.ok(rows.every((row) => stringWidth(row) <= width));
  }
  assert.equal(plain('\\*literal\\* &amp; text'), '*literal* & text');
});
test('raw and entity-encoded terminal instructions never reach Markdown output', () => {
  const attack =
    '\x1b]52;c;c2VjcmV0\x07\x1b[2Jhello &#27;[2J <script>literal</script>';
  const rows = markdownRows(attack);
  assert.ok(!rows.join('').includes('\x1b]52;'));
  assert.ok(!rows.join('').includes('\x1b[2J'));
  assert.match(rows.map(stripAnsi).join('\n'), /hello/);
  assert.equal(terminalText('x\x00\x08y'), 'xy');
});
test('table cells protect pipes only inside matched code spans and keep empty cells and single-column separators', () => {
  assert.match(
    plain('| A | B |\n| - | - |\n| `x|y` | value |\n| | tail |'),
    /x\|y/,
  );
  assert.match(plain('| `a|b` |\n| - |\n| value |'), /a\|b/);
  assert.match(plain('| A | B |\n| - | - |\n| `open | next |'), /next/);
  assert.equal(plain('prose `x|y`'), 'prose x|y');
});
test('history reads old line files, preserves multiline messages on restart and suppresses consecutive duplicates', (t) => {
  const root = scratch(t);
  const path = join(root, 'history');
  writeFileSync(path, 'first\nsecond\n');
  const history = new InputHistory(path, 3);
  assert.deepEqual(history.items, ['first', 'second']);
  history.add('line one\nline two');
  history.add('line one\nline two');
  assert.deepEqual(new InputHistory(path).items, [
    'first',
    'second',
    'line one\nline two',
  ]);
  assert.equal(history.up('unsent draft'), 'line one\nline two');
  assert.equal(history.up('ignored'), 'second');
  assert.equal(history.down(), 'line one\nline two');
  assert.equal(history.down(), 'unsent draft');
  history.add('last');
  assert.deepEqual(history.items, ['second', 'line one\nline two', 'last']);
  assert.match(readFileSync(path, 'utf8'), /circle-history/);
});
test('reverse history search cycles matches, supports custom query updates and restores the unsent draft on cancellation', (t) => {
  const history = new InputHistory(join(scratch(t), 'history'));
  history.add('read older');
  history.add('write file');
  history.add('read latest');
  assert.equal(history.beginSearch('read'), 'read latest');
  assert.equal(history.next(), 'read older');
  assert.equal(history.next(), 'read latest');
  assert.equal(history.update('missing'), undefined);
  assert.equal(history.endSearch(true), 'read');
  assert.equal(history.query, undefined);
});
test('transcript find targets visible rows and wraps forward/backward without changing transcript content', () => {
  const rows = ['one', '\x1b[31mMATCH\x1b[0m first', 'other', 'match second'];
  const find = new TranscriptFind();
  find.query = 'match';
  find.refresh(rows);
  assert.deepEqual(find.matches, [1, 3]);
  assert.equal(find.row, 1);
  find.next();
  assert.equal(find.row, 3);
  find.next();
  assert.equal(find.row, 1);
  find.next(true);
  assert.equal(find.row, 3);
  const highlighted = highlightMatches(rows[1]!, find.query);
  assert.equal(stripAnsi(highlighted), stripAnsi(rows[1]!));
  assert.match(highlighted, /\x1b\[7m/);
  assert.equal(rows[1], '\x1b[31mMATCH\x1b[0m first');
});
test('find highlighting matches normalized whitespace and literal regex punctuation and survives live redraws', () => {
  const rows = ['first', 'foo   bar (literal)', 'last foo bar'];
  const find = new TranscriptFind();
  find.query = 'foo bar';
  find.refresh(rows);
  find.next();
  assert.equal(find.row, 2);
  find.updateRows([...rows, 'added']);
  assert.equal(find.row, 2);
  const highlighted = highlightMatches(rows[1]!, 'foo bar');
  assert.match(highlighted, /\x1b\[7mfoo   bar\x1b\[27m/);
  assert.equal(stripAnsi(highlighted), rows[1]);
  assert.match(highlightMatches('(literal)', '(literal)'), /\x1b\[7m/);
});
