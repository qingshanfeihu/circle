
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .screen import (
    CELL_NORMAL,
    CELL_SPACER,
    CELL_WIDE,
    CharPool,
    Screen,
    StylePool,
)
from .string_width import string_width

_ANSI_RE = re.compile(r"(\x1b\[[0-9;]*m)")


@dataclass(slots=True)
class WriteOp:
    type: str = "write"
    x: int = 0
    y: int = 0
    text: str = ""
    style_id: int = 0
    clip_rect: tuple[int, int, int, int] | None = None


@dataclass(slots=True)
class ClearOp:
    type: str = "clear"
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0


@dataclass(slots=True)
class ClipOp:
    type: str = "clip"
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0


Operation = WriteOp | ClearOp | ClipOp


class Output:

    def __init__(
        self,
        width: int,
        height: int,
        char_pool: CharPool,
        style_pool: StylePool,
        screen: Screen,
    ) -> None:
        self._width = width
        self._height = height
        self._char_pool = char_pool
        self._style_pool = style_pool
        self._screen = screen
        self._ops: list[Operation] = []
        self._clip_stack: list[tuple[int, int, int, int]] = []

    @property
    def width(self) -> int:
        return self._width

    @property
    def height(self) -> int:
        return self._height

    def write(self, x: int, y: int, text: str, style_id: int = 0) -> None:
        clip = self._clip_stack[-1] if self._clip_stack else None
        self._ops.append(WriteOp(x=x, y=y, text=text, style_id=style_id, clip_rect=clip))

    def clear(self, x: int, y: int, width: int, height: int) -> None:
        self._ops.append(ClearOp(x=x, y=y, width=width, height=height))

    def push_clip(self, x: int, y: int, width: int, height: int) -> None:
        self._clip_stack.append((x, y, width, height))

    def pop_clip(self) -> None:
        if self._clip_stack:
            self._clip_stack.pop()

    def apply(self) -> None:
        self._screen.reset()
        for op in self._ops:
            if isinstance(op, WriteOp):
                self._apply_write(op)
            elif isinstance(op, ClearOp):
                self._apply_clear(op)
        self._ops.clear()

    def _wrap_cols(self, op: WriteOp) -> list[int]:
        cols: list[int] = []
        for line in _ANSI_RE.sub("", op.text).split("\n"):
            wrap_col = op.x + _content_col(line)
            if wrap_col >= self._width:
                wrap_col = op.x
            cols.append(wrap_col)
        return cols

    def _apply_write(self, op: WriteOp) -> None:
        segments = _ANSI_RE.split(op.text)
        wrap_cols = self._wrap_cols(op)

        row_y = op.y
        col = op.x
        current_style = op.style_id
        line_idx = 0
        wrap_col = wrap_cols[0] if wrap_cols else op.x

        for segment in segments:
            if not segment:
                continue
            
            if segment.startswith("\x1b[") and segment.endswith("m"):
                
                if segment == "\x1b[0m":
                    current_style = op.style_id
                else:
                    
                    base_codes = self._style_pool.get(op.style_id)
                    current_style = self._style_pool.intern(base_codes + [segment])
                continue

            
            lines = segment.split("\n")
            for li, line in enumerate(lines):
                if li > 0:
                    row_y += 1
                    col = op.x
                    line_idx += 1
                    wrap_col = wrap_cols[line_idx] if line_idx < len(wrap_cols) else op.x
                if row_y >= self._height:
                    break
                for ch in line:
                    w = _char_width(ch)
                    if col >= self._width:
                        col = wrap_col
                        row_y += 1
                        if row_y >= self._height:
                            break
                    if w == 2 and col + 1 >= self._width:
                        if row_y >= 0 and (not op.clip_rect or (
                            op.clip_rect[0] <= col < op.clip_rect[0] + op.clip_rect[2]
                            and op.clip_rect[1] <= row_y < op.clip_rect[1] + op.clip_rect[3]
                        )):
                            self._screen.set_cell(col, row_y, 0, current_style)
                        col = wrap_col
                        row_y += 1
                        if row_y >= self._height:
                            break
                    if row_y < 0 or col < 0:
                        col += w
                        continue
                    if op.clip_rect:
                        cx, cy, cw, ch_h = op.clip_rect
                        if not (cx <= col < cx + cw and cy <= row_y < cy + ch_h):
                            col += w
                            continue
                    char_id = self._char_pool.intern(ch)
                    self._screen.set_cell(col, row_y, char_id, current_style)
                    if w == 2 and col + 1 < self._width:
                        self._screen.set_cell(col + 1, row_y, 1, current_style, width=CELL_SPACER)
                    col += w
            if row_y >= self._height:
                break
        

    def _apply_clear(self, op: ClearOp) -> None:
        none = self._style_pool.none
        for dy in range(op.height):
            row_y = op.y + dy
            if row_y < 0 or row_y >= self._height:
                continue
            for dx in range(op.width):
                col = op.x + dx
                if 0 <= col < self._width:
                    self._screen.set_cell(col, row_y, 0, none)


from .string_width import _LINE_MARKERS, _content_col  # noqa: E402,F401
from .string_width import char_width as _char_width  # noqa: E402
