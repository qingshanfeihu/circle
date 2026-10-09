import { palette, sgrJoin, statusLight } from '../ink/theme.js';
import { wrap, pad, truncate, truncateStyled } from '../ink/string_width.js';
import type { Message, Usage } from '../types.js';
import type { Todo } from '../tools.js';
import { dialogRows, type DialogState } from '../ink/components/dialog_card.js';
import type { Picker } from '../ink/components/picker.js';
import { planRows } from '../ink/components/plan_panel.js';
import type { UserShellView } from '../user_shell.js';
import { elapsed, outputTail, plainJobOutput, type Job } from '../jobs.js';
import type { CompactionProgress } from '../compaction.js';
import type { SubagentView } from './subagents.js';
import { TranscriptFind, highlightMatches } from './transcript_find.js';
import {
  markdownRows,
  terminalText,
} from '../ink/components/markdown_renderer.js';
import { loopFrame } from '../ink/components/loop_frame.js';
import {
  busyLabel,
  footerRow,
  headerRows,
  turnUsageRow,
  type TurnUsage,
} from './status_rows.js';
import { agentRows, jobRows, stripHeader, AGENT_ROWS } from './strip_rows.js';
import {
  HIDDEN_TOOLS,
  resultRows,
  thinkingRows,
  tintedRow,
  toolRow,
  toolTint,
} from './tool_rows.js';
export interface ScreenState {
  messages: Message[];
  notices: string[];
  welcome: string[];
  draft: string;
  draftCursor: number;
  model: string;
  workspace: string;
  version: string;
  busy: boolean;
  waiting: boolean;
  planMode: boolean;
  autoMode: boolean;
  todos: Todo[];
  planStart?: number;
  queue?: { steering: string[]; followUp: string[] };
  userShells?: UserShellView[];
  showThinking: boolean;
  showTools: boolean;
  streaming: string;
  thinking: string;
  usage: Usage;
  flash: string;
  started: number;
  scroll: number;
  dialog?: DialogState;
  picker?: Picker;
  hiddenTurns: number;
  jobs?: Job[];
  jobDetail?: Job;
  compaction?: CompactionProgress;
  contextInput?: number;
  contextWindow?: number;
  costText?: string;
  subagents?: SubagentView[];
  selectedAgent?: string;
  agentDetail?: SubagentView;
  find?: TranscriptFind;
  historySearch?: { query: string; match: boolean };
  renderToolResult?: (message: Message) => string[] | undefined;
  // ctrl+t: thinking rows show their text; otherwise they are one folded row each.
  thinkingExpanded?: boolean;
  // How long each answer's thinking took, by message id, and the one streaming now.
  thinkingSeconds?: Record<string, number>;
  liveThinkingSeconds?: number;
  // The line under each finished turn, by the id of the turn's last message.
  turnUsage?: Record<string, TurnUsage>;
  // The busy word for this turn and the tokens the turn has written so far.
  busyVerb?: string;
  busyTokens?: number;
  // The header: thinking depth, the folder's git branch, and whether setup or trust is
  // asking (`gate`) or the session is up (`connected`).
  thinkingDepth?: string;
  branch?: string;
  gate?: boolean;
  connected?: boolean;
}
// Blocks are separated by exactly one blank row; inside a block there is none. An answer is
// its thinking rows plus the text after them, a tool group is consecutive tool rows.
const CONTINUES: Record<string, string[]> = {
  text: ['thinking'],
  thinking: ['thinking'],
  tool: ['tool'],
};
export function transcriptRows(state: ScreenState, width: number): string[] {
  const p = palette();
  const rows: string[] = [...state.welcome];
  let lastKind = 'welcome';
  const gap = (kind: string): void => {
    if (
      rows.length &&
      rows.at(-1) !== '' &&
      !(CONTINUES[kind] ?? []).includes(lastKind)
    )
      rows.push('');
    lastKind = kind;
  };
  let messages = state.messages.filter(
    (message) => !message.internal || message.internal === 'job_notice',
  );
  let hide = state.hiddenTurns;
  while (hide-- > 0) {
    let index = messages.length - 1;
    while (index >= 0 && messages[index]!.role !== 'user') index--;
    messages = messages.slice(0, Math.max(0, index));
  }
  const block = (
    marker: string,
    content: string,
    style = '',
    base = p.text,
    markdown = false,
    kind = 'other',
  ): void => {
    gap(kind);
    const lines = markdown
      ? markdownRows(content, width - 3, { base, background: style })
      : wrap(terminalText(content), width - 3);
    rows.push(
      ...lines.map(
        (line, index) =>
          sgrJoin(style, base) +
          pad((index === 0 ? ' ' + marker + ' ' : '   ') + line, width) +
          p.reset,
      ),
    );
  };
  // Your words: the blue `›` in the marker column, the words emphasised.
  const user = (content: string): void => {
    gap('user');
    wrap(terminalText(content), width - 3).forEach((line, index) =>
      rows.push(
        (index === 0 ? ` ${p.blue}›${p.reset} ` : '   ') +
          p.em +
          line +
          p.reset,
      ),
    );
  };
  const thinking = (text: string, done: boolean, seconds?: number): void => {
    if (!state.showThinking || !text.trim()) return;
    gap('thinking');
    rows.push(
      ...thinkingRows(text, {
        done,
        seconds,
        expanded: Boolean(state.thinkingExpanded),
        width,
      }),
    );
  };
  const shellRows = (shell: {
    command: string;
    output: string;
    exitCode?: number;
    status: UserShellView['status'];
    quiet?: boolean;
  }): void => {
    block('›', (shell.quiet ? '!!' : '!') + shell.command, '', p.blue);
    block(
      statusLight(
        shell.status === 'running'
          ? 'running'
          : shell.status === 'done'
            ? 'ok'
            : shell.status === 'error'
              ? 'error'
              : 'none',
      ),
      `execute(${shell.command})${shell.exitCode !== undefined ? ` · exit ${shell.exitCode}` : ''}${shell.status === 'background' ? ' · background' : ''}`,
      p.write_bg,
    );
    const lines = wrap(terminalText(shell.output), width - 5);
    for (const line of state.showTools ? lines : lines.slice(0, 3))
      rows.push('   ' + p.dim + '⎿ ' + line + p.reset);
    if (!state.showTools && lines.length > 3)
      rows.push(p.faint + `… +${lines.length - 3} lines · ctrl+o` + p.reset);
  };
  const localShells = state.agentDetail ? [] : (state.userShells ?? []);
  const localIds = new Set(
    localShells.map((shell) => shell.persistedMessageId),
  );
  for (const shell of localShells.filter((shell) => !shell.anchor))
    shellRows(shell);
  for (const message of messages) {
    if (message.shell) {
      if (!localIds.has(message.id))
        shellRows({
          command: message.shell.command,
          output: message.shell.output,
          exitCode: message.shell.exit_code,
          status: message.shell.exit_code === 0 ? 'done' : 'error',
        });
      for (const shell of localShells.filter(
        (shell) => shell.anchor === message.id,
      ))
        shellRows(shell);
      continue;
    }
    if (message.internal === 'job_notice')
      block(
        '◆',
        plainJobOutput(message.display ?? '').replace(/^◆ /gm, ''),
        '',
        / failed · /.test(message.display ?? '')
          ? p.red
          : / done · /.test(message.display ?? '')
            ? p.green
            : p.dim,
      );
    else if (message.role === 'user') user(message.display ?? message.content);
    else if (message.role === 'assistant') {
      if (message.thinking)
        thinking(message.thinking, true, state.thinkingSeconds?.[message.id]);
      if (message.content.trim())
        block('⏺', message.content, '', p.text, true, 'text');
      // Calls run one after another: the first without a result is the one running (or
      // waiting on you), the ones after it have not started.
      let first = true;
      for (const call of message.tool_calls ?? []) {
        const result = messages.find(
          (message) =>
            message.role === 'tool' && message.tool_call_id === call.id,
        );
        const pending =
          result ||
          (state.agentDetail &&
            !['running', 'waiting'].includes(state.agentDetail.state))
            ? 'none'
            : !first
              ? 'none'
              : state.waiting
                ? 'wait'
                : 'running';
        if (!result) first = false;
        if (HIDDEN_TOOLS.has(call.name)) continue;
        gap('tool');
        rows.push(toolRow(call, result, { width, pending }));
        if (!result) continue;
        const custom = state.renderToolResult?.(result);
        if (custom)
          for (const row of custom)
            rows.push(tintedRow([['', row]], toolTint(call.name), width));
        else
          rows.push(
            ...resultRows(call, result, { width, expanded: state.showTools }),
          );
      }
    } else if (message.role === 'tool') {
      // A result whose call is not in view (the turn was cut short of it).
      const called = messages.some((other) =>
        other.tool_calls?.some((call) => call.id === message.tool_call_id),
      );
      if (!called && !HIDDEN_TOOLS.has(message.name ?? '')) {
        const call = {
          id: message.tool_call_id ?? '',
          name: message.name ?? 'tool',
          args: {},
        };
        gap('tool');
        rows.push(toolRow(call, message, { width }));
        rows.push(
          ...resultRows(call, message, { width, expanded: state.showTools }),
        );
      }
    }
    for (const shell of localShells.filter(
      (shell) => shell.anchor === message.id,
    ))
      shellRows(shell);
    const usage = state.turnUsage?.[message.id];
    if (usage) {
      rows.push(turnUsageRow(usage));
      lastKind = 'usage';
    }
  }
  if (state.thinking)
    thinking(
      state.thinking,
      Boolean(state.streaming),
      state.liveThinkingSeconds,
    );
  if (state.streaming.trim())
    block('⏺', state.streaming, '', p.text, true, 'text');
  for (const note of state.notices)
    block(
      note.startsWith('✖') ? '✖' : ' ',
      note.replace(/^✖\s*/, ''),
      '',
      note.startsWith('✖') ? p.red : p.dim,
    );
  if (rows.length && rows.at(-1) !== '') rows.push('');
  return rows;
}
// The strip under the footer: the turn's subagents (and the one selected or open), then the
// background jobs that are still running.
function stripRows(
  state: ScreenState,
  width: number,
  height: number,
): string[] {
  const running = (agent: SubagentView): boolean =>
    ['running', 'waiting'].includes(agent.state);
  const selected = state.agentDetail?.id ?? state.selectedAgent;
  const agents = (state.subagents ?? []).filter(
    (agent) => (!agent.background && running(agent)) || agent.id === selected,
  );
  const jobs = (state.jobs ?? []).filter((job) => job.status === 'running');
  if (!agents.length && !jobs.length) return [];
  const now = Date.now();
  const most = Math.min(AGENT_ROWS, Math.max(1, Math.floor((height - 8) / 3)));
  const at = Math.max(
    0,
    agents.findIndex((agent) => agent.id === selected),
  );
  const start =
    agents.length <= most
      ? 0
      : Math.min(Math.max(0, at - most + 1), agents.length - most);
  const visible = agents.slice(start, start + most);
  const rows = [stripHeader(agents.filter(running).length, jobs.length, width)];
  rows.push(
    ...agentRows(visible, {
      width,
      selected,
      hidden: agents.length - visible.length,
      now,
    }),
  );
  rows.push(
    ...jobRows(jobs, {
      width,
      now,
      max: Math.floor(
        (height - rows.length - (state.todos.length ? 14 : 8)) / 2,
      ),
    }),
  );
  return rows;
}
export function renderScreen(
  state: ScreenState,
  width: number,
  height: number,
): string[] {
  width = Math.max(12, width);
  height = Math.max(8, height);
  const p = palette();
  const bottom: string[] = [];
  if (state.picker)
    bottom.push(
      ...state.picker.rows(width, Math.max(3, Math.floor(height / 3))),
    );
  const strip = stripRows(state, width, height);
  if (!state.dialog && state.todos.length) {
    bottom.push(...planRows(state.todos, width, state.planStart));
  }
  if (!state.dialog && state.queue) {
    const queued = [
      ...state.queue.steering.map((text) => `steering: ${text}`),
      ...state.queue.followUp.map((text) => `follow-up: ${text}`),
    ];
    const maximum = Math.max(1, Math.floor(height / 4));
    for (const text of queued.slice(0, maximum))
      bottom.push(
        p.faint +
          pad(
            truncate(' ' + terminalText(text).replace(/\s+/g, ' '), width),
            width,
          ) +
          p.reset,
      );
    if (queued.length > maximum)
      bottom.push(
        p.faint +
          ` +${queued.length - maximum} queued · alt+up edits all` +
          p.reset,
      );
  }
  if (state.dialog)
    bottom.push(
      ...dialogRows(
        state.dialog,
        width,
        Math.max(5, height - 4 - strip.length),
      ),
    );
  else {
    // The frame says whose turn it is: the rainbow runs while the model works.
    const seconds = (Date.now() - state.started) / 1000;
    const label = state.compaction
      ? state.compaction.row(width)
      : state.busy
        ? busyLabel(state.busyVerb ?? 'Brewing', seconds, state.busyTokens ?? 0)
        : '';
    const frame = loopFrame(width, {
      elapsed: state.busy ? seconds : undefined,
      label,
      mode: state.planMode ? 'read-only' : state.autoMode ? 'auto' : '',
      modeSgr: state.planMode ? p.green : p.yellow,
    });
    bottom.push(frame.top);
    const draft = Array.from(state.draft);
    draft.splice(state.draftCursor, 0, '▏');
    const draftRows = wrap(draft.join(''), width - 4);
    const maxRows = Math.max(1, Math.floor(height * 0.3));
    for (const [index, line] of draftRows.slice(-maxRows).entries())
      bottom.push(
        frame.left +
          p.text +
          pad((index === 0 ? ' › ' : '   ') + line, width - 2) +
          p.reset +
          frame.right,
      );
    bottom.push(frame.bottom);
  }
  const searchStatus =
    state.find?.status ??
    (state.historySearch
      ? `reverse-i-search: ${state.historySearch.query}▏${state.historySearch.match ? '' : ' · no matches'}`
      : undefined);
  if (searchStatus)
    bottom.push(p.dim + pad(truncate(searchStatus, width), width) + p.reset);
  // No meters before a session is connected.
  if (state.connected !== false)
    bottom.push(
      footerRow(
        {
          usage: state.usage,
          costText: state.costText,
          contextInput: state.contextInput,
          contextWindow: state.contextWindow,
        },
        state.flash,
        width,
      ),
    );
  bottom.push(...strip);
  let transcript = transcriptRows(state, width);
  if (state.agentDetail) {
    const agent = state.agentDetail;
    transcript = [
      p.dim +
        ` ${agent.name} · ${agent.state} · esc back · ←/→ previous/next` +
        p.reset,
      ...transcriptRows(
        {
          ...state,
          messages: agent.messages,
          agentDetail: agent,
          welcome: [],
          notices: [],
          streaming: '',
          thinking: '',
          hiddenTurns: 0,
        },
        width,
      ),
    ];
  }
  if (state.jobDetail) {
    const job = state.jobDetail;
    let output = '';
    try {
      output = outputTail(job.outputPath, 64_000, Math.max(20, height * 2));
    } catch {
      output = 'Output is unavailable.';
    }
    transcript = [
      p.text +
        ` ${job.id} · ${job.status} · ${plainJobOutput(job.title)}` +
        p.reset,
      p.faint +
        ` ${job.virtualPath} · ${elapsed(job)} · esc back · ctrl+d ${job.status === 'running' ? 'stop' : 'remove'}` +
        p.reset,
      '',
      ...wrap(plainJobOutput(output), width).map(
        (row) => p.dim + row + p.reset,
      ),
    ];
  }
  const available = Math.max(1, height - bottom.length - 2);
  state.find?.updateRows(transcript);
  const end =
    state.find?.row !== undefined
      ? Math.min(
          transcript.length,
          state.find.row + Math.max(1, Math.floor((available * 2) / 3)),
        )
      : Math.max(available, transcript.length - state.scroll);
  if (state.find?.query)
    transcript = transcript.map((row, index) =>
      index === state.find!.row
        ? highlightMatches(row, state.find!.query)
        : row,
    );
  const start = Math.max(0, end - available);
  // While the welcome is on screen it says who and where; the header hands off to it.
  const rows = headerRows(
    {
      version: state.version,
      model: state.model,
      depth: state.thinkingDepth,
      workspace: state.workspace,
      branch: state.branch,
      gate: state.gate,
      connected: state.connected,
      welcomeInView:
        !state.agentDetail &&
        !state.jobDetail &&
        state.welcome.length > 0 &&
        start < state.welcome.length,
    },
    width,
  );
  rows.push(...transcript.slice(start, end));
  while (rows.length < height - bottom.length) rows.push('');
  rows.push(...bottom);
  // A row never runs past the edge: on a very narrow screen even a status row is cut.
  return rows
    .slice(-height)
    .map((row) => pad(truncateStyled(row, width), width));
}
