// Mouse selection in the session screen, as circle/tui/session_app.py (0.5.0) wired it:
// drag selects and copies on release, a double click a word, a triple click a line,
// dragging to the transcript's edge scrolls, ctrl+c copies again and esc clears.
import type { InputEvent } from '../ink/parse_keypress.js';
import { palette } from '../ink/theme.js';
import {
  Grid,
  captureScrolledRows,
  clearSelection,
  createSelectionState,
  extendSelection,
  finishSelection,
  getSelectedText,
  hasSelection,
  paintSelection,
  selectLineAt,
  selectWordAt,
  selectionBounds,
  shiftAnchor,
  shiftSelection,
  startSelection,
  updateSelection,
  type Point,
} from '../ink/selection.js';

type MouseEvent = Extract<InputEvent, { type: 'mouse' }>;

/** Where the transcript sits: screen rows top..top+height-1 show its rows from `first`. */
export interface Viewport {
  top: number;
  height: number;
  first: number;
  total: number;
}
export interface FrameView {
  scroll: number;
  viewport?: Viewport;
  agentDetail?: { id: string };
  jobDetail?: { id: string };
}
export interface MouseSelectionHost {
  /** Scroll the transcript by delta rows, positive towards the end, and repaint. */
  scroll(delta: number): void;
  /** Put the selected text on the clipboard and say so. */
  copy(text: string): void;
  repaint(): void;
}

const MULTI_CLICK_MS = 300;
const AUTOSCROLL_MS = 120;
const AUTOSCROLL_ROWS = 2;

export class MouseSelection {
  readonly state = createSelectionState();
  now = (): number => performance.now();
  private rows: string[] = [];
  private cached?: Grid;
  private view?: { scroll: number; viewport?: Viewport; key: string };
  private dragPoint?: Point;
  private lastClick?: { at: number; col: number; row: number; count: number };
  private autoscroll?: NodeJS.Timeout;
  private autoscrollDelta = 0;
  constructor(private host: MouseSelectionHost) {}
  /** The screen as last painted. */
  get grid(): Grid {
    return (this.cached ??= new Grid(this.rows));
  }
  /** Take a new frame: move the selection with the text when the transcript scrolled, and
   * give back the rows with the selection painted in the palette's selection colour. */
  frame(rows: string[], view: FrameView): string[] {
    const before = this.view;
    const previousRows = this.rows;
    const previous = this.cached;
    this.rows = rows;
    this.cached = undefined;
    const key = view.agentDetail?.id ?? view.jobDetail?.id ?? '';
    this.view = {
      scroll: view.scroll,
      viewport: view.viewport && { ...view.viewport },
      key,
    };
    // A transcript scrolled back moves when rows arrive (0.5.0's held still), so the
    // selection follows its text then too; at the bottom it stays put, as in 0.5.0.
    if (
      before?.viewport &&
      view.viewport &&
      before.key === key &&
      (before.scroll !== view.scroll || view.scroll > 0)
    ) {
      const moved = view.viewport.first - before.viewport.first;
      if (moved)
        this.followScroll(
          moved,
          previous ?? new Grid(previousRows),
          view.viewport,
        );
    }
    if (!hasSelection(this.state)) return rows;
    return paintSelection(rows, this.state, palette().sel_bg);
  }
  /** A mouse event; true when it was the selection's. Wheel events are not. */
  mouse(event: MouseEvent): boolean {
    if (event.action === 'wheel') return false;
    const grid = this.grid;
    const col = Math.max(0, Math.min(event.x, grid.width - 1));
    const row = Math.max(0, Math.min(event.y, grid.height - 1));
    // motion with no button down (hover) has nothing to show here
    if (event.button !== 0) return event.action === 'move';
    if (event.action === 'press') {
      this.press(col, row);
      return true;
    }
    if (event.action === 'move') {
      if (!this.state.isDragging) return true;
      this.dragTo(col, row);
      this.startAutoscroll(row);
      this.host.repaint();
      return true;
    }
    this.stopAutoscroll();
    this.dragPoint = undefined;
    const wasDragging = this.state.isDragging;
    finishSelection(this.state);
    if (wasDragging && hasSelection(this.state)) this.copy();
    this.host.repaint();
    return true;
  }
  /** ctrl+c copies the selection again, esc clears it; true when the key was taken. */
  key(key: string): boolean {
    if (!hasSelection(this.state)) return false;
    if (key === 'ctrl+c') {
      this.copy();
      return true;
    }
    if (key === 'escape') {
      clearSelection(this.state);
      this.host.repaint();
      return true;
    }
    return false;
  }
  close(): void {
    this.stopAutoscroll();
  }
  private copy(): void {
    const text = getSelectedText(this.state, this.grid);
    if (text) this.host.copy(text);
  }
  private press(col: number, row: number): void {
    const now = this.now();
    const last = this.lastClick;
    let count = 1;
    if (
      last &&
      now - last.at < MULTI_CLICK_MS &&
      last.col === col &&
      last.row === row
    )
      count = Math.min(last.count + 1, 3);
    const s = this.state;
    s.scrolledOffAbove = [];
    s.scrolledOffBelow = [];
    this.dragPoint = { col, row };
    if (count === 1) startSelection(s, col, row);
    else if (count === 2) selectWordAt(s, this.grid, col, row);
    else selectLineAt(s, this.grid, row);
    this.lastClick = { at: now, col, row, count };
    this.host.repaint();
  }
  private dragTo(col: number, row: number): void {
    this.dragPoint = { col, row };
    if (this.state.anchorSpan) extendSelection(this.state, this.grid, col, row);
    else updateSelection(this.state, col, row);
  }
  private followScroll(
    delta: number,
    previous: Grid,
    viewport: Viewport,
  ): void {
    const s = this.state;
    if (!hasSelection(s) || viewport.height <= 0) return;
    const minRow = viewport.top;
    const maxRow = viewport.top + viewport.height - 1;
    const [start, end] = selectionBounds(s)!;
    if (start.row > maxRow || end.row < minRow) return;
    if (delta > 0)
      captureScrolledRows(
        s,
        previous,
        minRow,
        Math.min(maxRow, minRow + delta - 1),
        'above',
      );
    else
      captureScrolledRows(
        s,
        previous,
        Math.max(minRow, maxRow + delta + 1),
        maxRow,
        'below',
      );
    if (s.isDragging) {
      // dragging: the anchor goes with the text, the end stays under the mouse
      shiftAnchor(s, -delta, minRow, maxRow);
      if (this.dragPoint) this.dragTo(this.dragPoint.col, this.dragPoint.row);
    } else shiftSelection(s, -delta, minRow, maxRow, previous.width);
  }
  private startAutoscroll(row: number): void {
    const viewport = this.view?.viewport;
    let delta = 0;
    if (viewport && viewport.height > 2) {
      if (row <= viewport.top + 1) delta = -AUTOSCROLL_ROWS;
      else if (row >= viewport.top + viewport.height - 2)
        delta = AUTOSCROLL_ROWS;
    }
    if (!delta) {
      this.stopAutoscroll();
      return;
    }
    if (this.autoscroll && this.autoscrollDelta === delta) return;
    this.stopAutoscroll();
    this.autoscrollDelta = delta;
    this.armAutoscroll();
  }
  private armAutoscroll(): void {
    const timer = setTimeout(() => {
      if (this.autoscroll !== timer) return;
      if (!this.state.isDragging || !this.autoscrollDelta) {
        this.stopAutoscroll();
        return;
      }
      this.host.scroll(this.autoscrollDelta);
      this.armAutoscroll();
    }, AUTOSCROLL_MS);
    this.autoscroll = timer;
  }
  private stopAutoscroll(): void {
    if (this.autoscroll) clearTimeout(this.autoscroll);
    this.autoscroll = undefined;
    this.autoscrollDelta = 0;
  }
}
