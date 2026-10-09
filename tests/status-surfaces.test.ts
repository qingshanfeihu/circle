import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildPalette,
  contrastRatio,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  GRADIENT_STOPS,
  gradientAt,
  palette,
  rgbToHex,
  setPalette,
  type Palette,
} from '../src/ink/theme.js';
import { ThemeWatch } from '../src/ink/theme_watch.js';
import { stringWidth, stripAnsi } from '../src/ink/string_width.js';
import { loopFrame } from '../src/ink/components/loop_frame.js';
import {
  LOGO_MIN_WIDTH,
  logoRows,
  welcomeRows,
  type WelcomeInfo,
} from '../src/ink/components/welcome.js';
import { renderScreen, type ScreenState } from '../src/tui/render.js';
import { thinkingRows } from '../src/tui/tool_rows.js';
import {
  BUSY_VERBS,
  busyLabel,
  footerRow,
  headerRows,
  pickBusyVerb,
  windowTitle,
} from '../src/tui/status_rows.js';
import { agentRows, jobRows, stripHeader } from '../src/tui/strip_rows.js';
import { TurnStatus } from '../src/tui/turn_status.js';
import { WelcomeState } from '../src/tui/welcome_state.js';
import { SessionApp } from '../src/tui/session_app.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { emptyUsage, type Message } from '../src/types.js';
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
// Every colour in `text` must be one the palette or the rainbow makes.
function coloursFrom(p: Palette, text: string, extra: string[] = []): void {
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
      ...extra,
    ]
      .flatMap((sgr) => [...sgr.matchAll(/\x1b\[([\d;]*)m/g)])
      .map((match) => match[1]),
  );
  for (const [, params] of text.matchAll(/\x1b\[([\d;]*)m/g)) {
    // A joined code (background and foreground in one) is checked part by part.
    const parts = params!.split(';');
    for (let index = 0; index < parts.length; index++) {
      const code = parts[index]!;
      if (code === '38' || code === '48') {
        const value = parts.slice(index, index + 5).join(';');
        index += 4;
        const bg = [
          p.panel_bg,
          p.sel_bg,
          p.read_bg,
          p.write_bg,
          p.think_bg,
          p.agent_bg,
        ].map((sgr) => sgr.slice(2, -1));
        assert.ok(
          allowed.has(value) || bg.includes(value),
          `colour ${value} is not from the palette`,
        );
      }
    }
  }
}

test('the header shows thinking depth and branch, hands off to the welcome block and is empty while setup or trust asks', () => {
  for (const [, p] of PALETTES) {
    setPalette(p);
    const [row, blank] = headerRows(
      {
        version: '1.0.0',
        model: 'step-3.7-flash',
        depth: 'high',
        workspace: '/project/app',
        branch: 'main',
        connected: true,
      },
      100,
    );
    assert.equal(blank, '');
    assert.equal(stringWidth(row!), 100);
    assert.match(
      stripAnsi(row!),
      /^ circle 1\.0\.0 · step-3\.7-flash • high · \/project\/app \(main\) +\? for shortcuts $/,
    );
    assert.ok(row!.includes(p.faint + '? for shortcuts'));
    // An unknown depth is not shown; the hint goes before the folder on a narrow screen.
    const narrow = stripAnsi(
      headerRows(
        {
          version: '1',
          model: 'm',
          depth: 'off',
          workspace: '/projects/some/deeply/nested/folder/app',
          connected: true,
        },
        40,
      )[0]!,
    );
    assert.ok(!narrow.includes('•') && !narrow.includes('shortcuts'));
    assert.match(narrow, /^ circle 1 · m · …[^ ]*folder\/app$/);
    assert.deepEqual(
      headerRows({ version: '1', model: 'm', workspace: '/w', gate: true }, 80),
      ['', ''],
    );
    assert.ok(
      !stripAnsi(
        headerRows(
          { version: '1', model: 'm', workspace: '/w', connected: false },
          80,
        )[0]!,
      ).includes('shortcuts'),
    );
  }
  // On the screen: while the welcome is in view only the hint is shown; once it scrolled
  // away the header says who and where.
  setPalette(PALETTES[0]![1]);
  const state = screen();
  state.thinkingDepth = 'medium';
  state.branch = 'feature';
  state.welcome = welcomeRows(90, welcomeInfo());
  let top = stripAnsi(renderScreen(state, 90, 40)[0]!);
  assert.equal(top.trim(), '? for shortcuts');
  state.messages = Array.from({ length: 30 }, (_, index) => ({
    id: String(index),
    role: index % 2 ? ('assistant' as const) : ('user' as const),
    content: `message ${index}`,
  }));
  top = stripAnsi(renderScreen(state, 90, 40)[0]!);
  assert.match(
    top,
    /circle 1\.0\.0 · model-x • medium · \/project\/app \(feature\)/,
  );
  state.gate = true;
  assert.equal(stripAnsi(renderScreen(state, 90, 40)[0]!).trim(), '');
});

test('the busy word is a Python verb with the turn time and written tokens, and the rainbow travels round the frame', () => {
  assert.equal(
    pickBusyVerb(() => 0),
    'Thinking',
  );
  assert.equal(
    pickBusyVerb(() => 0.99),
    'Examining',
  );
  assert.deepEqual(
    new Set(Array.from({ length: 50 }, (_, i) => pickBusyVerb(() => i / 50))),
    new Set(BUSY_VERBS),
  );
  assert.equal(
    busyLabel('Pondering', 12.44, 1900),
    'Pondering… · 12.4s · ↓ 1.9k',
  );
  assert.equal(busyLabel('Brewing', 75, 12), 'Brewing… · 1m 15s · ↓ 12');
  for (const [name, p] of PALETTES) {
    setPalette(p);
    const state = screen();
    state.busy = true;
    state.busyVerb = 'Pondering';
    state.busyTokens = 1900;
    state.started = Date.now() - 12_400;
    const rows = renderScreen(state, 80, 20);
    const top = rows.find((row) => stripAnsi(row).startsWith('╭'))!;
    assert.match(stripAnsi(top), /^╭──Pondering… · 12\.\d+s · ↓ 1\.9k─+╮ *$/);
    assert.ok(!rows.some((row) => stripAnsi(row).includes('Brewing')));
    // Each cell is coloured by its place on the perimeter plus the flow: one colour per cell,
    // a slow sweep, the same gradient on the edges and the label.
    const frame = loopFrame(30, { elapsed: 2, label: 'Busy' });
    const colours = [
      ...frame.top.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g),
    ].map((match) =>
      rgbToHex([Number(match[1]), Number(match[2]), Number(match[3])]),
    );
    assert.equal(colours.length, 30);
    const perimeter = 2 * 31;
    colours.forEach((colour, index) =>
      assert.equal(
        colour,
        rgbToHex(gradientAt(p.rainbow_stops, index / perimeter + 0.24)),
      ),
    );
    const later = loopFrame(30, { elapsed: 4, label: 'Busy' });
    assert.notEqual(later.top, frame.top);
    // Stops are used as they are on a dark background and darkened just enough on a light one.
    p.rainbow_stops.forEach(([, rgb], index) => {
      const own = GRADIENT_STOPS[index]![1];
      if (name === 'dark') assert.deepEqual(rgb, own);
      else
        assert.ok(
          contrastRatio(rgbToHex(rgb), p.bg_hex) >= 3 ||
            rgbToHex(rgb) !== rgbToHex(own),
        );
    });
    // Still frames: faint when idle, a card's yellow, and the mode word in its own colour.
    const idle = loopFrame(30, { mode: 'read-only', modeSgr: p.green });
    assert.ok(idle.top.startsWith(p.faint + '╭'));
    assert.ok(idle.bottom.includes(p.green + ' read-only '));
    assert.ok(!idle.top.includes('38;2;8;148;255'));
    assert.ok(loopFrame(30, { border: p.yellow }).left.startsWith(p.yellow));
    // Outside the frame (which the sweep above checks) every colour is the palette's.
    coloursFrom(
      p,
      rows.filter((row) => !/^[╭│╰]/.test(stripAnsi(row))).join('\n'),
    );
  }
});

test('footer meters colour the context yellow from 70% and red from 90%, and a flash takes the right side', () => {
  for (const [, p] of PALETTES) {
    setPalette(p);
    const usage = {
      input_tokens: 36_600,
      output_tokens: 560,
      cache_read_tokens: 20_000,
    };
    const quiet = footerRow(
      { usage, contextInput: 69_000, contextWindow: 100_000 },
      '',
      100,
    );
    assert.ok(!quiet.includes(p.yellow) && !quiet.includes(p.red));
    const warm = footerRow(
      { usage, contextInput: 70_000, contextWindow: 100_000 },
      '',
      100,
    );
    assert.ok(warm.includes(p.yellow + 'ctx 70.0k/100.0k (70%)'));
    const full = footerRow(
      { usage, contextInput: 91_000, contextWindow: 100_000 },
      '',
      100,
    );
    assert.ok(full.includes(p.red + 'ctx 91.0k/100.0k (91%)'));
    assert.equal(
      stripAnsi(full),
      ' ↑ 36.6k · ↓ 560 · cache 54.6% · ctx 91.0k/100.0k (91%)',
    );
    const unknown = footerRow({ usage, contextInput: 91_000 }, '', 100);
    assert.match(stripAnsi(unknown), /ctx 91\.0k\/N\/A$/);
    const flashed = footerRow(
      { usage, contextInput: 91_000, contextWindow: 100_000 },
      'Copied',
      60,
    );
    assert.equal(stringWidth(flashed), 60);
    assert.match(stripAnsi(flashed), /^ ↑ 36\.6k.* Copied $/);
    assert.ok(!flashed.includes(p.red));
  }
  // Before the session is connected there are no meters.
  const state = screen();
  state.connected = false;
  assert.ok(
    !renderScreen(state, 80, 20).some((row) =>
      stripAnsi(row).includes('cache'),
    ),
  );
});

function job(id: string, title: string, kind: Job['kind'] = 'shell'): Job {
  return {
    id,
    kind,
    title,
    sessionId: 'session',
    status: 'running',
    reason: '',
    started: Date.now() - 72_000,
    outputPath: '/missing-output',
    virtualPath: `/background_jobs/${id}.log`,
    ...(kind === 'agent' ? { detail: 'reading files' } : {}),
  };
}

test('the strip sits under the footer: a header naming what is there, subagent rows, then at most four jobs', () => {
  for (const [, p] of PALETTES) {
    setPalette(p);
    const state = screen();
    state.subagents = [
      {
        id: 'session-0001-abcdef12',
        name: 'explore',
        description: 'explore: find the tests',
        messages: [],
        state: 'running',
        started: Date.now() - 30_000,
        tokens: 3400,
      },
      {
        id: 'session-0002-99999999',
        name: 'general-purpose',
        description: 'general-purpose: fix it',
        messages: [],
        state: 'waiting',
        started: Date.now() - 5000,
        tokens: 10,
      },
    ];
    state.jobs = [
      job('j1', 'npm run dev'),
      job('j2', 'reviewer', 'agent'),
      ...['j3', 'j4', 'j5', 'j6'].map((id) => job(id, 'sleep 100')),
    ];
    for (const width of [40, 80, 120]) {
      const rows = renderScreen(state, width, 30);
      const plain = rows.map(stripAnsi);
      const footer = plain.findIndex((row) => row.includes('cache'));
      const header = plain.findIndex((row) =>
        row.startsWith(' Agents · 2 · Jobs · 6'),
      );
      assert.ok(footer > 0 && header === footer + 1, plain.join('\n'));
      assert.ok(rows.every((row) => stringWidth(row) === width));
      // Narrow, the name is cut from the middle so the id tail survives.
      assert.match(
        plain[header + 1]!,
        width >= 80
          ? /^ ● explore·abcdef12 +find the tests/
          : /^ ● explor…bcdef12/,
      );
      assert.match(
        plain[header + 2]!,
        width >= 80 ? /waiting for you/ : /waiting…/,
      );
      assert.match(rows[header + 2]!, /\x1b\[(?:[\d;]*;)?36m●/);
      assert.match(plain[header + 3]!, /^ ● j1 npm run dev/);
      assert.match(plain[header + 3]!, /1m 12s $/);
      assert.ok(rows[header + 3]!.includes(p.write_bg.slice(2, -1)));
      assert.ok(rows[header + 4]!.includes(p.agent_bg.slice(2, -1)));
      assert.match(plain[header + 4]!, /reading fil/);
      assert.match(plain.at(-1)!, /^ {2}… \+2 more jobs/);
      assert.ok(!plain.some((row) => row.includes('↓ select')));
    }
    assert.match(stripAnsi(stripHeader(0, 3, 30)), /^ Jobs · 3 +$/);
    // A subagent row has no background until it is selected or under the mouse; long
    // names keep their id tail.
    const selected = agentRows(state.subagents!, {
      width: 60,
      selected: 'session-0001-abcdef12',
    });
    assert.ok(selected[0]!.includes(p.sel_bg.slice(2, -1)));
    assert.ok(!/\x1b\[[\d;]*48;/.test(selected[1]!), selected[1]);
    const hovered = agentRows(state.subagents!, {
      width: 60,
      hover: 'session-0002-99999999',
    });
    assert.ok(!/\x1b\[[\d;]*48;/.test(hovered[0]!));
    assert.ok(hovered[1]!.includes(p.sel_bg.slice(2, -1)));
    const narrow = agentRows(state.subagents!, { width: 30 }).map(stripAnsi);
    assert.ok(
      narrow.every((row) => stringWidth(row) === 30),
      narrow.join('\n'),
    );
    assert.match(narrow[1]!, /9999/);
    assert.ok(!narrow[0]!.includes('tokens'));
    assert.equal(jobRows([job('j1', 'x')], { width: 40 }).length, 1);
  }
});

function welcomeInfo(over: Partial<WelcomeInfo> = {}): WelcomeInfo {
  return {
    version: '1.0.0',
    model: 'glm-5.3 • high',
    endpoint: 'open.bigmodel.cn',
    folder: '~/code/project',
    branch: 'main',
    items: [
      { kind: 'instructions', text: 'AGENTS.md', state: 'ok' },
      { kind: 'skills', text: '3 in .circle/skills', state: 'running' },
      {
        kind: 'extensions',
        text: '1 in .circle/extensions',
        state: 'error',
        errors: ['broken: Error: boom'],
      },
      { kind: 'settings', text: '.circle/settings.json', state: 'none' },
    ],
    recent: [
      ['why does the export test fail on windows?', '2h'],
      ['clean up', '3d'],
    ],
    more: 6,
    ...over,
  };
}

test('the welcome block draws the ring in its own colours, lamps that follow the session and the recent sessions', () => {
  const logos = PALETTES.map(([, p]) => {
    setPalette(p);
    return logoRows();
  });
  assert.deepEqual(logos[0], logos[1]);
  // logo.svg's ring in three rows of sextants (two by three sub-cells a cell).
  assert.deepEqual(logos[0]!.map(stripAnsi), ['🬞🬚🬆🬂🬊🬩🬏', '█     █', '🬁🬌🬱🬭🬵🬍🬀']);
  assert.ok(logos[0]!.every((row) => stringWidth(stripAnsi(row)) === 7));
  // Blue at the top, red at the bottom, purple on the right and orange on the left, as
  // logo.svg draws them; each cell in one colour.
  const colour = (row: number, cell: number): number[] => {
    const codes = [...logos[0]![row]!.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)];
    return codes[cell]!.slice(1, 4).map(Number);
  };
  const [topR, , topB] = colour(0, 3);
  assert.ok(topB! > topR!, 'blue at the top');
  const [bottomR, , bottomB] = colour(2, 3);
  assert.ok(bottomR! > bottomB!, 'red at the bottom');
  const [leftR, , leftB] = colour(1, 0);
  assert.ok(leftR! > leftB!, 'orange on the left');
  const [, rightG, rightB] = colour(1, 1);
  assert.ok(rightB! > rightG!, 'purple on the right');
  for (const [, p] of PALETTES) {
    setPalette(p);
    const rows = welcomeRows(90, welcomeInfo());
    const plain = rows.map(stripAnsi);
    // the version, the model and the folder beside the three rows of the ring
    assert.match(plain[0]!, /circle 1\.0\.0$/);
    assert.match(plain[1]!, /glm-5\.3 • high · open\.bigmodel\.cn$/);
    assert.match(plain[2]!, /~\/code\/project \(main\)$/);
    const at = (kind: string) =>
      rows.findIndex((row) => stripAnsi(row).includes(kind));
    assert.ok(rows[at('instructions')]!.includes(p.green + '●'));
    assert.ok(
      rows[at('skills')]!.includes(p.yellow + '●') ||
        rows[at('skills')]!.includes('2;33m●'),
    );
    assert.ok(rows[at('extensions')]!.includes(p.red + '●'));
    assert.match(plain[at('extensions') + 1]!, /^ {3} +broken: Error: boom$/);
    assert.ok(rows[at('extensions') + 1]!.includes(p.red));
    // Not lit: no lamp, the row is faint.
    assert.match(plain[at('settings')]!, /^ {3}settings/);
    assert.ok(rows[at('settings')]!.includes(p.faint + 'settings'));
    assert.match(plain.at(-2)!, /^ {3}… \+6 more · \/resume$/);
    assert.match(
      plain.find((row) => row.includes('clean up'))!,
      /clean up +3d$/,
    );
    assert.equal(plain.at(-1), '');
    const waiting = welcomeRows(
      90,
      welcomeInfo({ model: '', items: [], recent: [] }),
    ).map(stripAnsi);
    assert.ok(waiting.some((row) => row.endsWith('not connected yet')));
    assert.ok(!waiting.some((row) => row.includes('recent')));
    const narrow = welcomeRows(LOGO_MIN_WIDTH - 1, welcomeInfo()).map(
      stripAnsi,
    );
    assert.equal(narrow[0], ' circle 1.0.0');
    assert.ok(narrow.every((row) => stringWidth(row) <= LOGO_MIN_WIDTH - 1));
    coloursFrom(p, rows.slice(LOGO_ROWS_SKIP).join('\n'));
  }
});
const LOGO_ROWS_SKIP = 4;

test('the welcome lists what the folder brings, unlit until trusted, blinking while it loads and green once loaded', (t) => {
  const root = scratch(t);
  const folder = join(root, 'project');
  mkdirSync(join(folder, '.circle', 'skills', 'deploy'), { recursive: true });
  mkdirSync(join(folder, '.circle', 'commands'), { recursive: true });
  writeFileSync(join(folder, 'AGENTS.md'), '# rules\n');
  writeFileSync(
    join(folder, '.circle', 'skills', 'deploy', 'SKILL.md'),
    '---\nname: deploy\ndescription: Deploy it\n---\nbody\n',
  );
  writeFileSync(join(folder, '.circle', 'commands', 'ship.md'), 'Ship it\n');
  writeFileSync(join(folder, '.circle', 'settings.json'), '{}');
  const welcome = new WelcomeState(folder);
  const settings = defaultSettings();
  const info = (trusted: boolean, connected: boolean) =>
    welcome.info({
      version: '1',
      settings,
      connected,
      trusted,
    });
  const untrusted = info(false, false);
  assert.deepEqual(
    untrusted.items.map((item) => [item.kind, item.text, item.state]),
    [
      ['instructions', 'AGENTS.md', 'none'],
      // paths in the system's own separator, as 0.5.0 wrote them
      ['skills', `1 in ${join('.circle', 'skills')}`, 'none'],
      ['commands', `1 in ${join('.circle', 'commands')}`, 'none'],
      ['settings', join('.circle', 'settings.json'), 'none'],
    ],
  );
  // Filled in as setup is answered: the model and its host once the connection is saved.
  assert.equal(untrusted.model, '');
  assert.equal(untrusted.endpoint, '');
  settings.initialized = true;
  settings.auth.base_url = 'https://open.bigmodel.cn/api/paas/v4';
  settings.auth.model = 'glm-5.3';
  const saved = info(false, false);
  assert.equal(saved.model, 'glm-5.3');
  assert.equal(saved.endpoint, 'open.bigmodel.cn');
  assert.deepEqual(
    info(true, false).items.map((item) => item.state),
    ['running', 'running', 'running', 'running'],
  );
  assert.deepEqual(
    info(true, true).items.map((item) => item.state),
    ['ok', 'ok', 'ok', 'ok'],
  );
  // An empty folder shows no rows.
  const empty = new WelcomeState(scratch(t)).info({
    version: '1',
    settings,
    connected: true,
    trusted: true,
  });
  assert.deepEqual(empty.items, []);
});

test('thinking rows have no background on a dark theme and on a light one', () => {
  const text = '**Check the notes**\n\nThe file has three lines.';
  for (const [, p] of PALETTES) {
    setPalette(p);
    const folded = thinkingRows(text, {
      done: true,
      seconds: 1.2,
      expanded: false,
      width: 80,
    });
    assert.equal(folded.length, 1);
    assert.match(
      stripAnsi(folded[0]!),
      /^ ∴ Thought 1\.2s · Check the notes {2}ctrl\+t +$/,
    );
    assert.equal(stringWidth(folded[0]!), 80);
    assert.ok(folded[0]!.includes(p.reason.slice(2, -1)));
    assert.ok(folded[0]!.includes(p.faint.slice(2, -1)));
    assert.ok(!folded[0]!.includes(p.think_bg.slice(2, -1)));
    assert.ok(!folded[0]!.includes('\x1b[48'));
    const open = thinkingRows(text, {
      done: true,
      seconds: 1.2,
      expanded: true,
      width: 80,
    });
    assert.ok(open.length > 1);
    assert.ok(open[0]!.includes(p.reason_dim.slice(2, -1)));
    assert.ok(open.slice(1).some((row) => row.includes(p.faint.slice(2, -1))));
    assert.ok(
      open.some((row) => stripAnsi(row).includes('The file has three lines.')),
    );
    for (const row of open) {
      assert.equal(stringWidth(row), 80);
      assert.ok(!row.includes(p.think_bg.slice(2, -1)));
      assert.ok(!row.includes('\x1b[48'));
    }
    const live = thinkingRows('**Still reading**\n\nThe rest.', {
      done: false,
      expanded: false,
      width: 40,
    });
    assert.match(
      stripAnsi(live[0]!),
      /^ ∴ Thinking · Still reading {2}ctrl\+t +$/,
    );
    assert.ok(live[0]!.includes(p.reason.slice(2, -1)));
    assert.ok(!live[0]!.includes('\x1b[48'));
  }
});

test('a real turn renders short tool rows, a folded read, a folded thought with its time and a usage line without the approval wait', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'notes.txt'), 'one\ntwo\nthree\n');
  let settings = defaultSettings();
  settings = trustFolder(settings, root);
  const answer: Message = {
    id: 'answer',
    role: 'assistant',
    content: 'Read it.',
    thinking: '**Check the notes**\n\nThe file has three lines.',
  };
  const model = new ScriptedModel([
    {
      message: {
        id: 'call-read',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', name: 'read_file', args: { file_path: 'notes.txt' } },
        ],
      },
      usage: { input_tokens: 1000, output_tokens: 40, cache_read_tokens: 0 },
    },
    {
      message: {
        id: 'call-write',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c2',
            name: 'write_file',
            args: { file_path: 'out.txt', content: 'x' },
          },
        ],
      },
      usage: { input_tokens: 1100, output_tokens: 30, cache_read_tokens: 0 },
    },
    async (request) => {
      request.token('**Check the notes**\n\nThe file', true);
      await delay(60);
      request.token('Read it.');
      return {
        message: answer,
        usage: { input_tokens: 1200, output_tokens: 300, cache_read_tokens: 0 },
      };
    },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    approve: async () => {
      await delay(400);
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  const turns = new TurnStatus(() => 0.35);
  runtime.bus.subscribe((event) =>
    turns.apply(event, () => runtime.harness.messages.at(-1)?.id),
  );
  const started = Date.now();
  await runtime.harness.run('read the notes');
  const total = (Date.now() - started) / 1000;
  assert.equal(turns.verb, BUSY_VERBS[3]);
  assert.equal(turns.tokens, 370);
  const usage = turns.usage.answer!;
  assert.deepEqual([usage.input, usage.output], [3300, 370]);
  assert.ok(usage.seconds < total - 0.3, `${usage.seconds} of ${total}`);
  assert.ok(turns.thinking.answer! >= 0.05);
  for (const [, p] of PALETTES) {
    setPalette(p);
    const state = screen();
    state.messages = runtime.harness.messages;
    turns.fill(state);
    let rows = renderScreen(state, 80, 40);
    let plain = rows.map(stripAnsi);
    const read = plain.findIndex((row) => row.startsWith(' ● Read(notes.txt)'));
    assert.ok(read >= 0, plain.join('\n'));
    assert.ok(rows[read]!.includes(p.read_bg.slice(2, -1)));
    assert.equal(plain[read + 1]!.trimEnd(), '   ⎿ Read 3 lines · ctrl+o');
    assert.ok(rows[read + 1]!.includes(p.read_bg.slice(2, -1)));
    // Consecutive calls are one group with no blank row; the answer is its own block.
    assert.match(plain[read + 2]!, /^ ● Write\(out\.txt\)/);
    assert.ok(rows[read + 2]!.includes(p.write_bg.slice(2, -1)));
    const thought = plain.findIndex((row) => row.startsWith(' ∴ Thought'));
    assert.match(
      plain[thought]!,
      /^ ∴ Thought 0\.\ds · Check the notes {2}ctrl\+t/,
    );
    assert.ok(rows[thought]!.includes(p.reason.slice(2, -1)));
    assert.ok(!rows[thought]!.includes(p.think_bg.slice(2, -1)));
    assert.ok(!rows[thought]!.includes('\x1b[48'));
    assert.match(plain[thought + 1]!, /^ ● Read it\./);
    assert.match(plain[thought + 2]!.trimEnd(), /^ {3}\d+s · ↑ 3\.3k · ↓ 370$/);
    assert.ok(rows[thought + 2]!.includes(p.dim));
    coloursFrom(p, rows.join('\n'));
    // ctrl+t shows the thought's text on the terminal background; hiding thinking drops the row.
    state.thinkingExpanded = true;
    const open = renderScreen(state, 80, 40);
    plain = open.map(stripAnsi);
    const body = open.find((row) =>
      stripAnsi(row).includes('The file has three lines.'),
    );
    assert.ok(body);
    assert.ok(body!.includes(p.faint.slice(2, -1)));
    assert.ok(!body!.includes(p.think_bg.slice(2, -1)));
    assert.ok(!plain.some((row) => row.includes('ctrl+t')));
    state.showThinking = false;
    rows = renderScreen(state, 80, 40);
    assert.ok(!rows.some((row) => stripAnsi(row).includes('∴')));
    // ctrl+o shows the read in full.
    state.showTools = true;
    plain = renderScreen(state, 80, 40).map(stripAnsi);
    assert.ok(plain.some((row) => row.includes('⎿ 1: one')));
  }
});

test('long and failed results fold to six lines, a fixable mistake is struck through and an unanswered call waits for you', () => {
  for (const [, p] of PALETTES) {
    setPalette(p);
    const state = screen();
    state.waiting = true;
    state.messages = [
      {
        id: 'a',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', name: 'execute', args: { command: 'npm test\nmore' } },
          {
            id: 'c2',
            name: 'edit_file',
            args: { file_path: '/very/long/path/to/file.ts' },
          },
          { id: 'c3', name: 'grep', args: { pattern: 'TODO' } },
          { id: 'c4', name: 'write_todos', args: {} },
        ],
      },
      {
        id: 'r1',
        role: 'tool',
        tool_call_id: 'c1',
        name: 'execute',
        status: 'success',
        content: Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'),
      },
      {
        id: 'r2',
        role: 'tool',
        tool_call_id: 'c2',
        name: 'edit_file',
        status: 'error',
        recoverable: true,
        content: 'old_string not found',
      },
    ];
    const rows = renderScreen(state, 70, 40);
    const plain = rows.map(stripAnsi);
    const bash = plain.findIndex((row) => row.startsWith(' ● Bash(npm test)'));
    assert.ok(bash >= 0, plain.join('\n'));
    assert.equal(plain[bash + 6]!.trim(), 'line 5');
    assert.equal(plain[bash + 7]!.trim(), '… +4 lines · ctrl+o');
    const edit = plain.findIndex((row) => row.includes('Edit(…/to/file.ts)'));
    assert.match(plain[edit]!, /^ {3}Edit/);
    assert.ok(rows[edit]!.includes(';2;9m'));
    const grep = plain.findIndex((row) => row.includes('Grep(TODO)'));
    assert.match(plain[grep]!, /^ ● Grep\(TODO\) {2}waiting for you/);
    assert.ok(rows[grep]!.includes(';36m●'));
    assert.ok(!plain.some((row) => row.includes('TodoWrite')));
  }
});

test('the auto theme follows a dark/light flip with a flash, ignores the first answer and falls back to COLORFGBG', async () => {
  const flips: (string | undefined)[] = [];
  const watch = new ThemeWatch(
    'auto',
    () => {},
    (flip) => flips.push(flip),
    {},
  );
  watch.apply();
  assert.equal(palette().is_dark, true);
  const report = (fg: string, bg: string) => {
    watch.feed({ type: 'color', slot: 10, color: fg });
    watch.feed({ type: 'color', slot: 11, color: bg });
  };
  report('#ffffff', '#000000');
  await delay(200);
  report('#ffffff', '#000000');
  await delay(200);
  report('#000000', '#ffffff');
  await delay(200);
  report('#000000', '#fefefe');
  await delay(200);
  watch.close();
  assert.deepEqual(flips, [undefined, 'light', undefined]);
  assert.equal(palette().is_dark, false);
  new ThemeWatch(
    'auto',
    () => {},
    () => {},
    { COLORFGBG: '0;15' },
  ).apply();
  assert.equal(palette().bg_hex, DEFAULT_LIGHT[1]);
  new ThemeWatch(
    'auto',
    () => {},
    () => {},
    { COLORFGBG: '15;0' },
  ).apply();
  assert.equal(palette().bg_hex, DEFAULT_DARK[1]);
  new ThemeWatch(
    'dark',
    () => {},
    () => {},
    { COLORFGBG: '0;15' },
  ).apply();
  assert.equal(palette().bg_hex, DEFAULT_DARK[1]);
});

test('the session window title, /themes and ctrl+t say what changed', async (t) => {
  assert.equal(windowTitle('', '/home/me/project'), 'circle - project');
  assert.equal(
    windowTitle('fix the export test\nmore', '/home/me/project'),
    'circle - fix the export test - project',
  );
  assert.equal(
    windowTitle('a'.repeat(80), '/p').length,
    'circle - '.length + 40 + ' - p'.length,
  );
  const root = scratch(t);
  const settings = defaultSettings();
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const app = new SessionApp(root, root, settings);
  app.runtime = runtime;
  const ui = app as any;
  ui.screen.render = () => {};
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  await app.command('themes', 'light');
  assert.equal(app.state.notices.at(-1), 'Theme → light');
  assert.equal(palette().is_dark, false);
  await app.command('themes', 'auto');
  assert.equal(
    app.state.notices.at(-1),
    `Theme → auto (${palette().is_dark ? 'dark' : 'light'})`,
  );
  ui.handle({ type: 'key', key: 'ctrl+t', char: '' });
  assert.equal(app.state.thinkingExpanded, true);
  assert.equal(app.state.flash, 'Thinking expanded');
  ui.handle({ type: 'key', key: 'ctrl+t', char: '' });
  assert.equal(app.state.flash, 'Thinking collapsed');
  // The header and welcome come from the session's own state.
  ui.repaint();
  assert.equal(app.state.connected, true);
  assert.equal(app.state.gate, false);
  assert.ok(
    app.state.welcome.some((row: string) =>
      stripAnsi(row).includes('scripted'),
    ),
  );
});

test('every status row fits a narrow screen: rows are cut at the edge and keep their colours', () => {
  for (const [, p] of PALETTES) {
    setPalette(p);
    const state = screen();
    state.busy = true;
    state.planMode = true;
    state.flash = 'Theme → light';
    state.contextInput = 95_000;
    state.contextWindow = 100_000;
    state.welcome = welcomeRows(20, welcomeInfo());
    state.turnUsage = { r: { seconds: 12, input: 24_100, output: 451 } };
    state.messages = [
      { id: 'u', role: 'user', content: 'fix the very long thing 中文' },
      {
        id: 'a',
        role: 'assistant',
        content: '',
        thinking: '**Plan**\n\nlook first',
        tool_calls: [
          {
            id: 'c',
            name: 'execute',
            args: { command: 'npm test -- --grep long' },
          },
        ],
      },
      {
        id: 'r',
        role: 'tool',
        tool_call_id: 'c',
        name: 'execute',
        status: 'error',
        content: 'x'.repeat(300),
      },
    ];
    state.subagents = [
      {
        id: 'session-abcdef12',
        name: 'general-purpose',
        description: 'general-purpose: find the tests',
        messages: [],
        state: 'running',
        started: Date.now() - 30_000,
        tokens: 3400,
      },
    ];
    state.jobs = [job('j1', 'npm run dev -- --port 3000')];
    for (const width of [12, 15, 20, 24, 33])
      for (const height of [8, 24]) {
        const rows = renderScreen(state, width, height);
        assert.equal(rows.length, height);
        for (const row of rows)
          assert.equal(stringWidth(row), width, JSON.stringify(stripAnsi(row)));
      }
  }
});

test('an attached session shows the busy verb while it works and the turn line after it ends', async (t) => {
  const root = scratch(t);
  const settings = trustFolder(defaultSettings(), root);
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  let rendered: string[] = [];
  ui.screen.render = (rows: string[]) => {
    rendered = rows;
  };
  let label = '';
  const model = new ScriptedModel([
    async (request) => {
      ui.repaint();
      label =
        rendered.map(stripAnsi).find((row) => row.startsWith('╭──')) ?? '';
      request.token('done');
      return {
        message: { id: 'final', role: 'assistant', content: 'done' },
        usage: { input_tokens: 1500, output_tokens: 42, cache_read_tokens: 0 },
      };
    },
  ]);
  await app.attach({
    workspace: root,
    home: root,
    settings,
    model,
    headless: true,
  });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
    await app.runtime?.close();
  });
  // Loaded: the header and the meters are there.
  assert.equal(app.state.connected, true);
  assert.ok(rendered.some((row) => stripAnsi(row).includes('cache 0.0%')));
  await app.submit('hello');
  const verbs = BUSY_VERBS.join('|');
  assert.match(label, new RegExp(`^╭──(${verbs})… · \\d+\\.\\ds · ↓ 0─`));
  ui.repaint();
  const plain = rendered.map(stripAnsi);
  const answer = plain.findIndex((row) => row.startsWith(' ● done'));
  assert.ok(answer > 0, plain.join('\n'));
  assert.match(plain[answer + 1]!.trimEnd(), /^ {3}\d+s · ↑ 1\.5k · ↓ 42$/);
  assert.deepEqual(app.state.turnUsage?.final, {
    seconds: app.state.turnUsage!.final!.seconds,
    input: 1500,
    output: 42,
  });
});
