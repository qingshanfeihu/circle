import { palette, sgrJoin, statusLight } from '../ink/theme.js';
import { wrap, pad, truncate, truncateStyled } from '../ink/string_width.js';
import type { Message, Usage } from '../types.js';
import type { Todo } from '../tools.js';
import { dialogRows, type DialogState } from '../ink/components/dialog_card.js';
import type { Picker } from '../ink/components/picker.js';
import { planRows } from '../ink/components/plan_panel.js';
import type { UserShellView } from '../user_shell.js';
import { outputTail, plainJobOutput, type Job } from '../jobs.js';
import type { CompactionProgress } from '../compaction.js';
import type { SubagentView } from './subagents.js';
import { TranscriptFind, highlightMatches } from './transcript_find.js';
import {
  markdownRows,
  terminalText,
} from '../ink/components/markdown_renderer.js';
import {
  completionRows,
  draftCursor,
  draftLines,
  type Completion,
} from './composer.js';
import { loopFrame } from '../ink/components/loop_frame.js';
import {
  busyLabel,
  compactionRow,
  footerRow,
  headerRows,
  turnUsageRow,
  type TurnUsage,
} from './status_rows.js';
import {
  agentRows,
  jobBand,
  jobRows,
  stripHeader,
  AGENT_ROWS,
} from './strip_rows.js';
import {
  extensionRows,
  HIDDEN_TOOLS,
  backgroundJob,
  noticeRows,
  resultRows,
  thinkingRows,
  toolRow,
} from './tool_rows.js';
import {
  detailBand,
  detailRows,
  taskAgents,
  taskSummaryRows,
  type DetailBand,
} from './agent_rows.js';
export interface ScreenState {
  messages: Message[];
  notices: string[];
  welcome: string[];
  draft: string;
  draftCursor: number;
  draftTop?: number;
  completion?: Completion;
  /** Written by renderScreen: the conversation's rows in view, and how far up it scrolls. */
  view?: { rows: number; maxScroll: number };
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
  /** Set by renderScreen: the transcript's screen rows and its first row shown. */
  viewport?: { top: number; height: number; first: number; total: number };
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
  /** Set by renderScreen: the screen row of a subagent page's band and its buttons. */
  pageButtons?: { row: number; spans: DetailBand['spans'] };
  /** Set by renderScreen: the screen row of the strip's first subagent row, and the
   * subagents its rows show, top to bottom. */
  stripAgents?: { row: number; ids: string[] };
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
  const agents = taskAgents(messages, state.subagents ?? []);
  // The reply a running turn is working on: the newest one with tool calls.
  const newestReply = messages.findLast(
    (message) => message.role === 'assistant' && message.tool_calls?.length,
  );
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
    if (message.internal === 'job_notice') {
      gap('notice');
      rows.push(...noticeRows(message.display ?? '', width));
    } else if (message.role === 'user')
      user(message.display ?? message.content);
    else if (message.role === 'assistant') {
      if (message.thinking)
        thinking(message.thinking, true, state.thinkingSeconds?.[message.id]);
      if (message.content.trim())
        block('⏺', message.content, '', p.text, true, 'text');
      // Calls run one after another: the first without a result is the one running (or
      // waiting on you), the ones after it have not started. Task calls next to each other
      // run together: each is running (or waiting) from its subagent until its result is in.
      let first = true;
      for (const call of message.tool_calls ?? []) {
        const result = messages.find(
          (message) =>
            message.role === 'tool' && message.tool_call_id === call.id,
        );
        // A call left without a result by a turn that has ended (interrupted, or a
        // session from an older version) is not running: its lamp stays unlit.
        const live = state.agentDetail
          ? ['running', 'waiting'].includes(state.agentDetail.state)
          : (state.busy || state.waiting) && message === newestReply;
        // A subagent folded under its row; one in the background is a job instead.
        const agent = agents.get(call.id);
        const together = agent && call.args.background !== true;
        const pending =
          result || !live
            ? 'none'
            : together
              ? agent.state === 'waiting'
                ? 'wait'
                : 'running'
              : !first
                ? 'none'
                : state.waiting
                  ? 'wait'
                  : 'running';
        if (!result) first = false;
        if (HIDDEN_TOOLS.has(call.name)) continue;
        gap('tool');
        rows.push(toolRow(call, result, { width, pending }));
        if (together)
          rows.push(
            ...taskSummaryRows(agent, { width, expanded: state.showTools }),
          );
        if (!result) continue;
        rows.push(
          ...(extensionRows(state.renderToolResult?.(result), call, {
            width,
            expanded: state.showTools,
          }) ?? resultRows(call, result, { width, expanded: state.showTools })),
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
// background jobs that are still running; `ids` are the subagents its rows show.
function stripRows(
  state: ScreenState,
  width: number,
  height: number,
): { rows: string[]; ids: string[] } {
  const running = (agent: SubagentView): boolean =>
    ['running', 'waiting'].includes(agent.state);
  const selected = state.agentDetail?.id ?? state.selectedAgent;
  const agents = (state.subagents ?? []).filter(
    (agent) => (!agent.background && running(agent)) || agent.id === selected,
  );
  const jobs = (state.jobs ?? []).filter((job) => job.status === 'running');
  if (!agents.length && !jobs.length) return { rows: [], ids: [] };
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
  return { rows, ids: visible.map((agent) => agent.id) };
}
export interface ScreenCursor {
  /** 1-based screen row and column. */
  row: number;
  col: number;
}
export function renderScreen(
  state: ScreenState,
  width: number,
  height: number,
  cursor?: { value?: ScreenCursor },
): string[] {
  width = Math.max(12, width);
  height = Math.max(8, height);
  const p = palette();
  const bottom: string[] = [];
  let cursorInBottom: { index: number; col: number } | undefined;
  if (state.picker)
    bottom.push(
      ...state.picker.rows(width, Math.max(3, Math.floor(height / 3))),
    );
  const { rows: strip, ids: stripIds } = stripRows(state, width, height);
  if (!state.dialog && state.todos.length) {
    bottom.push(
      ...planRows(
        state.todos,
        width,
        state.planStart,
        state.waiting ? 'wait' : state.busy ? 'running' : 'idle',
      ),
    );
  }
  // Above the input box: the compaction under way, then the messages waiting to be read.
  if (state.compaction) bottom.push(compactionRow(state.compaction, width));
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
  const mode = state.planMode ? 'read-only' : state.autoMode ? 'auto' : '';
  const modeSgr = state.planMode ? p.green : p.yellow;
  if (state.dialog)
    bottom.push(
      ...dialogRows(
        state.dialog,
        width,
        Math.max(5, height - 4 - strip.length),
        { word: mode, sgr: modeSgr },
      ),
    );
  else {
    // The frame says whose turn it is: the rainbow runs while the model works.
    const seconds = (Date.now() - state.started) / 1000;
    const label = state.busy
      ? busyLabel(state.busyVerb ?? 'Brewing', seconds, state.busyTokens ?? 0)
      : '';
    if (state.completion && !state.picker)
      bottom.push(...completionRows(state.completion, width));
    const frame = loopFrame(width, {
      elapsed: state.busy ? seconds : undefined,
      label,
      mode,
      modeSgr,
    });
    bottom.push(frame.top);
    const draftStart = bottom.length;
    for (const line of draftLines(state, width, height))
      bottom.push(
        frame.left + p.text + pad(line, width - 2) + p.reset + frame.right,
      );
    bottom.push(frame.bottom);
    // The real cursor parks on the composer's own: the IME anchors its candidates there.
    if (cursor) {
      const at = draftCursor(state, width, height);
      cursorInBottom = {
        index: draftStart + at.row,
        col: at.col + 2, // the frame's left border, then the cell within the line; 1-based
      };
    }
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
  let transcript: string[];
  // A subagent's page: its band stays under the header, its record scrolls under the band.
  let band: DetailBand | undefined;
  if (state.agentDetail) {
    const agent = state.agentDetail;
    const all = state.subagents ?? [];
    band = detailBand(agent, {
      index:
        Math.max(
          0,
          all.findIndex((other) => other.id === agent.id),
        ) + 1,
      total: Math.max(1, all.length),
      width,
    });
    // What its task call returned, unless the task went on in the background.
    let result: string | undefined;
    for (const [id, found] of taskAgents(state.messages, all))
      if (found.id === agent.id)
        result = state.messages.find(
          (message) =>
            message.role === 'tool' &&
            message.tool_call_id === id &&
            !backgroundJob(message),
        )?.content;
    transcript = detailRows(agent, {
      width,
      expanded: Boolean(state.thinkingExpanded),
      thinkingSeconds: state.thinkingSeconds,
      result,
    });
  } else transcript = transcriptRows(state, width);
  // A job's page: its band stays under the header (0.5.0's), its output scrolls under it.
  let bandRows = band?.rows ?? [];
  if (state.jobDetail) {
    const job = state.jobDetail;
    let output = '';
    try {
      output = outputTail(job.outputPath, 64_000, Math.max(20, height * 2));
    } catch {
      output = 'Output is unavailable.';
    }
    bandRows = jobBand(job, width);
    transcript = wrap(plainJobOutput(output), width).map(
      (row) => p.dim + row + p.reset,
    );
  }
  // two header rows (and a page's band) above the transcript
  const available = Math.max(1, height - bottom.length - 2 - bandRows.length);
  state.view = {
    rows: available,
    maxScroll: Math.max(0, transcript.length - available),
  };
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
  const first = Math.max(0, end - available);
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
        first < state.welcome.length,
    },
    width,
  );
  rows.push(...bandRows);
  const headerHeight = rows.length;
  rows.push(...transcript.slice(first, end));
  while (rows.length < height - bottom.length) rows.push('');
  rows.push(...bottom);
  state.viewport = {
    top: headerHeight - Math.max(0, rows.length - height),
    height: available,
    first,
    total: transcript.length,
  };
  state.pageButtons = band && {
    row: headerHeight - band.rows.length - Math.max(0, rows.length - height),
    spans: band.spans,
  };
  // The strip is the screen's last rows: its header, then a row per subagent shown.
  state.stripAgents = stripIds.length
    ? { row: Math.min(rows.length, height) - strip.length + 1, ids: stripIds }
    : undefined;
  // A row never runs past the edge: on a very narrow screen even a status row is cut.
  if (cursor && cursorInBottom) {
    const index =
      rows.length -
      bottom.length +
      cursorInBottom.index -
      Math.max(0, rows.length - height);
    if (index >= 0 && index < Math.min(rows.length, height))
      cursor.value = { row: index + 1, col: cursorInBottom.col };
  }
  return rows
    .slice(-height)
    .map((row) => pad(truncateStyled(row, width), width));
}
