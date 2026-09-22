
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal

from .screen import (
    CELL_NORMAL,
    CELL_SPACER,
    CELL_WIDE,
    Screen,
    StylePool,
    set_cell_style_id,
)


@dataclass(slots=True)
class Point:
    col: int
    row: int


@dataclass(slots=True)
class AnchorSpan:
    lo: Point
    hi: Point
    kind: Literal["word", "line"]


@dataclass(slots=True)
class SelectionState:

    anchor: Point | None = None
    """Where the mouse-down occurred. None when no selection."""

    focus: Point | None = None
    """Current drag position (updated on mouse-move while dragging)."""

    is_dragging: bool = False
    """True between mouse-down and mouse-up."""

    anchor_span: AnchorSpan | None = None
    """For word/line mode: the initial word/line bounds from the first
    multi-click. Drag extends from this span to the word/line at the
    current mouse position so the original word/line stays selected
    even when dragging backward past it. None ⇔ char mode."""

    scrolled_off_above: list[str] = field(default_factory=list)
    """Text from rows that scrolled out ABOVE the viewport during
    drag-to-scroll. The screen buffer only holds the current viewport,
    so without this accumulator, dragging down past the bottom edge
    loses the top of the selection once the anchor clamps. Prepended
    to the on-screen text by get_selected_text. Reset on start/clear."""

    scrolled_off_below: list[str] = field(default_factory=list)
    """Symmetric: rows scrolled out BELOW when dragging up. Appended."""

    scrolled_off_above_sw: list[bool] = field(default_factory=list)
    """Soft-wrap bits parallel to scrolled_off_above — True means the
    row is a continuation of the one before it (the `\\n` was inserted
    by word-wrap, not in the source). Captured alongside the text at
    scroll time since the screen's softWrap bitmap shifts with content."""

    scrolled_off_below_sw: list[bool] = field(default_factory=list)
    """Parallel to scrolled_off_below."""

    virtual_anchor_row: int | None = None
    """Pre-clamp anchor row. Set when shift_selection clamps anchor so a
    reverse scroll can restore the true position and pop accumulators."""

    virtual_focus_row: int | None = None
    """Same for focus."""

    last_press_had_alt: bool = False
    """True if the mouse-down that started this selection had the alt
    modifier set (SGR button bit 0x08)."""


def create_selection_state() -> SelectionState:
    return SelectionState()


def start_selection(s: SelectionState, col: int, row: int, *, alt: bool = False) -> None:
    s.anchor = Point(col=col, row=row)
    
    
    
    
    s.focus = None
    s.is_dragging = True
    s.anchor_span = None
    s.scrolled_off_above = []
    s.scrolled_off_below = []
    s.scrolled_off_above_sw = []
    s.scrolled_off_below_sw = []
    s.virtual_anchor_row = None
    s.virtual_focus_row = None
    s.last_press_had_alt = alt


def update_selection(s: SelectionState, col: int, row: int) -> None:
    if not s.is_dragging:
        return
    
    
    
    
    
    
    if (
        s.focus is None
        and s.anchor is not None
        and s.anchor.col == col
        and s.anchor.row == row
    ):
        return
    s.focus = Point(col=col, row=row)


def finish_selection(s: SelectionState) -> None:
    s.is_dragging = False
    
    


def clear_selection(s: SelectionState) -> None:
    s.anchor = None
    s.focus = None
    s.is_dragging = False
    s.anchor_span = None
    s.scrolled_off_above = []
    s.scrolled_off_below = []
    s.scrolled_off_above_sw = []
    s.scrolled_off_below_sw = []
    s.virtual_anchor_row = None
    s.virtual_focus_row = None
    s.last_press_had_alt = False


def has_selection(s: SelectionState) -> bool:
    return s.anchor is not None and s.focus is not None


_WORD_CHAR = re.compile(r"[\w\-/.+~\\]", re.UNICODE)


def _char_class(c: str) -> int:
    if c == " " or c == "":
        return 0
    if _WORD_CHAR.match(c):
        return 1
    return 2


def _word_bounds_at(
    screen: Screen, col: int, row: int
) -> tuple[int, int] | None:
    if row < 0 or row >= screen.height:
        return None
    width = screen.width

    
    
    c = col
    if c > 0:
        cell = screen.get_cell(c, row)
        if cell.width == CELL_SPACER:
            c -= 1
    if c < 0 or c >= width or screen.is_no_select(c, row):
        return None

    start_cell = screen.get_cell(c, row)
    cls = _char_class(screen.char_pool.get(start_cell.char_id))

    
    lo = c
    while lo > 0:
        prev = lo - 1
        if screen.is_no_select(prev, row):
            break
        pc = screen.get_cell(prev, row)
        if pc.width == CELL_SPACER:
            
            if prev == 0 or screen.is_no_select(prev - 1, row):
                break
            head = screen.get_cell(prev - 1, row)
            if _char_class(screen.char_pool.get(head.char_id)) != cls:
                break
            lo = prev - 1
            continue
        if _char_class(screen.char_pool.get(pc.char_id)) != cls:
            break
        lo = prev

    
    hi = c
    while hi < width - 1:
        nxt = hi + 1
        if screen.is_no_select(nxt, row):
            break
        nc = screen.get_cell(nxt, row)
        if nc.width == CELL_SPACER:
            
            
            hi = nxt
            continue
        if _char_class(screen.char_pool.get(nc.char_id)) != cls:
            break
        hi = nxt

    return lo, hi


def _compare_points(a: Point, b: Point) -> int:
    if a.row != b.row:
        return -1 if a.row < b.row else 1
    if a.col != b.col:
        return -1 if a.col < b.col else 1
    return 0


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def select_word_at(s: SelectionState, screen: Screen, col: int, row: int) -> None:
    b = _word_bounds_at(screen, col, row)
    if b is None:
        return
    lo = Point(col=b[0], row=row)
    hi = Point(col=b[1], row=row)
    s.anchor = lo
    s.focus = hi
    s.is_dragging = True
    s.anchor_span = AnchorSpan(lo=lo, hi=hi, kind="word")


def select_line_at(s: SelectionState, screen: Screen, row: int) -> None:
    if row < 0 or row >= screen.height:
        return
    lo = Point(col=0, row=row)
    hi = Point(col=screen.width - 1, row=row)
    s.anchor = lo
    s.focus = hi
    s.is_dragging = True
    s.anchor_span = AnchorSpan(lo=lo, hi=hi, kind="line")


def extend_selection(s: SelectionState, screen: Screen, col: int, row: int) -> None:
    if not s.is_dragging or s.anchor_span is None:
        return
    span = s.anchor_span
    if span.kind == "word":
        b = _word_bounds_at(screen, col, row)
        m_lo = Point(col=(b[0] if b else col), row=row)
        m_hi = Point(col=(b[1] if b else col), row=row)
    else:
        r = _clamp(row, 0, screen.height - 1)
        m_lo = Point(col=0, row=r)
        m_hi = Point(col=screen.width - 1, row=r)

    if _compare_points(m_hi, span.lo) < 0:
        s.anchor = span.hi
        s.focus = m_lo
    elif _compare_points(m_lo, span.hi) > 0:
        s.anchor = span.lo
        s.focus = m_hi
    else:
        s.anchor = span.lo
        s.focus = span.hi


def selection_bounds(s: SelectionState) -> tuple[Point, Point] | None:
    if s.anchor is None or s.focus is None:
        return None
    if _compare_points(s.anchor, s.focus) <= 0:
        return s.anchor, s.focus
    return s.focus, s.anchor


def is_cell_selected(s: SelectionState, col: int, row: int) -> bool:
    b = selection_bounds(s)
    if b is None:
        return False
    start, end = b
    if row < start.row or row > end.row:
        return False
    if row == start.row and col < start.col:
        return False
    if row == end.row and col > end.col:
        return False
    return True


def _extract_row_text(
    screen: Screen, row: int, col_start: int, col_end: int
) -> str:
    content_end = (
        screen.soft_wrap_starts_at[row + 1] if row + 1 < screen.height else 0
    )
    last_col = (
        min(col_end, content_end - 1) if content_end > 0 else col_end
    )
    chars: list[str] = []
    col = col_start
    while col <= last_col:
        if screen.is_no_select(col, row):
            col += 1
            continue
        cell = screen.get_cell(col, row)
        if cell.width == CELL_SPACER:
            col += 1
            continue
        ch = screen.char_pool.get(cell.char_id)
        chars.append(ch)
        col += 1
    line = "".join(chars)
    if content_end > 0:
        return line
    
    return line.rstrip()


def _join_rows(lines: list[str], text: str, sw: bool) -> None:
    if sw and lines:
        lines[-1] += text
    else:
        lines.append(text)


def get_selected_text(s: SelectionState, screen: Screen) -> str:
    b = selection_bounds(s)
    if b is None:
        return ""
    start, end = b
    sw = screen.soft_wrap_starts_at
    lines: list[str] = []

    for i in range(len(s.scrolled_off_above)):
        _join_rows(lines, s.scrolled_off_above[i], s.scrolled_off_above_sw[i])

    for row in range(start.row, end.row + 1):
        if row < 0 or row >= screen.height:
            continue
        row_start = start.col if row == start.row else 0
        row_end = end.col if row == end.row else screen.width - 1
        _join_rows(
            lines, _extract_row_text(screen, row, row_start, row_end), sw[row] > 0
        )

    for i in range(len(s.scrolled_off_below)):
        _join_rows(lines, s.scrolled_off_below[i], s.scrolled_off_below_sw[i])

    return "\n".join(lines)


def apply_selection_overlay(
    screen: Screen, s: SelectionState, style_pool: StylePool
) -> None:
    b = selection_bounds(s)
    if b is None:
        return
    start, end = b
    width = screen.width
    for row in range(start.row, min(end.row + 1, screen.height)):
        col_start = start.col if row == start.row else 0
        col_end = (
            min(end.col, width - 1) if row == end.row else width - 1
        )
        col = col_start
        while col <= col_end:
            if screen.is_no_select(col, row):
                col += 1
                continue
            cell = screen.get_cell(col, row)
            new_id = style_pool.with_selection_bg(cell.style_id)
            set_cell_style_id(screen, col, row, new_id)
            col += 1


def capture_scrolled_rows(
    s: SelectionState,
    screen: Screen,
    first_row: int,
    last_row: int,
    side: Literal["above", "below"],
) -> None:
    b = selection_bounds(s)
    if b is None or first_row > last_row:
        return
    start, end = b
    lo = max(first_row, start.row)
    hi = min(last_row, end.row)
    if lo > hi:
        return

    width = screen.width
    sw = screen.soft_wrap_starts_at
    captured: list[str] = []
    captured_sw: list[bool] = []
    for row in range(lo, hi + 1):
        col_start = start.col if row == start.row else 0
        col_end = end.col if row == end.row else width - 1
        captured.append(_extract_row_text(screen, row, col_start, col_end))
        captured_sw.append(sw[row] > 0 if row < screen.height else False)

    if side == "above":
        s.scrolled_off_above.extend(captured)
        s.scrolled_off_above_sw.extend(captured_sw)
        
        
        if (
            s.anchor is not None
            and s.anchor.row == start.row
            and lo == start.row
        ):
            s.anchor = Point(col=0, row=s.anchor.row)
            if s.anchor_span is not None:
                s.anchor_span = AnchorSpan(
                    lo=Point(col=0, row=s.anchor_span.lo.row),
                    hi=Point(col=width - 1, row=s.anchor_span.hi.row),
                    kind=s.anchor_span.kind,
                )
    else:
        
        s.scrolled_off_below = captured + s.scrolled_off_below
        s.scrolled_off_below_sw = captured_sw + s.scrolled_off_below_sw
        if (
            s.anchor is not None
            and s.anchor.row == end.row
            and hi == end.row
        ):
            s.anchor = Point(col=width - 1, row=s.anchor.row)
            if s.anchor_span is not None:
                s.anchor_span = AnchorSpan(
                    lo=Point(col=0, row=s.anchor_span.lo.row),
                    hi=Point(col=width - 1, row=s.anchor_span.hi.row),
                    kind=s.anchor_span.kind,
                )


def shift_selection(
    s: SelectionState,
    d_row: int,
    min_row: int,
    max_row: int,
    width: int,
) -> None:
    if s.anchor is None or s.focus is None:
        return

    v_anchor = (s.virtual_anchor_row if s.virtual_anchor_row is not None else s.anchor.row) + d_row
    v_focus = (s.virtual_focus_row if s.virtual_focus_row is not None else s.focus.row) + d_row

    if (v_anchor < min_row and v_focus < min_row) or (
        v_anchor > max_row and v_focus > max_row
    ):
        clear_selection(s)
        return

    old_min = min(
        s.virtual_anchor_row if s.virtual_anchor_row is not None else s.anchor.row,
        s.virtual_focus_row if s.virtual_focus_row is not None else s.focus.row,
    )
    old_max = max(
        s.virtual_anchor_row if s.virtual_anchor_row is not None else s.anchor.row,
        s.virtual_focus_row if s.virtual_focus_row is not None else s.focus.row,
    )
    old_above_debt = max(0, min_row - old_min)
    old_below_debt = max(0, old_max - max_row)
    new_above_debt = max(0, min_row - min(v_anchor, v_focus))
    new_below_debt = max(0, max(v_anchor, v_focus) - max_row)

    if new_above_debt < old_above_debt:
        drop = old_above_debt - new_above_debt
        s.scrolled_off_above = s.scrolled_off_above[:-drop] if drop else s.scrolled_off_above
        s.scrolled_off_above_sw = s.scrolled_off_above_sw[: len(s.scrolled_off_above)]
    if new_below_debt < old_below_debt:
        drop = old_below_debt - new_below_debt
        s.scrolled_off_below = s.scrolled_off_below[drop:]
        s.scrolled_off_below_sw = s.scrolled_off_below_sw[drop:]

    
    if len(s.scrolled_off_above) > new_above_debt:
        if new_above_debt > 0:
            s.scrolled_off_above = s.scrolled_off_above[-new_above_debt:]
            s.scrolled_off_above_sw = s.scrolled_off_above_sw[-new_above_debt:]
        else:
            s.scrolled_off_above = []
            s.scrolled_off_above_sw = []
    if len(s.scrolled_off_below) > new_below_debt:
        s.scrolled_off_below = s.scrolled_off_below[:new_below_debt]
        s.scrolled_off_below_sw = s.scrolled_off_below_sw[:new_below_debt]

    def _shift(p: Point, v_row: int) -> Point:
        if v_row < min_row:
            return Point(col=0, row=min_row)
        if v_row > max_row:
            return Point(col=width - 1, row=max_row)
        return Point(col=p.col, row=v_row)

    s.anchor = _shift(s.anchor, v_anchor)
    s.focus = _shift(s.focus, v_focus)
    s.virtual_anchor_row = (
        v_anchor if v_anchor < min_row or v_anchor > max_row else None
    )
    s.virtual_focus_row = (
        v_focus if v_focus < min_row or v_focus > max_row else None
    )

    if s.anchor_span is not None:
        def _sp(p: Point) -> Point:
            r = p.row + d_row
            if r < min_row:
                return Point(col=0, row=min_row)
            if r > max_row:
                return Point(col=width - 1, row=max_row)
            return Point(col=p.col, row=r)

        s.anchor_span = AnchorSpan(
            lo=_sp(s.anchor_span.lo),
            hi=_sp(s.anchor_span.hi),
            kind=s.anchor_span.kind,
        )


def shift_anchor(
    s: SelectionState, d_row: int, min_row: int, max_row: int
) -> None:
    if s.anchor is None:
        return
    raw = (
        s.virtual_anchor_row if s.virtual_anchor_row is not None else s.anchor.row
    ) + d_row
    s.anchor = Point(col=s.anchor.col, row=_clamp(raw, min_row, max_row))
    s.virtual_anchor_row = (
        raw if raw < min_row or raw > max_row else None
    )
    if s.anchor_span is not None:
        def _shift(p: Point) -> Point:
            return Point(
                col=p.col, row=_clamp(p.row + d_row, min_row, max_row)
            )

        s.anchor_span = AnchorSpan(
            lo=_shift(s.anchor_span.lo),
            hi=_shift(s.anchor_span.hi),
            kind=s.anchor_span.kind,
        )


def shift_selection_for_follow(
    s: SelectionState, d_row: int, min_row: int, max_row: int
) -> bool:
    if s.anchor is None:
        return False

    raw_anchor = (
        s.virtual_anchor_row if s.virtual_anchor_row is not None else s.anchor.row
    ) + d_row
    raw_focus: int | None = None
    if s.focus is not None:
        raw_focus = (
            s.virtual_focus_row if s.virtual_focus_row is not None else s.focus.row
        ) + d_row

    if raw_anchor < min_row and raw_focus is not None and raw_focus < min_row:
        clear_selection(s)
        return True

    s.anchor = Point(col=s.anchor.col, row=_clamp(raw_anchor, min_row, max_row))
    if s.focus is not None and raw_focus is not None:
        s.focus = Point(col=s.focus.col, row=_clamp(raw_focus, min_row, max_row))
    s.virtual_anchor_row = (
        raw_anchor if raw_anchor < min_row or raw_anchor > max_row else None
    )
    s.virtual_focus_row = (
        raw_focus
        if raw_focus is not None and (raw_focus < min_row or raw_focus > max_row)
        else None
    )

    if s.anchor_span is not None:
        def _shift(p: Point) -> Point:
            return Point(
                col=p.col, row=_clamp(p.row + d_row, min_row, max_row)
            )

        s.anchor_span = AnchorSpan(
            lo=_shift(s.anchor_span.lo),
            hi=_shift(s.anchor_span.hi),
            kind=s.anchor_span.kind,
        )
    return False


def move_focus(s: SelectionState, col: int, row: int) -> None:
    if s.focus is None:
        return
    s.anchor_span = None
    s.focus = Point(col=col, row=row)
    s.virtual_focus_row = None
