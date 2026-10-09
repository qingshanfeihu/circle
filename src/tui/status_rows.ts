// The rows that say what is true now: the header, the busy word on the frame, the footer's
// meters, the line under each turn, and the window title. Colours come from the palette
// each time a row is drawn (ported from session_app.py, footer.py and agent_strip.py).
import { homedir } from 'node:os';
import { basename, sep } from 'node:path';
import { palette } from '../ink/theme.js';
import { stringWidth, truncate } from '../ink/string_width.js';
import { EFFORT_LEVELS } from '../model.js';
import type { Usage } from '../types.js';

// What the frame's top edge says while the model works, one word picked per turn.
export const BUSY_VERBS = [
  'Thinking',
  'Considering',
  'Analyzing',
  'Brewing',
  'Pondering',
  'Cogitating',
  'Reflecting',
  'Processing',
  'Evaluating',
  'Examining',
] as const;
export function pickBusyVerb(random = Math.random): string {
  return BUSY_VERBS[Math.floor(random() * BUSY_VERBS.length)] ?? 'Brewing';
}

// The busy word's clock: `12.4s`, `3m 5s`, `1h 2m`.
export function formatBusyElapsed(seconds: number): string {
  const value = Math.max(0, seconds);
  if (value < 60) return `${value.toFixed(1)}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(value) % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
// The strip's and the turn line's clock: `12s`, `3m 5s`, `1h 2m`.
export function formatElapsed(seconds: number): string {
  const value = Math.max(0, seconds);
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(value) % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export function formatTokens(value: number): string {
  const count = Math.max(0, Math.floor(value || 0));
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}
function formatWindow(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : formatTokens(value);
}

// `Brewing… · 12.4s · ↓ 1.9k`: the turn's word, its time and the tokens it has written.
export function busyLabel(
  verb: string,
  seconds: number,
  tokens: number,
): string {
  return `${verb}… · ${formatBusyElapsed(seconds)} · ↓ ${formatTokens(tokens)}`;
}

// A folder as people write it: the home folder is `~`.
export function displayPath(path: string, home = homedir()): string {
  if (home && (path === home || path.startsWith(home + sep)))
    return '~' + path.slice(home.length);
  return path;
}

export interface HeaderInfo {
  version: string;
  model: string;
  depth?: string;
  workspace: string;
  branch?: string;
  // Setup or trust is asking: the welcome says who and where, the row stays empty.
  gate?: boolean;
  // The session is up: only then is there a key to hint at.
  connected?: boolean;
  // The welcome block is on screen and already says who and where.
  welcomeInView?: boolean;
}
// ` circle <version> · <model • depth> · <folder> (<branch>)`, the one key hint on the right
// when it fits, and a blank row under it. What gives way first: the hint, then the folder
// (cut from the left, its tail tells folders apart), then the model name.
export function headerRows(info: HeaderInfo, width: number): string[] {
  const p = palette();
  if (info.gate) return ['', ''];
  const model =
    info.depth && (EFFORT_LEVELS as readonly string[]).includes(info.depth)
      ? `${info.model} • ${info.depth}`
      : info.model;
  const head = ` circle ${info.version} · `;
  const path =
    displayPath(info.workspace) + (info.branch ? ` (${info.branch})` : '');
  const hint = '? for shortcuts';
  let room = width - 1;
  const showHint =
    info.connected !== false &&
    width >= 60 &&
    stringWidth(head + model) + 12 + stringWidth(hint) + 2 <= width;
  if (showHint) room -= stringWidth(hint) + 2;
  const leftRoom = room - stringWidth(head);
  let text: string;
  if (leftRoom < 1) text = truncate(head + model, Math.max(1, room));
  else {
    const shown = truncate(model, leftRoom);
    const pathRoom = leftRoom - stringWidth(shown) - 3;
    text =
      pathRoom >= 4
        ? `${head}${shown} · ${truncate(path, pathRoom, true)}`
        : `${head}${shown}`;
  }
  if (info.welcomeInView) text = '';
  const gap = showHint
    ? Math.max(1, width - stringWidth(text) - stringWidth(hint) - 1)
    : 0;
  return [
    p.dim +
      text +
      p.reset +
      (showHint ? ' '.repeat(gap) + p.faint + hint + p.reset + ' ' : ''),
    '',
  ];
}

export interface Meters {
  usage: Usage;
  costText?: string;
  contextInput?: number;
  contextWindow?: number;
}
// `↑ 36.6k · ↓ 560 · $0.0145 · cache 63.7% · ctx 12.5k/1.0M (1%)`, and how full the context
// is: past 70% yellow, past 90% red.
function meterParts(meters: Meters): {
  head: string;
  context: string;
  percent: number;
} {
  const usage = meters.usage;
  const cached = Math.min(usage.cache_read_tokens, usage.input_tokens);
  const rate = usage.input_tokens ? (cached / usage.input_tokens) * 100 : 0;
  const head = [
    `↑ ${formatTokens(usage.input_tokens)} · ↓ ${formatTokens(usage.output_tokens)}`,
    ...(meters.costText ? [meters.costText] : []),
    `cache ${rate.toFixed(1)}%`,
  ].join(' · ');
  if (meters.contextInput === undefined)
    return { head, context: '', percent: 0 };
  if (!meters.contextWindow)
    return {
      head,
      context: `ctx ${formatTokens(meters.contextInput)}/N/A`,
      percent: 0,
    };
  const percent = Math.min(
    999,
    (meters.contextInput / meters.contextWindow) * 100,
  );
  return {
    head,
    context: `ctx ${formatTokens(meters.contextInput)}/${formatWindow(meters.contextWindow)} (${Math.round(percent)}%)`,
    percent,
  };
}
// The footer: the meters, and a flash at the right for a second or two. While a flash shows,
// the meters' tail gives way and they are not coloured.
export function footerRow(
  meters: Meters,
  flash: string,
  width: number,
): string {
  const p = palette();
  const { head, context, percent } = meterParts(meters);
  const plain = context ? `${head} · ${context}` : head;
  if (flash) {
    const shown = truncate(flash, Math.max(1, width - 2));
    const room = width - 1 - stringWidth(shown) - 3;
    if (room < 12) return p.faint + ' ' + shown + p.reset;
    let left = plain;
    while (stringWidth(left) > room)
      left = Array.from(left).slice(0, -1).join('');
    const gap = Math.max(
      1,
      width - 1 - stringWidth(left) - stringWidth(shown) - 1,
    );
    return p.faint + ' ' + left + ' '.repeat(gap) + shown + ' ' + p.reset;
  }
  if (stringWidth(plain) + 1 > width)
    return p.faint + ' ' + truncate(plain, Math.max(1, width - 1)) + p.reset;
  if (!context || percent < 70) return p.faint + ' ' + plain + p.reset;
  return (
    p.faint +
    ' ' +
    head +
    ' · ' +
    p.reset +
    (percent >= 90 ? p.red : p.yellow) +
    context +
    p.reset
  );
}

// Under a turn: its time (without waits on you) and the tokens it sent and received,
// subagents' included: `12s · ↑ 1.2k · ↓ 340`.
export interface TurnUsage {
  seconds: number;
  input: number;
  output: number;
}
export function turnUsageRow(usage: TurnUsage): string {
  const p = palette();
  return `   ${p.dim}${formatElapsed(usage.seconds)} · ↑ ${formatTokens(usage.input)} · ↓ ${formatTokens(usage.output)}${p.reset}`;
}

// The terminal window's title, as pi sets it: `circle - <title> - <folder>`.
export function windowTitle(sessionTitle: string, workspace: string): string {
  const title = sessionTitle === 'new' ? '' : sessionTitle.split('\n')[0]!;
  return [
    'circle',
    Array.from(title).slice(0, 40).join(''),
    basename(workspace),
  ]
    .filter(Boolean)
    .join(' - ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .slice(0, 120);
}
