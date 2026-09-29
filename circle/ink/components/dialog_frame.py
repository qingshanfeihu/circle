"""Closed-loop composer frame.

The frame's colour says whose turn it is (2026-09-29 contract): while the model runs, one
rainbow travels the rounded rectangle, and the busy word sits on the top edge from column 3
taking its colour from that same sweep. On the user's turn (a card holds the frame) it is
static in the ``border`` colour, yellow. Otherwise it is faint and static. The one-word mode
(``read-only`` / ``auto``) sits at the bottom-right corner in its own colour, never the
rainbow. An observability alert sits on the bottom edge from column 3 in yellow (on a static
bottom edge), so it never takes a footer row; while one shows, the mode word gives way. The rainbow is the
one place colors bypass ``palette()`` (its fixed gradient is the design); the
quiet frame uses the palette, and ``CIRCLE_TUI_SHIMMER=0`` keeps the frame
quiet while busy.
"""

from __future__ import annotations

import re

from circle.ink import shimmer
from circle.ink.string_width import char_width, string_width
from circle.ink.theme import contrast_ratio, mix, palette, rgb_to_hex, hex_to_rgb

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


_stops_cache: dict[str, tuple] = {}


def _stops_for(bg_hex: str) -> tuple:
    """The gradient stops, each darkened just enough to stay visible on ``bg_hex``.

    On a dark terminal the stops are used as they are. On a light one the orange and the blue
    would fade into the background, so each is mixed toward black until it reaches 3:1."""
    stops = _stops_cache.get(bg_hex)
    if stops is None:
        adjusted = []
        for pos, rgb in _GRADIENT_STOPS:
            colour = rgb_to_hex(rgb)
            t = 0.0
            while t < 0.6 and contrast_ratio(colour, bg_hex) < 3.0:
                t = round(t + 0.05, 4)
                colour = mix(rgb_to_hex(rgb), "#000000", t)
            adjusted.append((pos, hex_to_rgb(colour)))
        stops = tuple(adjusted)
        _stops_cache[bg_hex] = stops
    return stops


def _conic_gradient(u: float) -> tuple[int, int, int]:
    u %= 1.0
    stops = _stops_for(palette().bg_hex)
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        if u <= p1:
            t = (u - p0) / (p1 - p0) if p1 > p0 else 0.0
            return tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3))
    return stops[-1][1]


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


def _fit_label(label: str, width: int) -> str:
    """The label as plain text, cut to fit between ``╭──`` and at least ``──╮``."""
    plain = _ANSI_RE.sub("", label or "")
    return _truncate_visible(plain, max(0, width - 6)) if plain else ""


def _alert_bottom(width: int, alert: str) -> str:
    """Static bottom edge with the alert at column 3 in yellow; the width stays ``width``."""
    pal = palette()
    rest = "─" * max(0, width - 4 - string_width(alert))
    return f"{pal.faint}╰──{pal.yellow}{alert}{pal.faint}{rest}╯{pal.reset}"


def _mode_bottom(width: int, mode: str, mode_sgr: str, border: str, *,
                 elapsed: float | None = None) -> str:
    """Bottom edge with the mode word at the right corner (``╰───── read-only ─╯``).

    The word keeps its own semantic colour; the rest of the edge is the frame's border
    colour when quiet, or the rainbow's bottom arc while busy."""
    label = f" {mode} "
    label_at = width - 2 - string_width(label)
    glyphs = ["╰", *["─"] * (width - 2), "╯"]
    perimeter = 2 * (width + 1)
    parts: list[str] = []
    col = 0
    while col < width:
        if col == label_at and label_at > 1:
            parts.append(f"{_RESET}{mode_sgr}{label}")
            col += string_width(label)
            continue
        if elapsed is None:
            parts.append(f"{border}{glyphs[col]}")
        else:
            # Clockwise along the bottom runs from the right corner back to the left.
            parts.append(_sgr(_color_at(2 * width - col, perimeter, elapsed)) + glyphs[col])
        col += 1
    parts.append(_RESET)
    return "".join(parts)


def _quiet_frame(width: int, label: str, alert: str, *, mode: str = "", mode_sgr: str = "",
                 border: str = "") -> tuple[str, str, str, str]:
    pal = palette()
    edge = border or pal.faint
    if label:
        rest = "─" * max(0, width - 4 - string_width(label))
        top = f"{edge}╭──{label}{rest}╮{pal.reset}"
    else:
        top = f"{edge}╭{'─' * (width - 2)}╮{pal.reset}"
    if alert:
        bottom = _alert_bottom(width, alert)
    elif mode:
        bottom = _mode_bottom(width, mode, mode_sgr or pal.faint, edge)
    else:
        bottom = f"{edge}╰{'─' * (width - 2)}╯{pal.reset}"
    side = f"{edge}│{pal.reset}"
    return top, side, side, bottom


def build_loop_frame(
    width: int,
    *,
    elapsed: float | None,
    label: str = "",
    bottom_label: str = "",
    mode: str = "",
    mode_sgr: str = "",
    border: str = "",
) -> tuple[str, str, str, str]:
    """Return ``(top, left, right, bottom)`` for one closed frame.

    ``elapsed is None`` draws a quiet frame (in ``border``'s colour when given, faint
    otherwise). A number runs the rainbow around the loop and through the label.
    ``bottom_label`` (the observability alert) is drawn on the bottom edge whether busy
    or not. ``mode`` is the one-word mode (``read-only`` / ``auto``) at the bottom-right
    corner, in ``mode_sgr``; it never takes the rainbow.
    """
    width = max(4, int(width))
    alert = _fit_label(bottom_label, width)
    mode = _fit_label(mode, width) if mode else ""
    if elapsed is None or not shimmer.enabled():
        return _quiet_frame(width, "" if elapsed is None else _fit_label(label, width), alert,
                            mode=mode, mode_sgr=mode_sgr, border=border)

    perimeter = 2 * (width + 1)  # height is 3: two rims + one content row
    # Drop any shimmer the caller already painted. This sweep owns the color.
    shown = _fit_label(label, width)
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
    if alert:
        bottom = _alert_bottom(width, alert)
    elif mode:
        bottom = _mode_bottom(width, mode, mode_sgr or palette().faint, palette().faint,
                              elapsed=elapsed)
    else:
        bottom_glyphs = ["╰", *["─"] * (width - 2), "╯"]
        # Clockwise along the bottom runs from the right corner back to the left.
        bottom_indices = [2 * width - col for col in range(width)]
        bottom = _paint(bottom_glyphs, bottom_indices, perimeter, elapsed)
    left = _sgr(_color_at(2 * width + 1, perimeter, elapsed)) + "│" + _RESET
    return "".join(top_parts), left, right, bottom
