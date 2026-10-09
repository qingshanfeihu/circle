import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionApp } from '../src/tui/session_app.js';
import {
  renderScreen,
  transcriptRows,
  type ScreenState,
} from '../src/tui/render.js';
import { jobRows } from '../src/tui/strip_rows.js';
import { formatTokens } from '../src/tui/status_rows.js';
import type { SubagentView } from '../src/tui/subagents.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  palette,
  setPalette,
} from '../src/ink/theme.js';
import { planRows } from '../src/ink/components/plan_panel.js';
import { loopFrame } from '../src/ink/components/loop_frame.js';
import { stripAnsi } from '../src/ink/string_width.js';
import {
  emptyUsage,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';
import type { Job } from '../src/jobs.js';
import { cleanup, scratch } from './helpers.js';

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await delay(5);
  }
}
const reply = (
  content: string,
  calls: Message['tool_calls'] = [],
): ModelResponse => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    ...(calls.length ? { tool_calls: calls } : {}),
  },
  usage: emptyUsage(),
});
function state(over: Partial<ScreenState> = {}): ScreenState {
  return {
    messages: [],
    notices: [],
    welcome: [],
    draft: '',
    draftCursor: 0,
    streaming: '',
    thinking: '',
    usage: emptyUsage(),
    flash: '',
    started: Date.now(),
    scroll: 0,
    hiddenTurns: 0,
    todos: [],
    workspace: '/tmp/work',
    version: '1.0.3',
    model: 'scripted',
    ...over,
  } as ScreenState;
}
function agent(index: number, over: Partial<SubagentView> = {}): SubagentView {
  return {
    id: `session-${index}-00000000${index}`,
    name: 'general-purpose',
    description: `general-purpose: task ${index}`,
    messages: [],
    state: 'running',
    started: Date.now() - 10_000,
    tokens: 1000 * index,
    ...over,
  };
}
function bigScreen(t: Parameters<typeof scratch>[0]): void {
  for (const [name, value] of [
    ['rows', 50],
    ['columns', 120],
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

// A session whose main turn starts `count` task subagents together. Each subagent holds
// until released; one whose task says `write` first asks to write a file.
async function subagents(t: Parameters<typeof scratch>[0], tasks: string[]) {
  bigScreen(t);
  const root = scratch(t);
  const settings = trustFolder(defaultSettings(), root);
  let open = false;
  const held: (() => void)[] = [];
  const release = (): void => {
    open = true;
    for (const go of held.splice(0)) go();
  };
  const route = async (request: ModelRequest): Promise<ModelResponse> => {
    const first = String(
      request.messages.find((m) => m.role === 'user')?.content,
    );
    const last = request.messages.at(-1)!;
    if (first === 'start them')
      return last.role === 'tool'
        ? reply('All done.')
        : reply(
            '',
            tasks.map((description, index) => ({
              id: `task-${index}`,
              name: 'task',
              args: { description, subagent_type: 'general-purpose' },
            })),
          );
    if (first.includes('write') && last.role === 'user')
      return reply('', [
        {
          id: `write-${first}`,
          name: 'write_file',
          args: { file_path: 'notes/a.md', content: 'hello' },
        },
      ]);
    if (!open) await new Promise<void>((go) => held.push(go));
    return reply(`finished ${first}`);
  };
  const model = new ScriptedModel(
    Array.from(
      { length: 100 },
      () => (request: ModelRequest) => route(request),
    ),
  );
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  let rendered: string[] = [];
  let paints = 0;
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
    paints++;
  };
  await app.attach({
    workspace: root,
    home: root,
    settings,
    model,
    headless: true,
  });
  const runtime = app.runtime!;
  cleanup(t, async () => {
    release();
    ui.off?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    if (ui.renderTimer) clearTimeout(ui.renderTimer);
    ui.input.close();
    await runtime.close();
  });
  const turn = runtime.harness.run('start them');
  // closing the runtime at the end stops a turn a test left running
  void turn.catch(() => {});
  const frame = (): string[] => {
    ui.repaint();
    return rendered;
  };
  const running = (): number =>
    (app.state.subagents ?? []).filter((view) =>
      ['running', 'waiting'].includes(view.state),
    ).length;
  const mouse = (action: string, button: number, x: number, y: number): void =>
    ui.handle({ type: 'mouse', action, button, x, y });
  const key = (name: string, char = ''): void =>
    ui.handle({ type: 'key', key: name, char });
  return {
    app,
    ui,
    runtime,
    turn,
    frame,
    running,
    mouse,
    key,
    release,
    paints: () => paints,
  };
}

test('the strip lists only subagents that run: a selected one that ended leaves no row behind', () => {
  const done = agent(1, { state: 'done', updated: Date.now() });
  const live = agent(2);
  let rows = renderScreen(
    state({ subagents: [done, live], selectedAgent: done.id }),
    100,
    40,
  ).map(stripAnsi);
  assert.ok(rows.some((row) => row.startsWith(' Agents · 1')));
  assert.ok(!rows.some((row) => row.includes('general-purpose·00000001')));
  assert.ok(rows.some((row) => row.includes('general-purpose·00000002')));
  // nothing runs: no header, no stray row under the footer
  const s = state({ subagents: [done], selectedAgent: done.id });
  rows = renderScreen(s, 100, 40).map(stripAnsi);
  assert.equal(s.stripAgents, undefined);
  assert.ok(!rows.some((row) => row.includes('general-purpose·')));
  assert.equal(rows.at(-1)!.trim().startsWith('↑'), true, rows.at(-1));
});

test('the strip window stays where the wheel left it and follows the selection otherwise', () => {
  const agents = Array.from({ length: 10 }, (_, index) => agent(index));
  const s = state({ subagents: agents });
  renderScreen(s, 100, 40);
  assert.equal(s.stripAgents!.scrollable, true);
  assert.deepEqual(
    s.stripAgents!.ids,
    agents.slice(0, 6).map((view) => view.id),
  );
  renderScreen({ ...s, stripStart: 3 }, 100, 40);
  const moved = { ...s, stripStart: 3 };
  renderScreen(moved, 100, 40);
  assert.deepEqual(
    moved.stripAgents!.ids,
    agents.slice(3, 9).map((view) => view.id),
  );
  // past the end it stops at the last full window
  const far = { ...s, stripStart: 50 };
  renderScreen(far, 100, 40);
  assert.deepEqual(
    far.stripAgents!.ids,
    agents.slice(4).map((v) => v.id),
  );
  // unset, the window shows the selection
  const picked = { ...s, selectedAgent: agents[8]!.id };
  renderScreen(picked, 100, 40);
  assert.ok(picked.stripAgents!.ids.includes(agents[8]!.id));
  // six or fewer: nothing to scroll
  const few = state({ subagents: agents.slice(0, 3) });
  renderScreen(few, 100, 40);
  assert.equal(few.stripAgents!.scrollable, false);
});

test('a background subagent job row shows its tokens, and counts past a million read as M', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(12_345), '12.3k');
  assert.equal(formatTokens(7_824_000), '7.8M');
  assert.equal(formatTokens(59_541_800), '59.5M');
  const job = {
    id: 'j4',
    kind: 'agent',
    title: 'general-purpose: rewrite the modules',
    status: 'running',
    started: Date.now() - 3_594_000,
    detail: 'Write(src/cex_core/index.ts)',
    outputPath: '/nowhere',
  } as unknown as Job;
  const [row] = jobRows([job], {
    width: 120,
    tokens: new Map([['j4', 7_824_000]]),
  }).map(stripAnsi);
  assert.match(row!, /Write\(src\/cex_core\/index\.ts\)/);
  assert.match(row!, /59m 54s · 7\.8M tokens $/);
  const [plain] = jobRows([{ ...job, kind: 'shell' } as Job], {
    width: 120,
  }).map(stripAnsi);
  assert.doesNotMatch(plain!, /tokens/);
});

test('a notice sits after the message it came after, not under everything that followed', () => {
  const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'first question' },
    { id: 'a1', role: 'assistant', content: 'first answer' },
    { id: 'u2', role: 'user', content: 'second question' },
    { id: 'a2', role: 'assistant', content: 'second answer' },
  ];
  const rows = transcriptRows(
    state({
      messages,
      notices: ['between the turns', 'New session circle-1', 'no anchor'],
      noticeAnchors: ['a1', '', undefined],
    }),
    80,
  ).map(stripAnsi);
  const at = (text: string): number =>
    rows.findIndex((row) => row.includes(text));
  assert.ok(at('New session circle-1') < at('first question'));
  assert.ok(at('first answer') < at('between the turns'));
  assert.ok(at('between the turns') < at('second question'));
  assert.ok(at('second answer') < at('no anchor'));
  // an anchor whose message is not shown (an undone turn) falls back to the end
  const hidden = transcriptRows(
    state({
      messages: messages.slice(0, 2),
      notices: ['from later'],
      noticeAnchors: ['a2'],
    }),
    80,
  ).map(stripAnsi);
  assert.ok(
    hidden.findIndex((row) => row.includes('from later')) >
      hidden.findIndex((row) => row.includes('first answer')),
  );
});

test('the mouse lights the strip row and the page button under it, and repaints only when that changes', async (t) => {
  const s = await subagents(t, ['task a', 'task b']);
  await until(() => s.running() === 2);
  s.frame();
  const strip = s.app.state.stripAgents!;
  const before = s.paints();
  s.mouse('move', 3, 10, strip.row + 1);
  assert.equal(s.app.state.hoverAgent, strip.ids[1]);
  assert.equal(s.paints(), before + 1);
  s.mouse('move', 3, 30, strip.row + 1);
  assert.equal(s.paints(), before + 1, 'the same row: no repaint');
  const rows = s.frame();
  assert.ok(rows[strip.row + 1]!.includes(palette().sel_bg.slice(2, -1)));
  assert.ok(!/\x1b\[[\d;]*48;/.test(rows[strip.row]!), 'the other row is bare');
  s.mouse('move', 3, 10, 1);
  assert.equal(s.app.state.hoverAgent, undefined);
  // on a subagent's page, the band's buttons light up under the mouse too
  s.mouse('press', 0, 10, strip.row);
  assert.equal(s.app.state.agentDetail?.id, strip.ids[0]);
  s.frame();
  const band = s.app.state.pageButtons!;
  const [start, , action] = band.spans[0]!;
  s.mouse('move', 3, start + 1, band.row);
  assert.equal(s.app.state.hoverButton, action);
  assert.ok(s.frame()[band.row]!.includes(palette().sel_bg.slice(2, -1)));
});

test('the wheel over a strip with folded subagents moves the strip and leaves the conversation where it is', async (t) => {
  const s = await subagents(
    t,
    Array.from({ length: 8 }, (_, index) => `task ${index}`),
  );
  await until(() => s.running() === 8);
  s.frame();
  const strip = s.app.state.stripAgents!;
  assert.equal(strip.scrollable, true);
  const first = strip.ids;
  s.mouse('wheel', 1, 10, strip.row + 2);
  s.frame();
  assert.equal(s.app.state.scroll, 0);
  assert.deepEqual(s.app.state.stripAgents!.ids.slice(0, -1), first.slice(1));
  s.mouse('wheel', 0, 10, strip.row + 2);
  s.frame();
  assert.deepEqual(s.app.state.stripAgents!.ids, first);
  // a key that moves the selection takes the window back to it
  s.mouse('wheel', 1, 10, strip.row + 2);
  s.key('down');
  s.frame();
  assert.equal(s.app.state.stripStart, undefined);
  assert.ok(s.app.state.stripAgents!.ids.includes(s.app.state.selectedAgent!));
});

test("a subagent's card names it, and its record keeps esc and ← → while the card waits", async (t) => {
  const s = await subagents(t, ['write the notes', 'task b']);
  await until(() => Boolean(s.app.state.dialog) && s.running() === 2);
  const asker = s.app.state.subagents!.find((view) =>
    view.description.includes('write'),
  )!;
  const name = `general-purpose·${asker.id.replace(/[^0-9A-Za-z]/g, '').slice(-8)}`;
  assert.equal(
    s.app.state.dialog!.title,
    `${name} · Write needs your permission`,
  );
  s.frame();
  const strip = s.app.state.stripAgents!;
  const focus = s.app.state.dialog!.focus;
  // open a record with the mouse while the card waits
  s.mouse('press', 0, 10, strip.row);
  const opened = s.app.state.agentDetail!.id;
  s.key('right');
  assert.notEqual(s.app.state.agentDetail?.id, opened, '→ moves to the next');
  assert.equal(s.app.state.dialog!.focus, focus, 'the card did not move');
  s.key('escape');
  assert.equal(s.app.state.agentDetail, undefined, 'esc left the record');
  assert.ok(s.app.state.dialog, 'and did not answer the card');
  assert.equal(s.app.state.selectedAgent, undefined);
  // a letter on the record only leaves it
  s.mouse('press', 0, 10, strip.row);
  s.key('1', '1');
  assert.equal(s.app.state.agentDetail, undefined);
  assert.ok(s.app.state.dialog, 'a digit on the page did not approve');
  // with the record closed, the card has the keys again
  s.key('1', '1');
  await until(() => !s.app.state.dialog);
  s.release();
  await s.turn;
});

test('leaving a record opened with the mouse clears the selection; one opened from the strip goes back to it', async (t) => {
  const s = await subagents(t, ['task a', 'task b']);
  await until(() => s.running() === 2);
  s.frame();
  const strip = s.app.state.stripAgents!;
  const detail = (): string | undefined => s.app.state.agentDetail?.id;
  const selected = (): string | undefined => s.app.state.selectedAgent;
  s.mouse('press', 0, 10, strip.row + 1);
  assert.equal(detail(), strip.ids[1]);
  s.key('escape');
  s.frame();
  assert.equal(detail(), undefined);
  assert.equal(selected(), undefined);
  s.key('down');
  s.key('enter');
  assert.equal(detail(), strip.ids[0]);
  s.key('escape');
  s.frame();
  assert.equal(detail(), undefined);
  assert.equal(selected(), strip.ids[0], 'back on the strip');
  // once its subagent ends, the selection goes and nothing is left in the strip
  s.release();
  await s.turn;
  s.frame();
  assert.equal(selected(), undefined);
  assert.equal(s.app.state.stripAgents, undefined);
});

test('a notice keeps its place when the next turn adds messages under it', async (t) => {
  bigScreen(t);
  const root = scratch(t);
  const settings = trustFolder(defaultSettings(), root);
  const model = new ScriptedModel([
    reply('first answer'),
    reply('second answer'),
  ]);
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  await app.attach({
    workspace: root,
    home: root,
    settings,
    model,
    headless: true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.input.close();
    await app.runtime?.close();
  });
  ui.notice('before anything');
  await app.runtime!.harness.run('first question');
  ui.notice('Signed out · credentials cleared');
  await app.runtime!.harness.run('second question');
  ui.repaint();
  const plain = rendered.map(stripAnsi);
  const at = (text: string): number =>
    plain.findIndex((row) => row.includes(text));
  assert.ok(at('before anything') < at('first question'));
  assert.ok(at('first answer') < at('Signed out'));
  assert.ok(at('Signed out') < at('second question'), plain.join('\n'));
});

test('a background subagent job shows its step as a tool row does, not the raw call', async (t) => {
  const root = scratch(t);
  let seen: string | undefined;
  let runtime!: AgentRuntime;
  const model = new ScriptedModel([
    reply('', [
      {
        id: 'bg',
        name: 'task',
        args: {
          description: 'write the notes',
          subagent_type: 'general-purpose',
          background: true,
        },
      },
    ]),
    reply('', [
      {
        id: 'w',
        name: 'write_file',
        args: { file_path: 'notes/a.md', content: 'line one\nline two' },
      },
    ]),
    async () => {
      seen = runtime.jobs.list()[0]?.detail;
      return reply('wrote it');
    },
    reply('Started.'),
  ]);
  runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('go');
  await until(() => seen !== undefined);
  assert.equal(seen, 'Write(notes/a.md)');
});

test('the plan box has nothing behind its steps, and its frame is the input box’s resting colour', () => {
  for (const [fg, bg] of [DEFAULT_DARK, DEFAULT_LIGHT]) {
    setPalette(buildPalette(fg, bg));
    const p = palette();
    const rows = planRows(
      [
        { content: 'read the loader', status: 'completed' },
        { content: 'fix the lookup', status: 'in_progress' },
        { content: 'add a test', status: 'pending' },
      ],
      60,
      0,
      'running',
    );
    for (const row of rows) {
      assert.ok(!/\x1b\[[\d;]*48;/.test(row), JSON.stringify(row));
      assert.ok(row.startsWith(p.faint), JSON.stringify(row));
      assert.ok(!row.includes(p.line), 'not the fainter rule colour');
    }
    // the lamp in the title resets its colour: the rest of the top edge picks `faint`
    // up again instead of turning white (seen on Windows Terminal)
    assert.ok(
      rows[0]!.includes('●' + p.reset + p.faint),
      JSON.stringify(rows[0]),
    );
    const idle = loopFrame(60, {});
    assert.ok(idle.top.startsWith(p.faint));
  }
  setPalette(buildPalette(...DEFAULT_DARK));
});

test('a row whose marker is a lamp keeps its tint after the lamp', () => {
  const p = palette();
  const rows = transcriptRows(
    state({
      userShells: [
        {
          id: 'shell',
          sessionId: 'session',
          command: 'ls -la',
          output: 'a\nb',
          status: 'done',
          exitCode: 0,
        },
      ],
    } as Partial<ScreenState>),
    60,
  );
  const row = rows.find((line) => line.includes('execute(ls -la)'))!;
  const after = row.slice(row.indexOf('●') + 1);
  assert.ok(after.startsWith(p.reset), JSON.stringify(after));
  assert.ok(
    after.slice(p.reset.length).startsWith(p.write_bg.slice(0, -1)),
    JSON.stringify(after),
  );
});
