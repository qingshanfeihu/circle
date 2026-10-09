import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  setPalette,
  type Palette,
} from '../src/ink/theme.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { planRows } from '../src/ink/components/plan_panel.js';
import {
  renderScreen,
  transcriptRows,
  type ScreenState,
} from '../src/tui/render.js';
import { emptyUsage, type Message } from '../src/types.js';
import type { Todo } from '../src/tools.js';

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
// The lamp states drawn in `rows`, in order, read from the foreground colour in front of
// each `●`: the lamps use the terminal's own 16 colours (the contract), so 33 is yellow
// (running, dimmed when it blinks), 32 green, 31 red and 36 cyan (waiting for you).
function lamps(rows: string[]): string[] {
  const names: Record<string, string> = {
    '33': 'running',
    '32': 'ok',
    '31': 'error',
    '36': 'wait',
  };
  const found: string[] = [];
  for (const row of rows)
    for (const match of row.matchAll(/((?:\x1b\[[0-9;]*m)+)●/g)) {
      const params = [...match[1]!.matchAll(/\x1b\[([0-9;]*)m/g)].flatMap(
        (sgr) => sgr[1]!.split(';'),
      );
      // skip truecolor arguments (38;2;r;g;b and 48;2;r;g;b)
      const plain: string[] = [];
      for (let index = 0; index < params.length; index++) {
        if (params[index] === '38' || params[index] === '48') {
          index += params[index + 1] === '2' ? 4 : 2;
          continue;
        }
        plain.push(params[index]!);
      }
      const colour = plain.filter((param) => names[param]).at(-1);
      if (colour) found.push(names[colour]!);
    }
  return found;
}
const plan: Todo[] = [
  { content: 'All 7 batches done', status: 'completed' },
  { content: 'Final report per batch', status: 'in_progress' },
  { content: 'Archive', status: 'pending' },
];

test('a plan item in progress blinks only while a turn runs, is cyan while it waits for you and unlit after', () => {
  for (const [, p] of PALETTES) {
    setPalette(p);
    assert.deepEqual(lamps(planRows(plan, 80, 0, 'running')), [
      'running',
      'ok',
      'running',
    ]);
    assert.deepEqual(lamps(planRows(plan, 80, 0, 'wait')), [
      'wait',
      'ok',
      'wait',
    ]);
    // the conversation has ended: only what is done stays lit
    assert.deepEqual(lamps(planRows(plan, 80, 0, 'idle')), ['ok']);
    const done = plan.map((todo) => ({
      ...todo,
      status: 'completed' as const,
    }));
    assert.deepEqual(lamps(planRows(done, 80, 0, 'idle')), [
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
  }
});

test('a call without a result is running only in the reply a running turn works on', () => {
  const reply = (id: string, call: string): Message => ({
    id,
    role: 'assistant',
    content: '',
    tool_calls: [{ id: call, name: 'read_file', args: { file_path: 'a' } }],
  });
  // an older reply whose call never got a result (an interrupted turn, or a 0.5.0 session)
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'one' },
    reply('a1', 'lost'),
    { id: 'u2', role: 'user', content: 'two' },
    reply('a2', 'now'),
  ];
  for (const [, p] of PALETTES) {
    setPalette(p);
    const state = { ...screen(), messages };
    assert.deepEqual(lamps(transcriptRows(state, 80)), []);
    assert.deepEqual(lamps(transcriptRows({ ...state, busy: true }, 80)), [
      'running',
    ]);
    assert.deepEqual(
      lamps(transcriptRows({ ...state, busy: true, waiting: true }, 80)),
      ['wait'],
    );
  }
});

test('after the last answer the whole screen shows no running lamp, as the lab run left it', () => {
  for (const [, p] of PALETTES) {
    setPalette(p);
    const state: ScreenState = {
      ...screen(),
      todos: plan.slice(0, 2),
      messages: [
        { id: 'u', role: 'user', content: 'compile the 7 batches' },
        {
          id: 'a',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'w',
              name: 'write_todos',
              args: { todos: plan.slice(0, 2) },
            },
          ],
        },
        { id: 't', role: 'tool', tool_call_id: 'w', content: 'ok' },
        { id: 'r', role: 'assistant', content: 'Final report: 90/95 pass.' },
      ],
    };
    const rows = renderScreen(state, 120, 30);
    assert.ok(rows.some((row) => stripAnsi(row).includes('Plan 1/2')));
    assert.ok(!lamps(rows).includes('running'));
  }
});
