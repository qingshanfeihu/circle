// A subagent in the conversation and on its own page (ported from transcript_view.py's
// subagent lines and agent_detail.py). Under its `Agent(…)` row: one faint line with its
// type, calls, time and tokens and, while it runs, its last three calls; ctrl+o lists them
// all. Its page: a band on the panel background (lamp, name, position among its siblings,
// status, calls, tokens, time, and the text buttons `main · prev · next`), then its record
// top to bottom: a row per call with the first line it returned, each round's reasoning
// where it happened, and how it ended. Colours come from the palette at every paint.
import { lampSgr, palette, sgrJoin, type LampState } from '../ink/theme.js';
import { stringWidth, truncate, wrap } from '../ink/string_width.js';
import {
  markdownRows,
  terminalText,
} from '../ink/components/markdown_renderer.js';
import type { Message, ToolCall } from '../types.js';
import { toolArgSummary, toolShortName } from './display_lexicon.js';
import { formatElapsed, formatTokens } from './status_rows.js';
import { agentName, agentSeconds } from './strip_rows.js';
import type { SubagentView } from './subagents.js';
import {
  fitSummary,
  reasoningSummary,
  tintedRow,
  toolTint,
} from './tool_rows.js';

export const SUBAGENT_RECENT_CALLS = 3;
export const NO_STEPS = 'No tool calls yet';

export type AgentStep =
  | {
      kind: 'tool';
      call: ToolCall;
      result?: Message;
      status: 'running' | 'ok' | 'error';
      recoverable: boolean;
    }
  | { kind: 'thinking'; id: string; text: string };

type ToolStep = Extract<AgentStep, { kind: 'tool' }>;

export function agentRunning(agent: SubagentView): boolean {
  return agent.state === 'running' || agent.state === 'waiting';
}

// The calls it made, in order, and its reasoning before each round's calls. Calls run one
// after another: the first without a result is the one running (or, once the agent has
// ended, the one that failed), and the ones after it never started.
export function agentSteps(agent: SubagentView): AgentStep[] {
  const results = new Map<string, Message>();
  for (const message of agent.messages)
    if (message.role === 'tool' && message.tool_call_id)
      results.set(message.tool_call_id, message);
  const running = agentRunning(agent);
  const steps: AgentStep[] = [];
  let open = false;
  for (const message of agent.messages) {
    if (message.role !== 'assistant') continue;
    if (message.thinking?.trim())
      steps.push({ kind: 'thinking', id: message.id, text: message.thinking });
    for (const call of message.tool_calls ?? []) {
      const result = results.get(call.id);
      if (result) {
        const error = result.status === 'error';
        steps.push({
          kind: 'tool',
          call,
          result,
          status: error ? 'error' : 'ok',
          recoverable: error && Boolean(result.recoverable),
        });
      } else if (!open) {
        open = true;
        steps.push({
          kind: 'tool',
          call,
          status: running ? 'running' : 'error',
          recoverable: false,
        });
      }
    }
  }
  return steps;
}

function toolSteps(agent: SubagentView): ToolStep[] {
  return agentSteps(agent).filter(
    (step): step is ToolStep => step.kind === 'tool',
  );
}

// The task each `task` call in `messages` started, by call id: the subagent sessions are
// made in the order of the calls and named `<type>: <description>`.
export function taskAgents(
  messages: Message[],
  agents: SubagentView[],
): Map<string, SubagentView> {
  const found = new Map<string, SubagentView>();
  const taken = new Set<string>();
  for (const message of messages)
    for (const call of message.tool_calls ?? []) {
      if (call.name !== 'task') continue;
      const type = String(call.args.subagent_type || 'general-purpose');
      const description = String(call.args.description || '');
      const title = `${type}: ${description}`.slice(0, 160);
      const agent = agents.find(
        (agent) => !taken.has(agent.id) && agent.description === title,
      );
      if (!agent) continue;
      taken.add(agent.id);
      found.set(call.id, agent);
    }
  return found;
}

// A call as `{lamp} Short(summary)`; a mistake the model can fix is unlit and struck through.
function callSegments(
  step: ToolStep,
  width: number,
  now: number,
): [string, string][] {
  const p = palette();
  const name = toolShortName(step.call.name);
  const text = `${name}(${fitSummary(name, toolArgSummary(step.call), width)})`;
  if (step.status === 'error' && step.recoverable)
    return [
      ['', '  '],
      [p.muted_strike, text],
    ];
  const light = lampSgr(step.status, now);
  return [
    [light, '●'],
    ['', ' '],
    [p.text, text],
  ];
}

// Under a subagent's `Agent(…)` row, on the agent tint: `⎿ general-purpose · 4 calls · 12s ·
// 3.1k tokens`, and while it runs its last calls (`… +N earlier · ctrl+o` for the rest);
// ctrl+o shows every call.
export function taskSummaryRows(
  agent: SubagentView,
  options: { width: number; expanded: boolean; now?: number },
): string[] {
  const p = palette();
  const now = options.now ?? Date.now();
  const width = options.width;
  const bg = p.agent_bg;
  const calls = toolSteps(agent);
  let meta = `${agent.name} · ${calls.length} calls · ${formatElapsed(agentSeconds(agent, now))} · ${formatTokens(agent.tokens)} tokens`;
  if (agent.state === 'waiting') meta += ' · waiting for you';
  const rows = [
    tintedRow(
      [
        ['', '   ⎿ '],
        [p.faint, truncate(meta, Math.max(1, width - 6))],
      ],
      bg,
      width,
    ),
  ];
  const shown = options.expanded
    ? calls
    : agentRunning(agent)
      ? calls.slice(-SUBAGENT_RECENT_CALLS)
      : [];
  if (shown.length && calls.length > shown.length)
    rows.push(
      tintedRow(
        [
          ['', '     '],
          [p.faint, `… +${calls.length - shown.length} earlier · ctrl+o`],
        ],
        bg,
        width,
      ),
    );
  for (const step of shown)
    rows.push(
      tintedRow(
        [['', '     '], ...callSegments(step, width - 5, now)],
        bg,
        width,
      ),
    );
  return rows;
}

// `waiting for you` (cyan), `running` (yellow), `done` (green), `failed` / `interrupted` (red).
function statusWord(agent: SubagentView): string {
  return agent.state === 'waiting'
    ? 'waiting for you'
    : agent.state === 'done'
      ? 'done'
      : agent.state === 'error'
        ? 'failed'
        : agent.state;
}
function statusColour(agent: SubagentView): string {
  const p = palette();
  return agent.state === 'waiting'
    ? p.blue
    : agent.state === 'running'
      ? p.yellow
      : agent.state === 'done'
        ? p.green
        : p.red;
}
function agentLamp(agent: SubagentView): LampState {
  return agent.state === 'waiting'
    ? 'wait'
    : agent.state === 'running'
      ? 'running'
      : agent.state === 'done'
        ? 'ok'
        : 'error';
}

export type BandAction = 'back' | 'prev' | 'next';
export const BAND_BUTTONS: [BandAction, string][] = [
  ['back', 'main'],
  ['prev', 'prev'],
  ['next', 'next'],
];
export interface DetailBand {
  rows: string[];
  // Each button's columns on the band's row: [start, end) and what it does.
  spans: [number, number, BandAction][];
}

// The page's band: identity on the left, the text buttons on the right. On a narrow screen
// the identity drops segments from its end; the buttons stay, they are the mouse's way out.
export function detailBand(
  agent: SubagentView,
  options: { index: number; total: number; width: number; now?: number },
): DetailBand {
  const p = palette();
  const now = options.now ?? Date.now();
  const inner = Math.max(20, options.width);
  const segments: [string, string][] = [
    [agentName(agent), p.em],
    [` (${options.index} of ${options.total})`, p.dim],
    [` · ${statusWord(agent)}`, statusColour(agent)],
    [` · ${toolSteps(agent).length} calls`, p.dim],
    [` · ↑${formatTokens(agent.tokens)}`, p.dim],
    [` · ${formatElapsed(agentSeconds(agent, now))}`, p.dim],
  ];
  const buttonsWidth =
    stringWidth(BAND_BUTTONS.map(([, text]) => ` ${text} `).join('  ')) + 1;
  const lead = 3; // ` ● `: the lamp sits in marker column 1
  const used = (count: number): number =>
    segments
      .slice(0, count)
      .reduce((sum, [text]) => sum + stringWidth(text), 0);
  let keep = segments.length;
  while (keep > 1 && lead + used(keep) + 1 + buttonsWidth > inner) keep--;
  const room = inner - lead - 1 - buttonsWidth;
  if (keep === 1 && stringWidth(segments[0]![0]) > room)
    segments[0] = [truncate(segments[0]![0], Math.max(1, room)), p.em];
  const left = used(keep);
  const showButtons = lead + left + 1 + buttonsWidth <= inner;
  const gap = Math.max(
    1,
    inner - lead - left - (showButtons ? buttonsWidth : 0),
  );
  const onPanel = sgrJoin(p.panel_bg, p.dim);
  const light = lampSgr(agentLamp(agent), now);
  let body =
    onPanel +
    ' ' +
    sgrJoin(p.panel_bg, light) +
    '●' +
    onPanel +
    ' ' +
    segments
      .slice(0, keep)
      .map(([text, sgr]) => sgrJoin(p.panel_bg, sgr) + text)
      .join('') +
    onPanel +
    ' '.repeat(gap);
  const spans: DetailBand['spans'] = [];
  if (showButtons) {
    let cursor = lead + left + gap;
    body +=
      BAND_BUTTONS.map(([action, text]) => {
        const label = ` ${text} `;
        spans.push([cursor, cursor + stringWidth(label), action]);
        cursor += stringWidth(label) + 2;
        return sgrJoin(p.panel_bg, p.text) + label;
      }).join(onPanel + '  ') +
      onPanel +
      ' ';
  }
  return { rows: [body + p.reset], spans };
}

function clip(text: string, width: number): string {
  const plain = terminalText(text).split(/\s+/).filter(Boolean).join(' ');
  const chars = Array.from(plain);
  return chars.length <= width
    ? plain
    : chars.slice(0, width - 1).join('') + '…';
}
function formatChars(count: number): string {
  return count >= 1000
    ? `${(count / 1000).toFixed(1)}k chars`
    : `${count} chars`;
}

// A call on the page: its row and the first line of what came back (`returned` for nothing).
function callLine(step: ToolStep, width: number, now: number): string {
  const p = palette();
  const segments: [string, string][] = [
    ['', ' '],
    ...callSegments(step, width - 1, now),
  ];
  if (step.status !== 'running') {
    const first =
      terminalText(step.result?.content ?? '')
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ?? '';
    const summary = clip(first.replace(/^[✓✗❌✖●]\s*/u, ''), 120);
    const room =
      width - segments.reduce((sum, [, text]) => sum + stringWidth(text), 0);
    if (room > 2 && (summary || !step.recoverable))
      segments.push(
        ['', ' '],
        [
          step.recoverable ? p.muted_strike : p.dim,
          truncate(summary || 'returned', room - 1),
        ],
      );
  }
  return tintedRow(segments, toolTint(step.call.name), width);
}

// A round's reasoning on the terminal background, same colours as a thought in the
// transcript: `⎿ ∴ Thought 2s · title · 1.2k chars  ctrl+t`, and its text under it once
// ctrl+t shows it.
function thinkingLines(
  step: Extract<AgentStep, { kind: 'thinking' }>,
  options: { width: number; expanded: boolean; seconds?: number },
): string[] {
  const p = palette();
  const { title, body } = reasoningSummary(step.text);
  let header = '∴ Thought';
  if (options.seconds !== undefined)
    header += ` ${formatElapsed(options.seconds)}`;
  if (title) header += ` · ${clip(title, 120)}`;
  header += ` · ${formatChars(Array.from(step.text.trim()).length)}`;
  const style = sgrJoin(options.expanded ? p.reason_dim : p.reason, '\x1b[3m');
  const head: [string, string][] = [
    ['', ' '],
    [style, truncate(`⎿ ${header}`, Math.max(1, options.width - 10))],
  ];
  if (body && !options.expanded) head.push(['', '  '], [p.faint, 'ctrl+t']);
  const rows = [tintedRow(head, '', options.width)];
  if (options.expanded && body)
    for (const line of markdownRows(body, Math.max(20, options.width - 3), {
      base: p.faint,
    }))
      rows.push(tintedRow([[p.faint, '   ' + line]], '', options.width));
  return rows;
}

// The page under the band: the task it was given, its record, and how it ended.
export function detailRows(
  agent: SubagentView,
  options: {
    width: number;
    expanded: boolean;
    now?: number;
    thinkingSeconds?: Record<string, number>;
    // What the task call returned: its first line is the result's summary.
    result?: string;
  },
): string[] {
  const p = palette();
  const now = options.now ?? Date.now();
  const width = Math.max(20, options.width);
  const rows: string[] = [];
  const prefix = `${agent.name}: `;
  const task = clip(
    agent.description.startsWith(prefix)
      ? agent.description.slice(prefix.length)
      : agent.description,
    400,
  );
  if (task)
    for (const line of wrap(`Task · ${task}`, width - 2))
      rows.push(` ${p.faint}${line}${p.reset}`);
  rows.push('');
  let calls = 0;
  let thinking = 0;
  for (const step of agentSteps(agent)) {
    if (step.kind === 'tool') {
      rows.push(callLine(step, width, now));
      calls++;
    } else {
      rows.push(
        ...thinkingLines(step, {
          width,
          expanded: options.expanded,
          seconds: options.thinkingSeconds?.[step.id],
        }),
      );
      thinking++;
    }
  }
  if (!calls && !thinking) rows.push(` ${p.dim}${NO_STEPS}${p.reset}`);
  rows.push('');
  let facts =
    `${calls} tool calls` + (thinking ? ` · ${thinking} thinking` : '');
  const running = agentRunning(agent);
  if (running)
    facts += ` · ${formatElapsed((now - (agent.updated ?? agent.started)) / 1000)} since the last event`;
  rows.push(` ${p.faint}${truncate(facts, width - 2)}${p.reset}`);
  if (!running) {
    rows.push(
      ` ${p.dim}${truncate(`Result · ${statusWord(agent)} · ${calls} calls · ↑${formatTokens(agent.tokens)} · ${formatElapsed(agentSeconds(agent, now))}`, width - 2)}${p.reset}`,
    );
    const answer =
      options.result ??
      [...agent.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'assistant' && !message.tool_calls?.length,
        )?.content ??
      '';
    const summary = clip(
      terminalText(answer)
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ?? '',
      200,
    );
    if (summary)
      rows.push(
        `    ⎿ ${p.faint}${truncate(summary, Math.max(1, width - 7))}${p.reset}`,
      );
  }
  return rows;
}
