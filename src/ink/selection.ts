// Text selection on the painted screen, ported from circle/ink/selection.py (0.5.0).
// Points are screen cells: col and row from 0. The screen is the frame's rows as painted.
import { stringWidth, stripAnsi } from './string_width.js';
import { RESET, sgrJoin } from './theme.js';

export interface Point {
  col: number;
  row: number;
}
export interface AnchorSpan {
  lo: Point;
  hi: Point;
  kind: 'word' | 'line';
}
export interface SelectionState {
  /** Where the mouse went down. Undefined when nothing is selected. */
  anchor?: Point;
  /** Where the drag is now. */
  focus?: Point;
  /** Between mouse down and mouse up. */
  isDragging: boolean;
  /** After a double or triple click: the word or line clicked, which stays selected while
   * the drag extends by words or lines in either direction. Undefined in character mode. */
  anchorSpan?: AnchorSpan;
  /** Selected text on rows that scrolled out above the transcript. */
  scrolledOffAbove: string[];
  /** Selected text on rows that scrolled out below it. */
  scrolledOffBelow: string[];
  /** The anchor's row before it was clamped to the transcript, so scrolling back restores it. */
  virtualAnchorRow?: number;
  virtualFocusRow?: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The painted screen as cells. A wide character's right half is '' (a spacer). */
export class Grid {
  readonly width: number;
  readonly height: number;
  private cells: string[][];
  constructor(rows: string[]) {
    this.cells = rows.map((row) => {
      const cells: string[] = [];
      for (const { segment } of segmenter.segment(stripAnsi(row))) {
        const width = stringWidth(segment);
        if (!width) {
          if (cells.length) cells[cells.length - 1] += segment;
          continue;
        }
        cells.push(segment);
        for (let index = 1; index < width; index++) cells.push('');
      }
      return cells;
    });
    this.width = Math.max(0, ...this.cells.map((cells) => cells.length));
    this.height = rows.length;
    for (const cells of this.cells)
      while (cells.length < this.width) cells.push(' ');
  }
  char(col: number, row: number): string {
    return this.cells[row]?.[col] ?? ' ';
  }
  isSpacer(col: number, row: number): boolean {
    return this.cells[row]?.[col] === '';
  }
}

export function createSelectionState(): SelectionState {
  return { isDragging: false, scrolledOffAbove: [], scrolledOffBelow: [] };
}

export function startSelection(
  s: SelectionState,
  col: number,
  row: number,
): void {
  s.anchor = { col, row };
  s.focus = undefined;
  s.isDragging = true;
  s.anchorSpan = undefined;
  s.scrolledOffAbove = [];
  s.scrolledOffBelow = [];
  s.virtualAnchorRow = undefined;
  s.virtualFocusRow = undefined;
}

export function updateSelection(
  s: SelectionState,
  col: number,
  row: number,
): void {
  if (!s.isDragging) return;
  // a press that has not left its cell is a click, not a selection
  if (!s.focus && s.anchor && s.anchor.col === col && s.anchor.row === row)
    return;
  s.focus = { col, row };
}

export function finishSelection(s: SelectionState): void {
  s.isDragging = false;
}

export function clearSelection(s: SelectionState): void {
  s.anchor = undefined;
  s.focus = undefined;
  s.isDragging = false;
  s.anchorSpan = undefined;
  s.scrolledOffAbove = [];
  s.scrolledOffBelow = [];
  s.virtualAnchorRow = undefined;
  s.virtualFocusRow = undefined;
}

export function hasSelection(s: SelectionState): boolean {
  return s.anchor !== undefined && s.focus !== undefined;
}

const WORD_CHAR = /^[\p{L}\p{N}_\-/.+~\\]/u;

function charClass(c: string): number {
  if (c === ' ' || c === '') return 0;
  return WORD_CHAR.test(c) ? 1 : 2;
}

function wordBoundsAt(
  grid: Grid,
  col: number,
  row: number,
): [number, number] | undefined {
  if (row < 0 || row >= grid.height) return undefined;
  let c = col;
  // on a wide character's right half: start from its left half
  if (c > 0 && grid.isSpacer(c, row)) c -= 1;
  if (c < 0 || c >= grid.width) return undefined;
  const cls = charClass(grid.char(c, row));
  let lo = c;
  while (lo > 0) {
    const prev = lo - 1;
    if (grid.isSpacer(prev, row)) {
      if (prev === 0) break;
      if (charClass(grid.char(prev - 1, row)) !== cls) break;
      lo = prev - 1;
      continue;
    }
    if (charClass(grid.char(prev, row)) !== cls) break;
    lo = prev;
  }
  let hi = c;
  while (hi < grid.width - 1) {
    const next = hi + 1;
    if (grid.isSpacer(next, row)) {
      hi = next;
      continue;
    }
    if (charClass(grid.char(next, row)) !== cls) break;
    hi = next;
  }
  return [lo, hi];
}

function comparePoints(a: Point, b: Point): number {
  if (a.row !== b.row) return a.row < b.row ? -1 : 1;
  if (a.col !== b.col) return a.col < b.col ? -1 : 1;
  return 0;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export function selectWordAt(
  s: SelectionState,
  grid: Grid,
  col: number,
  row: number,
): void {
  const bounds = wordBoundsAt(grid, col, row);
  if (!bounds) return;
  const lo = { col: bounds[0], row };
  const hi = { col: bounds[1], row };
  s.anchor = lo;
  s.focus = hi;
  s.isDragging = true;
  s.anchorSpan = { lo, hi, kind: 'word' };
}

export function selectLineAt(s: SelectionState, grid: Grid, row: number): void {
  if (row < 0 || row >= grid.height) return;
  const lo = { col: 0, row };
  const hi = { col: grid.width - 1, row };
  s.anchor = lo;
  s.focus = hi;
  s.isDragging = true;
  s.anchorSpan = { lo, hi, kind: 'line' };
}

/** Word or line mode: the drag reaches the word or line under the mouse, and the first one
 * stays selected even when the drag goes back past it. */
export function extendSelection(
  s: SelectionState,
  grid: Grid,
  col: number,
  row: number,
): void {
  if (!s.isDragging || !s.anchorSpan) return;
  const span = s.anchorSpan;
  let lo: Point;
  let hi: Point;
  if (span.kind === 'word') {
    const bounds = wordBoundsAt(grid, col, row);
    lo = { col: bounds ? bounds[0] : col, row };
    hi = { col: bounds ? bounds[1] : col, row };
  } else {
    const r = clamp(row, 0, grid.height - 1);
    lo = { col: 0, row: r };
    hi = { col: grid.width - 1, row: r };
  }
  if (comparePoints(hi, span.lo) < 0) {
    s.anchor = span.hi;
    s.focus = lo;
  } else if (comparePoints(lo, span.hi) > 0) {
    s.anchor = span.lo;
    s.focus = hi;
  } else {
    s.anchor = span.lo;
    s.focus = span.hi;
  }
}

export function selectionBounds(s: SelectionState): [Point, Point] | undefined {
  if (!s.anchor || !s.focus) return undefined;
  return comparePoints(s.anchor, s.focus) <= 0
    ? [s.anchor, s.focus]
    : [s.focus, s.anchor];
}

function rowText(grid: Grid, row: number, from: number, to: number): string {
  let line = '';
  for (let col = from; col <= to; col++)
    if (!grid.isSpacer(col, row)) line += grid.char(col, row);
  return line.trimEnd();
}

export function getSelectedText(s: SelectionState, grid: Grid): string {
  const bounds = selectionBounds(s);
  if (!bounds) return '';
  const [start, end] = bounds;
  const lines = [...s.scrolledOffAbove];
  for (let row = start.row; row <= end.row; row++) {
    if (row < 0 || row >= grid.height) continue;
    lines.push(
      rowText(
        grid,
        row,
        row === start.row ? start.col : 0,
        row === end.row ? end.col : grid.width - 1,
      ),
    );
  }
  lines.push(...s.scrolledOffBelow);
  return lines.join('\n');
}

/** Before the transcript scrolls rows first..last out of sight, keep their selected text. */
export function captureScrolledRows(
  s: SelectionState,
  grid: Grid,
  firstRow: number,
  lastRow: number,
  side: 'above' | 'below',
): void {
  const bounds = selectionBounds(s);
  if (!bounds || firstRow > lastRow) return;
  const [start, end] = bounds;
  const lo = Math.max(firstRow, start.row);
  const hi = Math.min(lastRow, end.row);
  if (lo > hi) return;
  const width = grid.width;
  const captured: string[] = [];
  for (let row = lo; row <= hi; row++)
    captured.push(
      rowText(
        grid,
        row,
        row === start.row ? start.col : 0,
        row === end.row ? end.col : width - 1,
      ),
    );
  const widen = (): void => {
    if (s.anchorSpan)
      s.anchorSpan = {
        lo: { col: 0, row: s.anchorSpan.lo.row },
        hi: { col: width - 1, row: s.anchorSpan.hi.row },
        kind: s.anchorSpan.kind,
      };
  };
  if (side === 'above') {
    s.scrolledOffAbove.push(...captured);
    if (s.anchor && s.anchor.row === start.row && lo === start.row) {
      s.anchor = { col: 0, row: s.anchor.row };
      widen();
    }
  } else {
    s.scrolledOffBelow = [...captured, ...s.scrolledOffBelow];
    if (s.anchor && s.anchor.row === end.row && hi === end.row) {
      s.anchor = { col: width - 1, row: s.anchor.row };
      widen();
    }
  }
}

/** The transcript scrolled by dRow rows (content moved down when positive): the selection
 * moves with its text, clamped to minRow..maxRow, and is dropped once all of it is gone. */
export function shiftSelection(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
  width: number,
): void {
  if (!s.anchor || !s.focus) return;
  const anchorRow = s.virtualAnchorRow ?? s.anchor.row;
  const focusRow = s.virtualFocusRow ?? s.focus.row;
  const vAnchor = anchorRow + dRow;
  const vFocus = focusRow + dRow;
  if (
    (vAnchor < minRow && vFocus < minRow) ||
    (vAnchor > maxRow && vFocus > maxRow)
  ) {
    clearSelection(s);
    return;
  }
  const oldAboveDebt = Math.max(0, minRow - Math.min(anchorRow, focusRow));
  const oldBelowDebt = Math.max(0, Math.max(anchorRow, focusRow) - maxRow);
  const newAboveDebt = Math.max(0, minRow - Math.min(vAnchor, vFocus));
  const newBelowDebt = Math.max(0, Math.max(vAnchor, vFocus) - maxRow);
  if (newAboveDebt < oldAboveDebt)
    s.scrolledOffAbove = s.scrolledOffAbove.slice(
      0,
      s.scrolledOffAbove.length - (oldAboveDebt - newAboveDebt),
    );
  if (newBelowDebt < oldBelowDebt)
    s.scrolledOffBelow = s.scrolledOffBelow.slice(oldBelowDebt - newBelowDebt);
  if (s.scrolledOffAbove.length > newAboveDebt)
    s.scrolledOffAbove = newAboveDebt
      ? s.scrolledOffAbove.slice(-newAboveDebt)
      : [];
  if (s.scrolledOffBelow.length > newBelowDebt)
    s.scrolledOffBelow = s.scrolledOffBelow.slice(0, newBelowDebt);
  const shift = (p: Point, row: number): Point =>
    row < minRow
      ? { col: 0, row: minRow }
      : row > maxRow
        ? { col: width - 1, row: maxRow }
        : { col: p.col, row };
  s.anchor = shift(s.anchor, vAnchor);
  s.focus = shift(s.focus, vFocus);
  s.virtualAnchorRow =
    vAnchor < minRow || vAnchor > maxRow ? vAnchor : undefined;
  s.virtualFocusRow = vFocus < minRow || vFocus > maxRow ? vFocus : undefined;
  if (s.anchorSpan)
    s.anchorSpan = {
      lo: shift(s.anchorSpan.lo, s.anchorSpan.lo.row + dRow),
      hi: shift(s.anchorSpan.hi, s.anchorSpan.hi.row + dRow),
      kind: s.anchorSpan.kind,
    };
}

/** While dragging only the anchor moves with the text; the focus stays under the mouse. */
export function shiftAnchor(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): void {
  if (!s.anchor) return;
  const raw = (s.virtualAnchorRow ?? s.anchor.row) + dRow;
  s.anchor = { col: s.anchor.col, row: clamp(raw, minRow, maxRow) };
  s.virtualAnchorRow = raw < minRow || raw > maxRow ? raw : undefined;
  if (s.anchorSpan) {
    const shift = (p: Point): Point => ({
      col: p.col,
      row: clamp(p.row + dRow, minRow, maxRow),
    });
    s.anchorSpan = {
      lo: shift(s.anchorSpan.lo),
      hi: shift(s.anchorSpan.hi),
      kind: s.anchorSpan.kind,
    };
  }
}

// ── painting ──────────────────────────────────────────────────────────────

const TOKEN =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const SGR = /^\x1b\[([\d;:]*)m$/;

function colourKind(group: string): 'fg' | 'bg' | undefined {
  const code = parseInt(group, 10);
  if ((code >= 30 && code <= 39) || (code >= 90 && code <= 97)) return 'fg';
  if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107)) return 'bg';
  return undefined;
}

/** The SGR groups in force after `params` (a 38;2;r;g;b colour is one group). */
function applySgr(active: string[], params: string): string[] {
  const parts = params === '' ? ['0'] : params.split(';');
  let next = [...active];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    let group = part;
    if (['38', '48', '58'].includes(part) && parts[index + 1] === '5') {
      group = parts.slice(index, index + 3).join(';');
      index += 2;
    } else if (['38', '48', '58'].includes(part) && parts[index + 1] === '2') {
      group = parts.slice(index, index + 5).join(';');
      index += 4;
    }
    if (group === '' || group === '0') {
      next = [];
      continue;
    }
    const kind = colourKind(group);
    if (kind) next = next.filter((item) => colourKind(item) !== kind);
    next.push(group);
  }
  return next;
}

const sgr = (group: string): string => `\x1b[${group}m`;

/** One row with columns from..to on `background`: each cell keeps its own foreground and
 * loses its own background and reverse video, as the 0.5.0 selection did. */
export function paintRow(
  row: string,
  from: number,
  to: number,
  background: string,
): string {
  let active: string[] = [];
  let out = '';
  let col = 0;
  let inside = false;
  const selected = (): string =>
    RESET +
    sgrJoin(
      ...active
        .filter(
          (group) =>
            colourKind(group) !== 'bg' && group !== '7' && group !== '27',
        )
        .map(sgr),
      background,
    );
  const restore = (): string => RESET + sgrJoin(...active.map(sgr));
  const text = (chunk: string): void => {
    for (const { segment } of segmenter.segment(chunk)) {
      const width = stringWidth(segment);
      const on = width ? col <= to && col + width - 1 >= from : inside;
      if (on !== inside) {
        out += on ? selected() : restore();
        inside = on;
      }
      out += segment;
      col += width;
    }
  };
  let last = 0;
  for (const match of row.matchAll(TOKEN)) {
    text(row.slice(last, match.index));
    const token = match[0];
    const params = token.match(SGR)?.[1];
    if (params !== undefined) {
      active = applySgr(active, params);
      out += inside ? selected() : token;
    } else out += token;
    last = match.index + token.length;
  }
  text(row.slice(last));
  if (col <= to && from <= to) {
    if (col < from) {
      out += ' '.repeat(from - col);
      col = from;
    }
    if (!inside) out += selected();
    inside = true;
    out += ' '.repeat(to - col + 1);
  }
  if (inside) out += restore();
  return out;
}

/** The frame's rows with the selection painted on `background`. */
export function paintSelection(
  rows: string[],
  s: SelectionState,
  background: string,
): string[] {
  const bounds = selectionBounds(s);
  if (!bounds) return rows;
  const [start, end] = bounds;
  const width = Math.max(0, ...rows.map((row) => stringWidth(row)));
  const painted = [...rows];
  for (
    let row = Math.max(0, start.row);
    row <= Math.min(end.row, rows.length - 1);
    row++
  )
    painted[row] = paintRow(
      rows[row]!,
      row === start.row ? start.col : 0,
      row === end.row ? Math.min(end.col, width - 1) : width - 1,
      background,
    );
  return painted;
}
