"""Bottom strip for in-flight subagents, in the InfoTest layout.

InfoTest draws this under the footer: a rule, "在途 AGENT", one row per
running fork (name, what it is doing, elapsed). Circle's task tool is the
same slot.
"""

from __future__ import annotations

import time

from circle.ink.string_width import string_width
from circle.ink.theme import palette


def _elapsed(seconds: float) -> str:
    seconds = max(0.0, seconds)
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes, sec = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{minutes}m {sec}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m"


def _fit(text: str, width: int) -> str:
    text = str(text or "")
    if width <= 0:
        return ""
    while text and string_width(text) > width:
        text = text[:-1]
    if string_width(text) > width:
        return ""
    return text


def _pad(text: str, width: int) -> str:
    shown = _fit(text, width)
    return shown + " " * max(0, width - string_width(shown))


def _rjust(text: str, width: int) -> str:
    shown = _fit(text, width)
    return " " * max(0, width - string_width(shown)) + shown


def render_agent_strip(
    rows: list[dict],
    *,
    width: int,
    now: float | None = None,
) -> list[str]:
    """Return the lines of the bottom strip. Empty when nothing is running."""
    if not rows:
        return []
    now = time.time() if now is None else now
    pal = palette()
    w = max(40, int(width or 0) or 80)
    name_w = 12
    elapsed_w = 8
    action_w = max(8, w - (2 + name_w + 1 + 1 + elapsed_w))
    out = [f"{pal.line}{'─' * w}{pal.reset}"]
    header = _pad(f"  在途 AGENT ─ {len(rows)}", w)
    out.append(f"{pal.panel_bg}{pal.faint}{header}{pal.reset}")
    for row in rows:
        elapsed = _elapsed(now - float(row.get("started") or now))
        body = (
            f"  {_pad(str(row.get('name') or 'agent'), name_w)} "
            f"{_pad(str(row.get('action') or '运行中'), action_w)} "
            f"{_rjust(elapsed, elapsed_w)}"
        )
        out.append(f"{pal.panel_bg}{pal.text}{_pad(body, w)}{pal.reset}")
    hint = _pad("  子代理运行中", w)
    out.append(f"{pal.panel_bg}{pal.faint}{hint}{pal.reset}")
    return out
