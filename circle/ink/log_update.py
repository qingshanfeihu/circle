
from __future__ import annotations

from .screen import CharPool, DiffOp, Screen, StylePool, diff_screens
from .termio.csi import (
    cursor_horizontal_absolute,
    cursor_position,
    erase_in_line,
)
from .termio.dec import BSU, ESU, HIDE_CURSOR, SHOW_CURSOR


def render_frame(
    prev: Screen,
    curr: Screen,
    style_pool: StylePool,
    char_pool: CharPool,
    *,
    use_sync_update: bool = True,
) -> str:
    ops = diff_screens(prev, curr, style_pool, char_pool)
    if not ops:
        return ""

    parts: list[str] = []

    if use_sync_update:
        parts.append(BSU)
    parts.append(HIDE_CURSOR)

    for op in ops:
        parts.append(cursor_position(op.y + 1, op.x + 1))
        parts.append(op.content)

    parts.append(SHOW_CURSOR)
    if use_sync_update:
        parts.append(ESU)

    return "".join(parts)


def render_full(
    screen: Screen,
    style_pool: StylePool,
    char_pool: CharPool,
    *,
    use_sync_update: bool = True,
) -> str:
    parts: list[str] = []

    if use_sync_update:
        parts.append(BSU)
    parts.append(HIDE_CURSOR)

    for y in range(screen.height):
        parts.append(cursor_position(y + 1, 1))
        last_style = style_pool.none
        for x in range(screen.width):
            cell = screen.get_cell(x, y)
            if cell.width == 2:
                continue
            transition = style_pool.transition(last_style, cell.style_id)
            parts.append(transition)
            parts.append(char_pool.get(cell.char_id))
            last_style = cell.style_id
        if last_style != style_pool.none:
            parts.append("\x1b[0m")

    parts.append(SHOW_CURSOR)
    if use_sync_update:
        parts.append(ESU)

    return "".join(parts)
