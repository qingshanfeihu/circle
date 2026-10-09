import { stringWidth } from '../ink/string_width.js';
import { popupRows } from '../ink/components/popup.js';
import type { InputHistory } from './input_history.js';

/** A paste longer than this, or with more line breaks than PASTE_MAX_LINES, is folded. */
const PASTE_THRESHOLD = 800;
const PASTE_MAX_LINES = 2;
const PASTE_REF = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;
// Word-wise keys, as in readline and pi. macOS terminals send option+arrow as alt+b/f.
const WORD_LEFT = new Set(['alt+left', 'ctrl+left', 'alt+b']);
const WORD_RIGHT = new Set(['alt+right', 'ctrl+right', 'alt+f']);
const DELETE_WORD_BACK = new Set(['ctrl+w', 'alt+backspace']);
const DELETE_WORD_FORWARD = new Set(['alt+d', 'alt+delete']);
const WORD_GAP = new Set([' ', '\t', '\n']);
const COMPLETION_ROWS = 6;
const CURSOR = '▏';

/** The part of the screen state the input box owns. */
export interface DraftState {
  draft: string;
  /** In code points. */
  draftCursor: number;
  /** The first row of the draft in view, kept so the view follows the cursor. */
  draftTop?: number;
  completion?: Completion;
}
export interface CompletionItem {
  value: string;
  label: string;
  meta: string;
}
/** The list of what `/part` or `@part` can become, above the input box. */
export interface Completion {
  kind: 'command' | 'file';
  start: number;
  items: CompletionItem[];
  focus: number;
  /** The draft and cursor the list was made for. */
  value: string;
  cursor: number;
}
/** What the input box needs from the session around it. */
export interface ComposerHost {
  readonly history: InputHistory;
  columns(): number;
  /** Rows of the conversation in view, for pageup and pagedown. */
  viewRows(): number;
  /** Positive scrolls up, to older rows. */
  scroll(rows: number | 'top' | 'bottom'): void;
  send(kind: 'steer' | 'followUp'): void;
  command(name: string): void;
  flash(text: string): void;
  /** Everything that can follow `/`, with a description. */
  commands(): Map<string, string>;
  files(partial: string, limit: number): string[];
}

function cellWidth(char: string): number {
  if (char === '\t') return 1;
  if (/^[\x00-\x1f\x7f-\x9f]$/.test(char)) return 0;
  return stringWidth(char);
}
function visible(char: string): string {
  if (char === '\t') return ' ';
  return /^[\x00-\x1f\x7f-\x9f]$/.test(char) ? '' : char;
}
function widthOf(chars: readonly string[], start: number, end: number): number {
  let used = 0;
  for (let at = start; at < end; at++) used += cellWidth(chars[at]!);
  return used;
}
/** Columns for the draft's text in a screen this wide: the frame, ` › ` and the cursor. */
export function draftWidth(columns: number): number {
  return Math.max(1, columns - 6);
}
/** The box grows with the draft up to 30% of the screen (at least 5 rows), then scrolls. */
export function maxDraftRows(height: number): number {
  return Math.max(5, Math.floor(height * 0.3));
}
/**
 * The rows a draft takes in a box `width` columns wide, as `[start, end)` indexes into
 * `chars`: a line break ends a row (and is not shown), a long line wraps after the last
 * space that fits, or anywhere in a word longer than the row.
 */
export function visualLines(
  chars: readonly string[],
  width: number,
): [number, number][] {
  width = Math.max(1, width);
  const rows: [number, number][] = [];
  let start = 0;
  let used = 0;
  let space = -1;
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at]!;
    if (char === '\n') {
      rows.push([start, at]);
      start = at + 1;
      used = 0;
      space = -1;
      continue;
    }
    const count = cellWidth(char);
    if (used + count > width && at > start) {
      if (char === ' ') {
        // The space where the row breaks is the break: it starts no row
        rows.push([start, at]);
        start = at + 1;
        used = 0;
        space = -1;
        continue;
      }
      const cut = space >= start ? space + 1 : at;
      rows.push([start, cut]);
      start = cut;
      space = -1;
      used = widthOf(chars, start, at);
    }
    if (char === ' ') space = at;
    used += count;
  }
  rows.push([start, chars.length]);
  return rows;
}
/**
 * The row the cursor is on. At a wrap the cursor shows at the start of the next row;
 * just before a line break it shows at the end of its own.
 */
export function cursorRow(rows: [number, number][], cursor: number): number {
  for (let index = 0; index < rows.length; index++) {
    const [start, end] = rows[index]!;
    const following = rows[index + 1]?.[0];
    if (
      start <= cursor &&
      cursor <= end &&
      (following === undefined || cursor < following || following !== end)
    )
      return index;
  }
  return rows.length - 1;
}
/** The input box's rows for a screen `columns` wide and `height` tall, cursor drawn in. */
export function draftLines(
  state: DraftState,
  columns: number,
  height: number,
): string[] {
  const chars = Array.from(state.draft);
  const cursor = Math.max(0, Math.min(state.draftCursor, chars.length));
  const rows = visualLines(chars, draftWidth(columns));
  const row = cursorRow(rows, cursor);
  const shown = Math.max(1, Math.min(rows.length, maxDraftRows(height)));
  // Keep the cursor's row in view
  let top = state.draftTop ?? 0;
  if (row < top) top = row;
  else if (row >= top + shown) top = row - shown + 1;
  top = Math.max(0, Math.min(top, rows.length - shown));
  state.draftTop = top;
  const lines: string[] = [];
  for (let index = top; index < top + shown; index++) {
    const [start, end] = rows[index]!;
    let text = '';
    for (let at = start; at < end; at++) {
      if (index === row && at === cursor) text += CURSOR;
      text += visible(chars[at]!);
    }
    if (index === row && cursor === end) text += CURSOR;
    lines.push((index === 0 ? ' › ' : '   ') + text);
  }
  return lines;
}
/** The completion list's rows: a popup, six entries at a time around the marked one. */
export function completionRows(
  completion: Completion,
  width: number,
): string[] {
  const { focus, items } = completion;
  const top = Math.min(
    Math.max(0, focus - COMPLETION_ROWS + 1),
    Math.max(0, items.length - COMPLETION_ROWS),
  );
  const window = items.slice(top, top + COMPLETION_ROWS);
  const title = completion.kind === 'command' ? 'commands' : 'files';
  return popupRows(
    title +
      (items.length > window.length ? ` · ${focus + 1}/${items.length}` : ''),
    window.map((item) => ({
      label: item.label,
      meta: item.meta ? `  ${item.meta}` : '',
    })),
    focus - top,
    width,
  );
}
function commonPrefix(values: string[]): string {
  let prefix = values[0] ?? '';
  for (const value of values)
    while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}
function lastWord(text: string): string {
  return text.split(' ').at(-1)!.split('\n').at(-1)!;
}

/**
 * The input box: the draft and its cursor (kept in the screen state), long pastes folded
 * to `[Pasted text #N]`, the text the word keys cut for ctrl+y, and the completion list.
 */
export class Composer {
  private pastes = new Map<number, string>();
  private submitted = new Map<number, string>();
  private nextPaste = 1;
  private killed = '';
  private dismissed?: string;
  constructor(
    private readonly state: DraftState,
    private readonly host: ComposerHost,
  ) {}
  private get chars(): string[] {
    return Array.from(this.state.draft);
  }
  private get cursor(): number {
    return this.state.draftCursor;
  }
  /** Replace the draft; the cursor goes to the end unless given. */
  set(text: string, cursor?: number): void {
    const length = Array.from(text).length;
    this.state.draft = text;
    this.state.draftCursor =
      cursor === undefined ? length : Math.max(0, Math.min(cursor, length));
  }
  clear(): void {
    this.set('');
    this.pastes.clear();
    this.state.completion = undefined;
  }
  insert(text: string): void {
    const chars = this.chars;
    const added = Array.from(text);
    this.state.draft = [
      ...chars.slice(0, this.cursor),
      ...added,
      ...chars.slice(this.cursor),
    ].join('');
    this.state.draftCursor += added.length;
  }
  private remove(start: number, end: number): void {
    const chars = this.chars;
    this.state.draft = chars.slice(0, start).concat(chars.slice(end)).join('');
    this.state.draftCursor = start;
  }
  /** Delete `start..end`; ctrl+y puts it back. */
  private cut(start: number, end: number): void {
    if (start >= end) return;
    this.killed = this.chars.slice(start, end).join('');
    this.remove(start, end);
  }
  private wordStart(at: number): number {
    const chars = this.chars;
    while (at > 0 && WORD_GAP.has(chars[at - 1]!)) at--;
    while (at > 0 && !WORD_GAP.has(chars[at - 1]!)) at--;
    return at;
  }
  private wordEnd(at: number): number {
    const chars = this.chars;
    while (at < chars.length && WORD_GAP.has(chars[at]!)) at++;
    while (at < chars.length && !WORD_GAP.has(chars[at]!)) at++;
    return at;
  }
  /** A short paste goes in as it is; a long one becomes `[Pasted text #N +M lines]`. */
  paste(text: string): void {
    const normalized = text.replace(/\r\n?/g, '\n');
    const lines = normalized.split('\n').length - 1;
    if (
      Array.from(normalized).length > PASTE_THRESHOLD ||
      lines > PASTE_MAX_LINES
    ) {
      const id = this.nextPaste++;
      this.pastes.set(id, normalized);
      this.insert(
        lines ? `[Pasted text #${id} +${lines} lines]` : `[Pasted text #${id}]`,
      );
    } else this.insert(normalized);
  }
  /** Empty the box for a send and return what was in it. Its pastes stay readable by `modelText` until the next send. */
  take(): string {
    const text = this.state.draft;
    this.submitted = new Map(this.pastes);
    this.clear();
    return text;
  }
  /** A draft as the model should read it: each `[Pasted text #N …]` replaced by the paste. */
  modelText(text: string): string {
    const pastes = new Map([...this.submitted, ...this.pastes]);
    return text.replace(
      PASTE_REF,
      (match, id: string) => pastes.get(Number(id)) ?? match,
    );
  }
  /** The pastes a draft refers to, to keep with the message it becomes. */
  pastesOf(text: string): Record<string, string> | undefined {
    const pastes = new Map([...this.submitted, ...this.pastes]);
    const found: Record<string, string> = {};
    for (const match of text.matchAll(PASTE_REF)) {
      const content = pastes.get(Number(match[1]));
      if (content !== undefined) found[match[1]!] = content;
    }
    return Object.keys(found).length ? found : undefined;
  }
  /** Put a draft back together with the pastes its placeholders stand for. */
  restore(text: string, pastes: Record<string, string> = {}): void {
    this.set(text);
    this.pastes = new Map(
      Object.entries(pastes).map(([id, content]) => [Number(id), content]),
    );
    this.nextPaste = Math.max(this.nextPaste - 1, ...this.pastes.keys()) + 1;
    this.state.completion = undefined;
  }
  /**
   * ↑ or ↓ inside a draft of several rows: the same column one row up or down. False on
   * the first row going up or the last going down (history takes those).
   */
  moveVertical(step: number): boolean {
    const chars = this.chars;
    const rows = visualLines(chars, draftWidth(this.host.columns()));
    const row = cursorRow(rows, this.cursor);
    const target = row + step;
    if (rows.length < 2 || target < 0 || target >= rows.length) return false;
    const column = widthOf(chars, rows[row]![0], this.cursor);
    const [start, end] = rows[target]!;
    let at = start;
    let used = 0;
    while (at < end && used + cellWidth(chars[at]!) <= column)
      used += cellWidth(chars[at++]!);
    // The end of a wrapped row shows as the start of the next one
    if (at === end && at > start && rows[target + 1]?.[0] === end) at--;
    this.state.draftCursor = at;
    return true;
  }
  /** Keys that edit the draft or move in it. */
  edit(key: string, char: string): boolean {
    const length = this.chars.length;
    const cursor = this.cursor;
    if (key === 'backspace') {
      if (cursor > 0) this.remove(cursor - 1, cursor);
    } else if (key === 'delete' || key === 'ctrl+d') {
      if (cursor < length) this.remove(cursor, cursor + 1);
    } else if (key === 'left') this.state.draftCursor = Math.max(0, cursor - 1);
    else if (key === 'right')
      this.state.draftCursor = Math.min(length, cursor + 1);
    else if (key === 'home' || key === 'ctrl+a') this.state.draftCursor = 0;
    else if (key === 'end' || key === 'ctrl+e') this.state.draftCursor = length;
    else if (key === 'shift+enter' || key === 'ctrl+j') this.insert('\n');
    else if (key === 'ctrl+u') this.clear();
    else if (WORD_LEFT.has(key))
      this.state.draftCursor = this.wordStart(cursor);
    else if (WORD_RIGHT.has(key)) this.state.draftCursor = this.wordEnd(cursor);
    else if (DELETE_WORD_BACK.has(key))
      this.cut(this.wordStart(cursor), cursor);
    else if (DELETE_WORD_FORWARD.has(key))
      this.cut(cursor, this.wordEnd(cursor));
    else if (key === 'ctrl+k') this.cut(cursor, length);
    else if (key === 'ctrl+y') {
      if (this.killed) this.insert(this.killed);
    } else if (
      char &&
      !key.startsWith('ctrl+') &&
      !key.startsWith('alt+') &&
      !/^[\x00-\x1f\x7f]$/.test(char)
    )
      this.insert(char);
    else return false;
    return true;
  }
  /** A key for the input box once the session's own keys have had their turn. */
  key(key: string, char: string): boolean {
    const host = this.host;
    const empty = !this.state.draft;
    // With an empty box the scroll keys scroll the conversation
    if (empty && ['pageup', 'pagedown', 'home', 'end'].includes(key)) {
      if (key === 'home') host.scroll('top');
      else if (key === 'end') host.scroll('bottom');
      else {
        const half = Math.max(1, Math.floor(host.viewRows() / 2));
        host.scroll(key === 'pageup' ? half : -half);
      }
      return true;
    }
    if (key === 'pageup' || key === 'pagedown') return true;
    if (key === 'up' || key === 'down') {
      // A draft of several rows: ↑ ↓ move between them first (while browsing the
      // history they keep browsing)
      const history = host.history;
      if (!history.browsing && this.moveVertical(key === 'up' ? -1 : 1))
        return true;
      if (key === 'up' && empty && !history.canGoUp()) host.scroll(3);
      else if (key === 'down' && empty && !history.canGoDown()) host.scroll(-3);
      else {
        const value =
          key === 'up' ? history.up(this.state.draft) : history.down();
        if (value !== undefined) this.set(value);
      }
      return true;
    }
    if (key === 'tab') {
      this.tab();
      return true;
    }
    if (empty && (char === '?' || key === '?')) {
      host.command('hotkeys');
      return true;
    }
    if (key === 'enter') {
      if (this.cursor > 0 && this.chars[this.cursor - 1] === '\\') {
        // \ then enter is a line break, for terminals where shift+enter is enter
        this.remove(this.cursor - 1, this.cursor);
        this.insert('\n');
        this.update();
      } else if (this.state.draft.trim()) host.send('steer');
      return true;
    }
    if (!this.edit(key, char)) return false;
    this.update();
    return true;
  }
  /** After an edit: what `/part` can still become, or the files `@part` can mean. */
  update(): void {
    const value = this.state.draft;
    const chars = this.chars;
    const cursor = this.cursor;
    let next: Completion | undefined;
    if (value === this.dismissed) next = undefined;
    else if (
      value.startsWith('/') &&
      cursor === chars.length &&
      !/\s/.test(value)
    ) {
      const typed = value.slice(1).toLowerCase();
      const described = this.host.commands();
      const names = [...described.keys()]
        .sort()
        .filter((name) => name.toLowerCase().startsWith(typed));
      if (names.length && !(names.length === 1 && names[0] === typed))
        next = {
          kind: 'command',
          start: 0,
          items: names.map((name) => ({
            value: '/' + name,
            label: '/' + name,
            meta: (described.get(name) ?? '').split('\n')[0]!.slice(0, 70),
          })),
          focus: 0,
          value,
          cursor,
        };
    } else {
      const word = lastWord(chars.slice(0, cursor).join(''));
      if (word.startsWith('@')) {
        const paths = this.host.files(word.slice(1), 50);
        if (paths.length && !(paths.length === 1 && paths[0] === word.slice(1)))
          next = {
            kind: 'file',
            start: cursor - Array.from(word).length,
            items: paths.map((path) => ({
              value: '@' + path,
              label: path,
              meta: '',
            })),
            focus: 0,
            value,
            cursor,
          };
      }
    }
    const kept = this.state.completion?.items[this.state.completion.focus];
    if (next && kept)
      next.focus = Math.max(
        0,
        next.items.findIndex((item) => item.value === kept.value),
      );
    this.state.completion = next;
  }
  /**
   * With the list open: ↑ ↓ move in it, tab takes the marked entry, enter takes it (and
   * runs a command), esc closes it until the text changes. Other keys go to the box.
   */
  completionKey(key: string): boolean {
    let list = this.state.completion;
    if (!list) return false;
    if (list.value !== this.state.draft || list.cursor !== this.cursor) {
      // The box changed without a key (a draft put back): list it again
      this.update();
      list = this.state.completion;
      if (!list) return false;
    }
    if (key === 'up' || key === 'down') {
      list.focus =
        (list.focus + (key === 'up' ? -1 : 1) + list.items.length) %
        list.items.length;
      return true;
    }
    if (key === 'escape') {
      this.dismissed = this.state.draft;
      this.state.completion = undefined;
      return true;
    }
    if (key !== 'tab' && key !== 'enter') return false;
    const chosen = list.items[list.focus]!.value;
    this.state.completion = undefined;
    if (list.kind === 'command') {
      if (key === 'tab') this.set(chosen + ' ');
      else {
        // enter on a command runs it, as in pi
        this.set(chosen);
        this.host.send('steer');
      }
      return true;
    }
    const chars = this.chars;
    const head =
      chars.slice(0, list.start).join('') +
      chosen +
      (chosen.endsWith('/') ? '' : ' ');
    this.set(head + chars.slice(this.cursor).join(''), Array.from(head).length);
    this.update(); // a folder lists what is in it
    return true;
  }
  /** tab with the list closed: complete a `/command` or an `@path` as far as it goes. */
  private tab(): void {
    if (this.completeMention()) return;
    const value = this.state.draft;
    if (!value.startsWith('/') || value.includes(' ')) return;
    const prefix = value.slice(1).toLowerCase();
    const matches = [...this.host.commands().keys()]
      .sort()
      .filter((name) => name.startsWith(prefix));
    if (!matches.length) {
      this.host.flash(`No command starts with /${prefix}`);
      return;
    }
    if (matches.length === 1) {
      this.set(`/${matches[0]} `);
      return;
    }
    this.host.flash(
      matches
        .slice(0, 8)
        .map((name) => '/' + name)
        .join('  ') + (matches.length > 8 ? '  …' : ''),
    );
    const shared = commonPrefix(matches);
    if (shared.length > prefix.length) this.set('/' + shared);
  }
  private completeMention(): boolean {
    const chars = this.chars;
    const before = chars.slice(0, this.cursor).join('');
    const after = chars.slice(this.cursor).join('');
    const word = lastWord(before);
    if (!word.startsWith('@')) return false;
    const matches = this.host.files(word.slice(1), 20);
    if (!matches.length) {
      this.host.flash(`No file matches ${word}`);
      return true;
    }
    let chosen: string;
    if (matches.length === 1)
      chosen = matches[0]! + (matches[0]!.endsWith('/') ? '' : ' ');
    else {
      chosen = commonPrefix(matches);
      this.host.flash(
        matches.slice(0, 8).join('  ') + (matches.length > 8 ? '  …' : ''),
      );
      // Found by name elsewhere, the shared start need not contain what was typed
      if (chosen.length <= word.length - 1 || !chosen.startsWith(word.slice(1)))
        return true;
    }
    const head = before.slice(0, before.length - word.length) + '@' + chosen;
    this.set(head + after, Array.from(head).length);
    return true;
  }
}
