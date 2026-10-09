import { palette, statusLight, sgrJoin, type Palette } from '../theme.js';
import { stringWidth, truncate } from '../string_width.js';
import { terminalText } from './markdown_renderer.js';
import { loopFrame } from './loop_frame.js';
/** How a row of a card is coloured; resolved against the palette at every paint. */
export type CardTone =
  'em' | 'text' | 'dim' | 'warn' | 'err' | 'added' | 'removed' | 'faint';
export interface CardLine {
  text: string;
  tone?: CardTone;
}
/** The type tint of a card's title and body: the colour of the tool that asks. */
export type CardTint = 'read_bg' | 'write_bg' | 'think_bg' | 'agent_bg';
export interface DialogState {
  title: string;
  body: string;
  options: string[];
  focus: number;
  input?: string;
  masked?: boolean;
  /** Body rows in their own tones; drawn instead of `body` when given. */
  lines?: CardLine[];
  /** Per option: the key column ('' = its number). */
  optionKeys?: string[];
  /** Per option: dim text after the label. */
  optionNotes?: string[];
  /** Per option of a multi-select question: ticked or not. */
  marks?: (boolean | undefined)[];
  /** Rows under the menu: warnings, a typed answer. */
  notes?: CardLine[];
  tint?: CardTint;
  /** The title's lamp: `wait` (your turn, the default) or `running` (Circle is busy: setup
   * looking for models). A running card's frame is faint instead of yellow. */
  lamp?: 'wait' | 'running';
}
/** What a card does with a key: `undefined` took it (or swallowed it), `pass` leaves it to the session. */
export type CardResult<T> = { answer: T } | 'pass' | undefined;
/** A blocking question in the frame (approval, question, secret): keys in, an answer out. */
export interface Card<T> {
  state(): DialogState;
  handle(key: string, char: string): CardResult<T>;
  paste(text: string): void;
}
/** Printable input for a card's own input row (no control keys, no newlines). */
export function printable(key: string, char: string): string {
  if (!char || key.startsWith('ctrl+') || key.startsWith('alt+')) return '';
  if (['enter', 'tab', 'shift+enter', 'backspace', 'escape'].includes(key))
    return '';
  return terminalText(char).replace(/\n/g, '');
}
function graphemes(text: string): string[] {
  return [
    ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
  ].map((item) => item.segment);
}
/** Wrap by display width: Latin words break at spaces, CJK anywhere. */
export function wrapWords(text: string, width: number): string[] {
  if (width <= 0 || stringWidth(text) <= width) return [text];
  const lines: string[] = [];
  let current: string[] = [];
  let used = 0;
  let lastSpace = -1;
  for (const glyph of graphemes(text)) {
    const count = stringWidth(glyph);
    if (glyph === ' ' && used + count > width) {
      lines.push(current.join('').trimEnd()); // the space is the break
      current = [];
      used = 0;
      lastSpace = -1;
      continue;
    }
    if (used + count > width) {
      if (
        lastSpace > 0 &&
        /^[\x20-\x7e]$/.test(glyph) &&
        current.length - lastSpace < width * 0.4
      ) {
        lines.push(current.slice(0, lastSpace).join('').trimEnd());
        current = current.slice(lastSpace + 1);
      } else {
        lines.push(current.join(''));
        current = [];
      }
      used = stringWidth(current.join(''));
      lastSpace = -1;
    }
    current.push(glyph);
    used += count;
    if (glyph === ' ') lastSpace = current.length - 1;
  }
  if (current.length) lines.push(current.join(''));
  const kept = lines.filter((line) => line.trim());
  return kept.length ? kept : [''];
}
function tone(p: Palette, name: CardTone | undefined): string {
  return name === 'em'
    ? p.em
    : name === 'dim'
      ? p.dim
      : name === 'warn'
        ? p.yellow
        : name === 'err' || name === 'removed'
          ? p.red
          : name === 'added'
            ? p.green
            : name === 'faint'
              ? p.faint
              : p.text;
}
/** Segments in order, cut at `width` with "…", padded with the background to the full width. */
function compose(width: number, segments: [string, string][], bg = ''): string {
  const p = palette();
  let out = '';
  let used = 0;
  for (const [raw, sgr] of segments) {
    const room = width - used;
    if (room <= 0) break;
    const text = stringWidth(raw) > room ? truncate(raw, room) : raw;
    used += stringWidth(text);
    const code = bg ? sgrJoin(bg, sgr) : sgr;
    out += (code || p.reset) + text;
  }
  if (used < width) out += (bg || p.reset) + ' '.repeat(width - used);
  return out + p.reset;
}
/**
 * The card's rows inside the frame, each `width` columns wide: title with the waiting lamp,
 * body, a blank row, the options with their key column, notes, and the input row.
 * Grid: marker column 1 (lamp, key), text column 3. When the rows do not fit in `maxRows`,
 * only the body is cut, and it says how much; the title and the options always stay.
 */
export function cardRows(
  dialog: DialogState,
  width: number,
  maxRows?: number,
): string[] {
  const p = palette();
  width = Math.max(10, width); // the frame's narrowest inside
  const tint = dialog.tint ? p[dialog.tint] : '';
  const lamp = statusLight(dialog.lamp ?? 'wait');
  const lampCode = lamp.slice(0, lamp.indexOf('●'));
  const head = compose(
    width,
    [
      [' ', ''],
      ['●', lampCode],
      [' ', ''],
      [terminalText(dialog.title).replace(/\n/g, ' '), p.em],
    ],
    tint,
  );
  const lines: CardLine[] =
    dialog.lines ??
    dialog.body.split('\n').map((text) => ({ text, tone: 'text' as const }));
  let body: string[] = [];
  for (const line of lines)
    for (const part of wrapWords(terminalText(line.text), width - 4))
      body.push(
        compose(
          width,
          [
            ['   ', ''],
            [part, tone(p, line.tone)],
          ],
          tint,
        ),
      );
  const menu: string[] = [];
  if (dialog.options.length) menu.push(compose(width, []));
  const keys = dialog.options.map(
    (_, index) => dialog.optionKeys?.[index] || String(index + 1),
  );
  const keyWidth = Math.max(1, ...keys.map((key) => stringWidth(key)));
  dialog.options.forEach((option, index) => {
    const ticked = dialog.marks?.[index];
    const mark = ticked === undefined ? '' : ticked ? '[x] ' : '[ ] ';
    const label = terminalText(option).replace(/\n/g, ' ');
    const note = terminalText(dialog.optionNotes?.[index] ?? '').replace(
      /\n/g,
      ' ',
    );
    // label and note wrap as one text (an option is never cut); the note is dimmed by offset
    const full = label + (note ? ` — ${note}` : '');
    const parts = wrapWords(
      full,
      Math.max(8, width - 3 - keyWidth - stringWidth(mark)),
    );
    const focused = index === dialog.focus;
    const on = sgrJoin(p.sel_bg, p.em);
    let consumed = 0; // label glyphs used by earlier rows
    const labelLength = graphemes(label).length;
    parts.forEach((part, row) => {
      const glyphs = graphemes(part);
      const cut = Math.max(0, labelLength - consumed);
      consumed += glyphs.length + (row < parts.length - 1 ? 1 : 0); // a break drops one space
      const lead =
        row === 0 ? keys[index]!.padEnd(keyWidth) : ' '.repeat(keyWidth);
      const segments: [string, string][] = [
        [' ', ''],
        [lead, focused ? '' : p.dim],
        [' ', ''],
        [row === 0 ? mark : ' '.repeat(mark.length), ticked ? p.green : ''],
        [glyphs.slice(0, cut).join(''), focused ? '' : p.text],
        [glyphs.slice(cut).join(''), focused ? '' : p.dim],
      ];
      menu.push(
        compose(
          width,
          segments.map(([text, sgr]) => [text, focused && !sgr ? on : sgr]),
          focused ? p.sel_bg : '',
        ),
      );
    });
  });
  const notes: string[] = [];
  for (const line of dialog.notes ?? [])
    for (const part of wrapWords(terminalText(line.text), width - 4))
      notes.push(
        compose(width, [
          ['   ', ''],
          [part, tone(p, line.tone)],
        ]),
      );
  // the input row is the frame's last row, under the notes (a menu's own input row,
  // "Reject and explain", is the last option, so it stays right under it)
  const input: string[] = [];
  if (dialog.input !== undefined) {
    const value = dialog.masked
      ? '•'.repeat(graphemes(dialog.input).length)
      : terminalText(dialog.input).replace(/\n/g, ' ');
    if (!dialog.options.length) menu.push(compose(width, []));
    input.push(
      compose(width, [
        [' ', ''],
        ['›', p.blue],
        [' ', ''],
        [truncate(value + '▏', width - 4, true), p.text],
      ]),
    );
  }
  if (maxRows !== undefined) {
    const room = maxRows - 1 - menu.length - notes.length - input.length; // what is left for the body
    if (body.length > Math.max(1, room)) {
      const keep = Math.max(1, room - 1);
      body = [
        ...body.slice(0, keep),
        compose(
          width,
          [
            ['   ', ''],
            [`… +${body.length - keep} lines`, p.dim],
          ],
          tint,
        ),
      ];
    }
  }
  return [head, ...body, ...menu, ...notes, ...input];
}
/**
 * The card in its frame: still and yellow, because it is your turn; faint while the card
 * only says what Circle is doing (its lamp is `running`). The mode word keeps its corner.
 */
export function dialogRows(
  dialog: DialogState,
  width: number,
  height: number,
  mode: { word?: string; sgr?: string } = {},
): string[] {
  const p = palette();
  width = Math.max(12, width);
  const inner = cardRows(dialog, width - 2, Math.max(3, height - 2));
  const frame = loopFrame(width, {
    border: dialog.lamp === 'running' ? p.faint : p.yellow,
    mode: mode.word,
    modeSgr: mode.sgr,
  });
  return [
    frame.top,
    ...inner.map((row) => frame.left + row + frame.right),
    frame.bottom,
  ];
}
