import { palette, sgrJoin, statusLight } from '../ink/theme.js';
import { wrap, pad, stringWidth, truncate } from '../ink/string_width.js';
import type { Message, Usage } from '../types.js';
import type { Todo } from '../tools.js';
import { dialogRows, type DialogState } from '../ink/components/dialog_card.js';
import type { Picker } from '../ink/components/picker.js';
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
  renderToolResult?: (message: Message) => string[] | undefined;
}
export function transcriptRows(state: ScreenState, width: number): string[] {
  const p = palette();
  const rows: string[] = [...state.welcome, ''];
  let messages = state.messages.filter((message) => !message.internal);
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
  ): void => {
    const lines = wrap(content, width - 3);
    rows.push(
      ...lines.map(
        (line, index) =>
          sgrJoin(style, base) +
          pad((index === 0 ? ' ' + marker + ' ' : '   ') + line, width) +
          p.reset,
      ),
      '',
    );
  };
  for (const message of messages) {
    if (message.role === 'user')
      block('›', message.display ?? message.content, '', p.blue);
    else if (message.role === 'assistant') {
      if (message.thinking)
        block(
          '∴',
          state.showThinking ? message.thinking : 'Thought · ctrl+t',
          p.think_bg,
          p.dim,
        );
      if (message.content) block('⏺', message.content);
      for (const call of message.tool_calls ?? []) {
        const result = messages.find(
          (message) =>
            message.role === 'tool' && message.tool_call_id === call.id,
        );
        const read = [
          'read_file',
          'ls',
          'glob',
          'grep',
          'webfetch',
          'websearch',
          'skill',
        ].includes(call.name);
        const style =
          call.name === 'task' ? p.agent_bg : read ? p.read_bg : p.write_bg;
        const args =
          Object.values(call.args).find((value) => typeof value === 'string') ||
          '';
        block(
          statusLight(
            result
              ? result.status === 'error'
                ? result.recoverable
                  ? 'none'
                  : 'error'
                : 'ok'
              : state.waiting
                ? 'wait'
                : 'running',
          ),
          `${call.name}(${truncate(String(args), Math.max(1, width - call.name.length - 8))})`,
          style,
        );
      }
    } else if (message.role === 'tool') {
      const custom = state.renderToolResult?.(message);
      if (custom) {
        for (const row of custom) rows.push(pad(row, width));
        rows.push('');
        continue;
      }
      const lines = wrap(message.content, width - 5);
      const shown = state.showTools ? lines : lines.slice(0, 3);
      rows.push(...shown.map((line) => '   ' + p.dim + '⎿ ' + line + p.reset));
      if (lines.length > shown.length)
        rows.push(
          '     ' +
            p.faint +
            `… +${lines.length - shown.length} lines · ctrl+o` +
            p.reset,
        );
      rows.push('');
    }
  }
  if (state.thinking)
    block(
      '∴',
      state.showThinking ? state.thinking : 'Thinking · ctrl+t',
      p.think_bg,
      p.dim,
    );
  if (state.streaming) block('⏺', state.streaming);
  for (const note of state.notices)
    block(
      note.startsWith('✖') ? '✖' : ' ',
      note.replace(/^✖\s*/, ''),
      '',
      note.startsWith('✖') ? p.red : p.dim,
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
  if (!state.dialog && state.todos.length) {
    const current = Math.max(
      0,
      state.todos.findIndex((todo) => todo.status === 'in_progress'),
    );
    const top = Math.max(0, current - 2);
    const window = state.todos.slice(top, top + 5);
    const title = ` ${statusLight('running')} Plan ${state.todos.filter((todo) => todo.status === 'completed').length}/${state.todos.length} `;
    bottom.push(
      p.line +
        '┌─' +
        title +
        '─'.repeat(Math.max(0, width - stringWidth(title) - 3)) +
        '┐' +
        p.reset,
    );
    window.forEach((todo, index) =>
      bottom.push(
        sgrJoin(p.think_bg, p.text) +
          pad(
            '│ ' +
              statusLight(
                todo.status === 'completed'
                  ? 'ok'
                  : todo.status === 'in_progress'
                    ? 'running'
                    : 'none',
              ) +
              ' ' +
              truncate(`${top + index + 1}  ${todo.content}`, width - 7),
            width - 1,
          ) +
          p.line +
          '│' +
          p.reset,
      ),
    );
    bottom.push(p.line + '└' + '─'.repeat(width - 2) + '┘' + p.reset);
  }
  if (state.dialog)
    bottom.push(...dialogRows(state.dialog, width, Math.max(5, height - 3)));
  else {
    const elapsed = ((Date.now() - state.started) / 1000).toFixed(1);
    const label = state.busy ? ` Brewing… · ${elapsed}s ` : '';
    const frame = (text: string): string => {
      if (!state.busy) return p.outline + text + p.reset;
      return (
        Array.from(text)
          .map(
            (char, index) =>
              p.rainbow[
                (index + Math.floor(Date.now() / 160)) % p.rainbow.length
              ] + char,
          )
          .join('') + p.reset
      );
    };
    bottom.push(frame('╭' + '─'.repeat(width - 2) + '╮'));
    if (label)
      bottom[bottom.length - 1] =
        frame('╭─') +
        p.dim +
        label +
        p.reset +
        frame('─'.repeat(Math.max(0, width - stringWidth(label) - 3)) + '╮');
    const draft = Array.from(state.draft);
    draft.splice(state.draftCursor, 0, '▏');
    const draftRows = wrap(draft.join(''), width - 4);
    const maxRows = Math.max(1, Math.floor(height * 0.3));
    for (const [index, line] of draftRows.slice(-maxRows).entries())
      bottom.push(
        frame('│') +
          p.text +
          pad((index === 0 ? ' › ' : '   ') + line, width - 2) +
          p.reset +
          frame('│'),
      );
    const mode = state.planMode
      ? ' read-only '
      : state.autoMode
        ? ' auto '
        : '';
    bottom.push(
      frame('╰' + '─'.repeat(Math.max(0, width - stringWidth(mode) - 2))) +
        p.dim +
        mode +
        p.reset +
        frame('╯'),
    );
  }
  const footer = ` ↑ ${state.usage.input_tokens} · ↓ ${state.usage.output_tokens} · cache ${state.usage.input_tokens ? Math.round((state.usage.cache_read_tokens / state.usage.input_tokens) * 100) : 0}%`;
  const right = state.flash
    ? truncate(state.flash, Math.max(1, Math.floor(width / 2)))
    : '';
  bottom.push(
    p.faint +
      truncate(footer, Math.max(1, width - stringWidth(right) - 2)) +
      ' '.repeat(
        Math.max(1, width - stringWidth(footer) - stringWidth(right) - 1),
      ) +
      right +
      p.reset,
  );
  const header = ` circle ${state.version} · ${state.model} · ${truncate(state.workspace, Math.max(1, width - 35), true)}`;
  const rows = [
    p.dim +
      truncate(header, width >= 60 ? width - 19 : width) +
      (width >= 60 ? '  ? for shortcuts' : '') +
      p.reset,
  ];
  const transcript = transcriptRows(state, width);
  const available = Math.max(1, height - bottom.length - 1);
  const end = Math.max(available, transcript.length - state.scroll);
  rows.push(...transcript.slice(Math.max(0, end - available), end));
  while (rows.length < height - bottom.length) rows.push('');
  rows.push(...bottom);
  return rows.slice(-height).map((row) => pad(row, width));
}
