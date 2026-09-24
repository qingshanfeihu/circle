
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class CharPool:

    def __init__(self) -> None:
        self._strings: list[str] = [" ", ""]
        self._map: dict[str, int] = {" ": 0, "": 1}
        self._ascii: list[int] = [-1] * 128
        self._ascii[ord(" ")] = 0

    def intern(self, char: str) -> int:
        if len(char) == 1:
            code = ord(char)
            if code < 128:
                cached = self._ascii[code]
                if cached != -1:
                    return cached
                idx = len(self._strings)
                self._strings.append(char)
                self._ascii[code] = idx
                return idx
        existing = self._map.get(char)
        if existing is not None:
            return existing
        idx = len(self._strings)
        self._strings.append(char)
        self._map[char] = idx
        return idx

    def get(self, index: int) -> str:
        if 0 <= index < len(self._strings):
            return self._strings[index]
        return " "


class StylePool:
    """Style interning pool. Each unique style combination gets an integer ID.

    Bit 0 of the ID encodes whether the style has a visible effect on space
    characters (background, inverse, underline). This lets the renderer skip
    invisible spaces with a single bitmask check.
    """

    def __init__(self) -> None:
        self._ids: dict[str, int] = {}
        self._styles: list[list[str]] = []
        self._transition_cache: dict[int, str] = {}
        self.none: int = self.intern([])
        
        
        # 选区底色由启动接线（palette().sel_bg）写入；写入前留空，
        # with_selection_bg 走反显兜底，不写死任何色值。
        self._selection_bg_codes: list[str] = []
        self._selection_bg_cache: dict[int, int] = {}

    def intern(self, codes: list[str]) -> int:
        key = "\0".join(codes) if codes else ""
        existing = self._ids.get(key)
        if existing is not None:
            return existing
        raw_id = len(self._styles)
        self._styles.append(codes[:] if codes else [])
        has_visible = any(_is_visible_on_space(c) for c in codes)
        encoded_id = (raw_id << 1) | (1 if has_visible else 0)
        self._ids[key] = encoded_id
        return encoded_id

    def get(self, encoded_id: int) -> list[str]:
        raw_id = encoded_id >> 1
        if 0 <= raw_id < len(self._styles):
            return self._styles[raw_id]
        return []

    def transition(self, from_id: int, to_id: int) -> str:
        if from_id == to_id:
            return ""
        cache_key = from_id * 0x100000 + to_id
        cached = self._transition_cache.get(cache_key)
        if cached is not None:
            return cached
        from_codes = self.get(from_id)
        to_codes = self.get(to_id)
        result = _diff_sgr(from_codes, to_codes)
        self._transition_cache[cache_key] = result
        return result

    
    
    

    def set_selection_bg(self, codes: list[str] | None) -> None:
        new_codes = list(codes) if codes else []
        if new_codes == self._selection_bg_codes:
            return
        self._selection_bg_codes = new_codes
        self._selection_bg_cache.clear()

    def with_selection_bg(self, base_id: int) -> int:
        cached = self._selection_bg_cache.get(base_id)
        if cached is not None:
            return cached
        sel_bg = self._selection_bg_codes
        if not sel_bg:
            
            
            kept = [c for c in self.get(base_id) if c != "\x1b[7m" and c != "\x1b[27m"]
            kept.append("\x1b[7m")
            new_id = self.intern(kept)
            self._selection_bg_cache[base_id] = new_id
            return new_id
        kept = [
            c for c in self.get(base_id)
            if not _is_bg_or_inverse_code(c)
        ]
        kept.extend(sel_bg)
        new_id = self.intern(kept)
        self._selection_bg_cache[base_id] = new_id
        return new_id

    def clear_selection_bg_cache(self) -> None:
        self._selection_bg_cache.clear()


def _is_bg_or_inverse_code(code: str) -> bool:
    if code in ("\x1b[49m", "\x1b[7m", "\x1b[27m"):
        return True
    if code.startswith("\x1b[48;"):
        return True
    if code.startswith("\x1b[4") and code.endswith("m") and len(code) == 5:
        
        digit = code[3]
        if digit.isdigit() and "0" <= digit <= "7":
            return True
    if code.startswith("\x1b[10") and code.endswith("m") and len(code) == 6:
        
        digit = code[4]
        if digit.isdigit() and "0" <= digit <= "7":
            return True
    return False


def _is_visible_on_space(code: str) -> bool:
    return code in ("\x1b[7m", "\x1b[4m", "\x1b[9m", "\x1b[53m") or (
        code.startswith("\x1b[4") and code.endswith("m") and code != "\x1b[4m"
    ) or code.startswith("\x1b[48;")


def _diff_sgr(from_codes: list[str], to_codes: list[str]) -> str:
    if not to_codes:
        return "\x1b[0m" if from_codes else ""
    if not from_codes:
        return "".join(to_codes)
    from_set = set(from_codes)
    to_set = set(to_codes)
    if from_set == to_set:
        return ""
    return "\x1b[0m" + "".join(to_codes)


CELL_NORMAL = 0
CELL_WIDE = 1
CELL_SPACER = 2


@dataclass(slots=True)
class Cell:
    char_id: int = 0
    style_id: int = 0
    hyperlink_id: int = 0
    width: int = CELL_NORMAL
    soft_wrap: bool = False


class Screen:

    def __init__(self, width: int, height: int, char_pool: CharPool, style_pool: StylePool) -> None:
        self.width = width
        self.height = height
        self.char_pool = char_pool
        self.style_pool = style_pool
        self._cells: list[list[Cell]] = [
            [Cell(char_id=0, style_id=style_pool.none) for _ in range(width)]
            for _ in range(height)
        ]
        self._soft_wrap_flags: list[bool] = [False] * height
        
        
        self.no_select: list[list[bool]] = [
            [False] * width for _ in range(height)
        ]
        
        
        
        
        
        
        self.soft_wrap_starts_at: list[int] = [0] * height

    def reset(self) -> None:
        none = self.style_pool.none
        for row in self._cells:
            for cell in row:
                cell.char_id = 0
                cell.style_id = none
                cell.hyperlink_id = 0
                cell.width = CELL_NORMAL
                cell.soft_wrap = False
        for i in range(self.height):
            self._soft_wrap_flags[i] = False
            self.soft_wrap_starts_at[i] = 0
        for row in self.no_select:
            for x in range(len(row)):
                row[x] = False

    def set_cell(self, x: int, y: int, char_id: int, style_id: int, hyperlink_id: int = 0, width: int = CELL_NORMAL) -> None:
        if 0 <= x < self.width and 0 <= y < self.height:
            cell = self._cells[y][x]
            cell.char_id = char_id
            cell.style_id = style_id
            cell.hyperlink_id = hyperlink_id
            cell.width = width

    def get_cell(self, x: int, y: int) -> Cell:
        if 0 <= x < self.width and 0 <= y < self.height:
            return self._cells[y][x]
        return Cell()

    def set_soft_wrap(self, y: int, value: bool) -> None:
        if 0 <= y < self.height:
            self._soft_wrap_flags[y] = value

    def get_soft_wrap(self, y: int) -> bool:
        if 0 <= y < self.height:
            return self._soft_wrap_flags[y]
        return False

    def set_soft_wrap_continuation(self, y: int, content_end_col: int) -> None:
        if 0 <= y < self.height:
            self.soft_wrap_starts_at[y] = max(0, content_end_col)

    def mark_no_select(self, x0: int, y0: int, x1: int, y1: int) -> None:
        x_lo = max(0, min(x0, x1))
        x_hi = min(self.width - 1, max(x0, x1))
        y_lo = max(0, min(y0, y1))
        y_hi = min(self.height - 1, max(y0, y1))
        for y in range(y_lo, y_hi + 1):
            row = self.no_select[y]
            for x in range(x_lo, x_hi + 1):
                row[x] = True

    def is_no_select(self, x: int, y: int) -> bool:
        if 0 <= x < self.width and 0 <= y < self.height:
            return self.no_select[y][x]
        return False

    def resize(self, width: int, height: int) -> None:
        none = self.style_pool.none
        new_cells: list[list[Cell]] = []
        for y in range(height):
            row: list[Cell] = []
            for x in range(width):
                if y < self.height and x < self.width:
                    row.append(self._cells[y][x])
                else:
                    row.append(Cell(char_id=0, style_id=none))
            new_cells.append(row)
        self._cells = new_cells
        new_wrap = [False] * height
        new_starts = [0] * height
        new_no_sel: list[list[bool]] = [[False] * width for _ in range(height)]
        for y in range(min(height, self.height)):
            new_wrap[y] = self._soft_wrap_flags[y]
            new_starts[y] = self.soft_wrap_starts_at[y]
            old_row = self.no_select[y]
            new_row = new_no_sel[y]
            for x in range(min(width, self.width)):
                new_row[x] = old_row[x]
        self._soft_wrap_flags = new_wrap
        self.soft_wrap_starts_at = new_starts
        self.no_select = new_no_sel
        self.width = width
        self.height = height


def set_cell_style_id(screen: Screen, x: int, y: int, style_id: int) -> None:
    if 0 <= x < screen.width and 0 <= y < screen.height:
        screen._cells[y][x].style_id = style_id


@dataclass(slots=True)
class DiffOp:
    x: int
    y: int
    content: str


def diff_screens(prev: Screen, curr: Screen, style_pool: StylePool, char_pool: CharPool) -> list[DiffOp]:
    ops: list[DiffOp] = []
    height = min(prev.height, curr.height)
    width = min(prev.width, curr.width)

    for y in range(height):
        prev_row = prev._cells[y]
        curr_row = curr._cells[y]
        x = 0
        while x < width:
            pc = prev_row[x]
            cc = curr_row[x]
            if pc.char_id == cc.char_id and pc.style_id == cc.style_id and pc.hyperlink_id == cc.hyperlink_id:
                x += 1
                continue
            
            span_start = x
            if span_start > 0 and (curr_row[span_start].width == CELL_SPACER
                                   or prev_row[span_start].width == CELL_SPACER):
                span_start -= 1
                x = span_start
            buf: list[str] = []
            last_style_id = style_pool.none
            first_cell = True
            while x < width:
                pc2 = prev_row[x]
                cc2 = curr_row[x]
                if (not first_cell and pc2.char_id == cc2.char_id
                        and pc2.style_id == cc2.style_id and pc2.hyperlink_id == cc2.hyperlink_id):
                    break
                first_cell = False
                transition = style_pool.transition(last_style_id, cc2.style_id)
                buf.append(transition)
                buf.append(char_pool.get(cc2.char_id))
                last_style_id = cc2.style_id
                x += 1

            if last_style_id != style_pool.none:
                buf.append("\x1b[0m")
            ops.append(DiffOp(x=span_start, y=y, content="".join(buf)))

    return ops
