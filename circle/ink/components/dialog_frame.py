"""Closed-loop composer frame.

While busy, one rainbow travels the rounded rectangle. The status text on
the top edge takes its color from that same sweep, so the word does not run
a second shimmer. The rainbow is the one place colors bypass ``palette()``
(its fixed gradient is the design); the quiet frame uses the palette, and
``CIRCLE_TUI_SHIMMER=0`` keeps the frame quiet while busy.
"""

from __future__ import annotations

import re

from circle.ink import shimmer
from circle.ink.string_width import char_width, string_width
from circle.ink.theme import palette

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

_RESET = "\x1b[0m"

# Blue → purple → red → orange, then back to blue.
_GRADIENT_STOPS = (
    (0.00, (8, 148, 255)),
    (0.30, (201, 89, 221)),
    (0.65, (255, 46, 84)),
    (0.90, (255, 144, 4)),
    (1.00, (8, 148, 255)),
)


def _visible_width(text: str) -> int:
    return string_width(_ANSI_RE.sub("", text))


def _truncate_visible(text: str, max_w: int) -> str:
    if max_w <= 0 or not text:
        return ""
    if _visible_width(text) <= max_w:
        return text
    budget = max_w - 1
    if budget <= 0:
        return ""
    out: list[str] = []
    width = 0
    i = 0
    n = len(text)
    while i < n:
        if text[i] == "\x1b":
            j = i + 1
            if j < n and text[j] == "[":
                j += 1
                while j < n and not ("@" <= text[j] <= "~"):
                    j += 1
                j = min(j + 1, n)
            out.append(text[i:j])
            i = j
            continue
        cw = char_width(text[i])
        if width + cw > budget:
            break
        out.append(text[i])
        width += cw
        i += 1
    out.append("…")
    return "".join(out)


def _conic_gradient(u: float) -> tuple[int, int, int]:
    u %= 1.0
    for (p0, c0), (p1, c1) in zip(_GRADIENT_STOPS, _GRADIENT_STOPS[1:]):
        if u <= p1:
            t = (u - p0) / (p1 - p0) if p1 > p0 else 0.0
            return tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))
    return _GRADIENT_STOPS[-1][1]


def _color_at(index: int, perimeter: int, elapsed: float) -> tuple[int, int, int]:
    flow = (elapsed * 0.12) % 1.0
    frac = index / max(perimeter, 1)
    return _conic_gradient((frac + flow) % 1.0)


def _sgr(color: tuple[int, int, int]) -> str:
    return f"\x1b[38;2;{color[0]};{color[1]};{color[2]}m"


def _paint(glyphs: list[str], indices: list[int], perimeter: int, elapsed: float) -> str:
    parts: list[str] = []
    for glyph, index in zip(glyphs, indices):
        parts.append(_sgr(_color_at(index, perimeter, elapsed)))
        parts.append(glyph)
    parts.append(_RESET)
    return "".join(parts)


def _quiet_frame(width: int, label: str) -> tuple[str, str, str, str]:
    pal = palette()
    plain = _ANSI_RE.sub("", label or "")
    shown = _truncate_visible(plain, max(0, width - 6)) if plain else ""
    if shown:
        rest = "─" * max(0, width - 3 - string_width(shown))
        top = f"{pal.faint}╭─{pal.reset}{pal.text}{shown}{pal.reset}{pal.faint}{rest}╮{pal.reset}"
    else:
        top = f"{pal.faint}╭{'─' * (width - 2)}╮{pal.reset}"
    bottom = f"{pal.faint}╰{'─' * (width - 2)}╯{pal.reset}"
    side = f"{pal.faint}│{pal.reset}"
    return top, side, side, bottom


def build_loop_frame(
    width: int,
    *,
    elapsed: float | None,
    label: str = "",
) -> tuple[str, str, str, str]:
    """Return ``(top, left, right, bottom)`` for one closed frame.

    ``elapsed is None`` draws a quiet frame. A number runs the rainbow around
    the loop and through the label.
    """
    width = max(4, int(width))
    if elapsed is None or not shimmer.enabled():
        return _quiet_frame(width, "" if elapsed is None else label)

    perimeter = 2 * (width + 1)  # height is 3: two rims + one content row
    # Drop any shimmer the caller already painted. This sweep owns the color.
    plain_label = _ANSI_RE.sub("", label or "")
    label_w_budget = max(0, width - 6)
    shown = _truncate_visible(plain_label, label_w_budget) if plain_label else ""
    label_w = string_width(shown)
    label_at = 3
    if label_w <= 0 or label_at + label_w > width - 3:
        shown = ""

    top_glyphs = ["╭", *["─"] * (width - 2), "╮"]
    top_parts: list[str] = []
    col = 0

    def emit(glyph: str, index: int) -> None:
        top_parts.append(_sgr(_color_at(index, perimeter, elapsed)))
        top_parts.append(glyph)

    while col < (label_at if shown else width):
        emit(top_glyphs[col], col)
        col += 1
    if shown:
        for ch in shown:
            emit(ch, col)
            col += char_width(ch)
        while col < width:
            emit(top_glyphs[col], col)
            col += 1
    top_parts.append(_RESET)

    right = _sgr(_color_at(width, perimeter, elapsed)) + "│" + _RESET
    bottom_glyphs = ["╰", *["─"] * (width - 2), "╯"]
    # Clockwise along the bottom runs from the right corner back to the left.
    bottom_indices = [2 * width - col for col in range(width)]
    bottom = _paint(bottom_glyphs, bottom_indices, perimeter, elapsed)
    left = _sgr(_color_at(2 * width + 1, perimeter, elapsed)) + "│" + _RESET
    return "".join(top_parts), left, right, bottom
