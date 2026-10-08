import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputParser } from '../src/ink/parse_keypress.js';
import {
  buildPalette,
  contrastRatio,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  setPalette,
  hexToRgb,
  rgbToHex,
} from '../src/ink/theme.js';
import {
  stripAnsi,
  stringWidth,
  wrap,
  truncate,
} from '../src/ink/string_width.js';
import { renderScreen, type ScreenState } from '../src/tui/render.js';
import { emptyUsage } from '../src/types.js';
import { parseCli, UsageError } from '../src/cli.js';
import { substituteArguments } from '../src/commands.js';
import { fromJsonl, toJsonl, toHtml } from '../src/session_export.js';
function state(): ScreenState {
  return {
    messages: [],
    notices: [],
    welcome: [],
    draft: '中文 draft',
    draftCursor: 3,
    model: 'model',
    workspace: '/project',
    version: 'test',
    busy: false,
    waiting: false,
    planMode: false,
    autoMode: false,
    todos: [],
    showThinking: false,
    showTools: false,
    streaming: '',
    thinking: '',
    usage: emptyUsage(),
    flash: '',
    started: 0,
    scroll: 0,
    hiddenTurns: 0,
  };
}
test('input parser buffers fragmented bracketed paste and terminal reports never type letters', () => {
  const parser = new InputParser();
  assert.deepEqual(parser.feed('\x1b[200~hello\n\x1b[20'), []);
  assert.deepEqual(parser.feed('1~'), [{ type: 'paste', text: 'hello\n' }]);
  assert.deepEqual(parser.feed('\x1b[?2031;2$y'), []);
  assert.deepEqual(parser.feed('\x1b[?997;2n'), [
    { type: 'scheme', dark: false },
  ]);
  assert.deepEqual(parser.feed('\x1b]11;rgb:ffff/ffff/ffff\x1b\\'), [
    { type: 'color', slot: 11, color: '#ffffff' },
  ]);
  assert.deepEqual(parser.feed('\x1b[A\x1b\r'), [
    { type: 'key', key: 'up', char: '' },
    { type: 'key', key: 'shift+enter', char: '\r' },
  ]);
});
test('Chinese and graphemes occupy terminal cells, and truncation preserves filename tails', () => {
  assert.equal(stringWidth('中文'), 4);
  assert.deepEqual(wrap('中文abc', 4), ['中文', 'abc']);
  assert.equal(stringWidth(truncate('文件/file.ts', 7, true)), 7);
});
test('palette contrast is readable across panel and all type surfaces in dark and light themes', () => {
  for (const defaults of [DEFAULT_DARK, DEFAULT_LIGHT]) {
    const p = buildPalette(...defaults);
    const sgrToHex = (sgr: string) =>
      rgbToHex(
        sgr.match(/\d+/g)!.slice(-3).map(Number) as [number, number, number],
      );
    const dim = sgrToHex(p.dim);
    const faint = sgrToHex(p.faint);
    for (const surface of [
      p.bg_hex,
      sgrToHex(p.panel_bg),
      p.read_bg_hex,
      p.write_bg_hex,
      p.think_bg_hex,
      p.agent_bg_hex,
    ]) {
      assert.ok(contrastRatio(dim, surface) >= 4.5);
      assert.ok(contrastRatio(faint, surface) >= 3);
    }
  }
  assert.deepEqual(hexToRgb('#fff'), [255, 255, 255]);
});
test('screen rows respect width, short dialogs keep options, and read-only wins over auto', () => {
  for (const palette of [
    buildPalette(...DEFAULT_DARK),
    buildPalette(...DEFAULT_LIGHT),
  ]) {
    setPalette(palette);
    for (const width of [24, 60, 100]) {
      const screen = state();
      screen.planMode = true;
      screen.autoMode = true;
      const rows = renderScreen(screen, width, 24);
      assert.equal(rows.length, 24);
      for (const row of rows)
        assert.equal(stringWidth(row), width, stripAnsi(row));
      assert.ok(rows.some((row) => stripAnsi(row).includes('read-only')));
      assert.ok(!rows.some((row) => stripAnsi(row).includes(' auto ')));
    }
  }
  const screen = state();
  screen.dialog = {
    title: 'approval',
    body: 'long\n'.repeat(100),
    options: ['allow this call', 'reject'],
    focus: 1,
  };
  const rendered = renderScreen(screen, 60, 12).map(stripAnsi).join('\n');
  assert.match(rendered, /reject/);
  assert.match(rendered, /\+\d+ lines/);
});
test('background job rows stay below the input and use the shared terminal palette without leaking command escapes', () => {
  const screen = state();
  screen.jobs = [
    {
      id: 'j1',
      kind: 'shell',
      title: '\x1b]52;c;c2VjcmV0\x07npm test',
      sessionId: 'session',
      status: 'running',
      reason: '',
      started: Date.now(),
      outputPath: '/missing-output',
      virtualPath: '/background_jobs/test/job.log',
    },
  ];
  for (const height of [8, 24]) {
    const rows = renderScreen(screen, 60, height);
    assert.equal(rows.length, height);
    const plain = rows.map(stripAnsi);
    const jobHeader = plain.findIndex((row) => row.includes('Jobs · 1'));
    assert.ok(jobHeader > plain.findIndex((row) => row.includes('╰')));
    assert.ok(rows.every((row) => !row.includes('\x1b]52;')));
    assert.ok(rows.every((row) => stringWidth(row) === 60));
  }
});
test('CLI preserves print flag placement and rejects conflicting saved-session options', () => {
  const options = parseCli(
    ['-p', '-c', 'hello', '.', '--tools', 'read,grep'],
    process.cwd(),
  );
  assert.equal(options.print, true);
  assert.equal(options.continue, true);
  assert.deepEqual(options.prompts, ['hello']);
  assert.deepEqual(options.run.tools, ['read_file', 'grep']);
  for (const args of [
    ['--fork', 'id', '-c'],
    ['--no-session', '--session', 'id'],
    ['-r', '-p', 'hello'],
    ['--line', 'hello'],
    ['--thinking', 'invalid'],
  ])
    assert.throws(() => parseCli(args), UsageError);
});
test('custom argument substitution is one pass and retains quoted values', () => {
  assert.equal(
    substituteArguments(
      '$1 / $2 / ${3:-fallback} / ${@:2:1}',
      '"hello world" "$1"',
    ),
    'hello world / $1 / fallback / $1',
  );
});
test('session export round-trips exact raw tool output, validates references, and escapes HTML', () => {
  const meta = {
    thread_id: 'one',
    title: '<title>',
    model: 'test',
    workspace: '/project',
  };
  const messages = [
    { id: '1', role: 'user' as const, content: '<script>bad</script>' },
    {
      id: '2',
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: 'call', name: 'read', args: {} }],
    },
    {
      id: '3',
      role: 'tool' as const,
      content: 'raw\n\u0000',
      tool_call_id: 'call',
      name: 'read',
    },
  ];
  assert.deepEqual(fromJsonl(toJsonl(messages, meta)).messages, messages);
  assert.throws(
    () => fromJsonl(toJsonl(messages.slice(0, 2), meta)),
    /pending/,
  );
  const html = toHtml(messages, meta);
  assert.ok(!html.includes('<script>bad'));
  assert.match(html, /&lt;script&gt;/);
});
