"""The welcome block: the first thing in every session's transcript, the folder's home page.

The logo (``docs/images/logo.svg``) on the left: the composer frame's rainbow closed into a
ring, blue at the top, then purple, red and orange clockwise. Beside it Circle's version, the
model and where it runs, and the folder. Under it what the folder brings (its instructions,
skills, commands, extensions, settings), each with a lamp, and the folder's recent sessions.

It is drawn, never stored: the session asks for the rows again whenever the width, the
palette or what it shows changes, so no colour outlives a repaint.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from functools import lru_cache
from itertools import pairwise

from ..string_width import char_width, string_width
from ..theme import fg_sgr, palette, rgb_to_hex, status_light
from .dialog_frame import _GRADIENT_STOPS

LOGO_ROWS = 6          # the ring is LOGO_ROWS tall and twice as many columns wide
LOGO_MIN_WIDTH = 50    # narrower than this, the welcome is text only
_RING_INNER = 0.66     # inner radius / outer radius, thickened a little for the coarse grid
# The logo's own stops: the frame's colours at the quarters, as logo.svg draws them
_LOGO_STOPS = tuple((i / 4, _GRADIENT_STOPS[i][1]) for i in range(4)) + ((1.0, _GRADIENT_STOPS[0][1]),)
# Quadrant blocks by which of the four sub-cells are on: top-left 8, top-right 4,
# bottom-left 2, bottom-right 1
_QUADRANTS = {8: "▘", 4: "▝", 2: "▖", 1: "▗", 12: "▀", 3: "▄", 10: "▌", 5: "▐", 9: "▚", 6: "▞",
              14: "▛", 13: "▜", 11: "▙", 7: "▟", 15: "█"}


@dataclass
class WelcomeItem:
    """One row of what the folder brings."""

    kind: str
    text: str
    state: str = "none"                              # none | running | ok | error
    errors: list[str] = field(default_factory=list)  # under the row, in red, when it failed


@dataclass
class WelcomeInfo:
    version: str
    model: str = ""            # "" until setup has connected a model
    endpoint: str = ""
    folder: str = ""
    branch: str = ""
    items: list[WelcomeItem] = field(default_factory=list)
    recent: list[tuple[str, str]] = field(default_factory=list)  # (title, how long ago)
    more: int = 0              # recent sessions not listed


def _gradient(u: float) -> tuple[float, float, float]:
    u %= 1.0
    for (p0, c0), (p1, c1) in pairwise(_LOGO_STOPS):
        if u <= p1:
            t = (u - p0) / (p1 - p0)
            return tuple(c0[i] + (c1[i] - c0[i]) * t for i in range(3))
    return _LOGO_STOPS[-1][1]


@lru_cache(maxsize=1)
def _ring_cells() -> tuple[tuple[tuple[int, tuple[int, int, int] | None], ...], ...]:
    """The ring as quadrant cells: (which sub-cells are on, the cell's colour). A cell is about
    twice as tall as it is wide, so a grid twice as wide as it is tall draws a round ring."""
    rows, cols, samples = LOGO_ROWS, LOGO_ROWS * 2, 8
    grid = []
    for r in range(rows):
        line = []
        for c in range(cols):
            bits, colours = 0, []
            for i, (qx, qy) in enumerate(((0, 0), (1, 0), (0, 1), (1, 1))):
                hit, acc = 0, [0.0, 0.0, 0.0]
                for sy in range(samples):
                    for sx in range(samples):
                        x = -1 + (2 * c + qx + (sx + 0.5) / samples) / cols
                        y = -1 + (2 * r + qy + (sy + 0.5) / samples) / rows
                        if _RING_INNER <= math.hypot(x, y) <= 1.0:
                            hit += 1
                            rgb = _gradient(math.atan2(x, -y) / (2 * math.pi))
                            for k in range(3):
                                acc[k] += rgb[k]
                if hit * 2 >= samples * samples:
                    bits |= 8 >> i
                    colours.append(tuple(a / hit for a in acc))
            colour = (tuple(round(sum(col[k] for col in colours) / len(colours)) for k in range(3))
                      if colours else None)
            line.append((bits, colour))
        grid.append(tuple(line))
    return tuple(grid)


def logo_rows() -> list[str]:
    """The ring, ``LOGO_ROWS`` rows of ``2 * LOGO_ROWS`` columns."""
    reset = palette().reset
    rows = []
    for line in _ring_cells():
        parts = []
        for bits, colour in line:
            if not bits or colour is None:
                parts.append(f"{reset} ")
            else:
                parts.append(f"{fg_sgr(rgb_to_hex(colour))}{_QUADRANTS[bits]}")
        rows.append("".join(parts) + reset)
    return rows


def _cut_end(text: str, cols: int) -> str:
    if string_width(text) <= cols:
        return text
    kept, used = [], 0
    for ch in text:
        if used + char_width(ch) > cols - 1:
            break
        kept.append(ch)
        used += char_width(ch)
    return "".join(kept) + "…"


def _cut_start(text: str, cols: int) -> str:
    """A path cut from the left: the tail is what tells folders apart."""
    if string_width(text) <= cols:
        return text
    kept, used = [], 0
    for ch in reversed(text):
        if used + char_width(ch) > cols - 1:
            break
        kept.append(ch)
        used += char_width(ch)
    return "…" + "".join(reversed(kept))


def welcome_rows(info: WelcomeInfo, width: int) -> list[str]:
    """The block's rows for a transcript ``width`` columns wide, ending in one blank row."""
    pal = palette()
    width = max(20, int(width))
    with_logo = width >= LOGO_MIN_WIDTH
    indent = 2 + LOGO_ROWS * 2 + 3 if with_logo else 1
    room = max(8, width - indent - 1)
    if info.model:
        host = f" · {info.endpoint}" if info.endpoint else ""
        model = _cut_end(info.model, room)
        connection = f"{pal.text}{model}{pal.reset}{pal.dim}{_cut_end(host, room - string_width(model))}{pal.reset}"
    else:
        connection = f"{pal.faint}not connected yet{pal.reset}"
    branch = f" ({info.branch})" if info.branch else ""
    folder = _cut_start(info.folder, max(4, room - string_width(branch)))
    identity = [
        f"{pal.em}circle{pal.reset} {pal.faint}{info.version}{pal.reset}",
        connection,
        f"{pal.text}{folder}{pal.reset}{pal.dim}{branch}{pal.reset}",
    ]
    rows: list[str] = []
    if with_logo:
        beside = ["", *identity] + [""] * (LOGO_ROWS - 1 - len(identity))
        for ring, text in zip(logo_rows(), beside):
            rows.append(f"  {ring}   {text}" if text else f"  {ring}")
    else:
        rows += [f" {text}" for text in identity]

    if info.items:
        rows.append("")
        name_w = max(string_width(item.kind) for item in info.items) + 2
        for item in info.items:
            lit = item.state != "none"
            lamp = status_light(item.state) if lit else " "
            value = _cut_end(item.text, max(4, width - 3 - name_w - 1))
            rows.append(f" {lamp} {pal.dim if lit else pal.faint}{item.kind.ljust(name_w)}{pal.reset}"
                        f"{pal.text if lit else pal.faint}{value}{pal.reset}")
            for error in item.errors if item.state == "error" else ():
                rows.append(f"   {' ' * name_w}{pal.red}{_cut_end(error, max(4, width - 3 - name_w - 1))}{pal.reset}")

    if info.recent:
        rows.append("")
        rows.append(f"   {pal.faint}recent{pal.reset}")
        ages = max(string_width(age) for _title, age in info.recent)
        title_room = max(8, width - 3 - 3 - ages - 1)
        titles = [_cut_end(title, title_room) for title, _age in info.recent]
        title_w = max(string_width(title) for title in titles) + 3
        for title, (_title, age) in zip(titles, info.recent):
            pad = " " * (title_w - string_width(title))
            rows.append(f"   {pal.text}{title}{pal.reset}{pad}{pal.dim}{age.rjust(ages)}{pal.reset}")
        if info.more:
            rows.append(f"   {pal.dim}… +{info.more} more · /resume{pal.reset}")
    rows.append("")
    return rows


__all__ = ["LOGO_MIN_WIDTH", "LOGO_ROWS", "WelcomeInfo", "WelcomeItem", "logo_rows", "welcome_rows"]
