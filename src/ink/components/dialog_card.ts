import { palette, statusLight, sgrJoin } from '../theme.js';
import { wrap, pad, truncate } from '../string_width.js';
export interface DialogState {
  title: string;
  body: string;
  options: string[];
  focus: number;
  input?: string;
  masked?: boolean;
}
export function dialogRows(
  dialog: DialogState,
  width: number,
  height: number,
): string[] {
  const p = palette();
  const inner = Math.max(4, width - 4);
  const content = wrap(dialog.body, inner);
  const available = Math.max(1, height - dialog.options.length - 5);
  const visible = content.slice(0, available);
  if (content.length > available)
    visible[visible.length - 1] = `… +${content.length - available + 1} lines`;
  const lines = [
    `${statusLight('wait')} ${dialog.title}`,
    ...visible,
    '',
    ...dialog.options.map(
      (option, index) =>
        (index === dialog.focus ? sgrJoin(p.sel_bg, p.text) : p.text) +
        `${index + 1}  ${option}` +
        p.reset,
    ),
  ];
  if (dialog.input !== undefined)
    lines.push(
      (dialog.masked
        ? '•'.repeat(Array.from(dialog.input).length)
        : dialog.input) + '▏',
    );
  return [
    p.yellow + '╭' + '─'.repeat(Math.max(0, width - 2)) + '╮' + p.reset,
    ...lines.map(
      (line) =>
        p.yellow +
        '│' +
        p.reset +
        ' ' +
        pad(line, inner) +
        ' ' +
        p.yellow +
        '│' +
        p.reset,
    ),
    p.yellow + '╰' + '─'.repeat(Math.max(0, width - 2)) + '╯' + p.reset,
  ].map((row) => row);
}
