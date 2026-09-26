"""Bottom strip for in-flight subagents, in the InfoTest layout
(``ist_app._render_agent_strip_lines``).

The strip only answers "who is running now": one row per running subagent card —
badge, name, what it is doing, elapsed, tokens. The doing column shows the
subagent's reasoning title (``思考·…``) and otherwise the task description the main
agent gave it; never raw reasoning prose, and never the current tool call, which the
folded block under the task row already shows.

At most ``MAX_ROWS`` rows. The window follows the selection; the header always counts
every running subagent and a tail line says how many are folded away.
"""

from __future__ import annotations

import re
import time
from typing import Any, Mapping

from circle.ink.string_width import string_width
from circle.ink.theme import palette, sgr_join

MAX_ROWS = 6
BADGE = "agent"
HINT = "↓↑ 选择 · ⏎ 详情 · esc 返回"
_SELECTED_NOTE = " ← 选中"
_PFX_W = 7
_NAME_W = 24
_ELAPSED_W = 8
_TOKENS_W = 10

Card = tuple[str, Mapping[str, Any]]


# ── card facts (shared by the strip, the folded block and the detail page) ──


def format_elapsed(seconds: float) -> str:
    seconds = max(0.0, float(seconds or 0.0))
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes, sec = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{minutes}m {sec}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m"


def format_tokens(n: int) -> str:
    n = max(0, int(n or 0))
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def _num(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def card_running(card: Mapping[str, Any]) -> bool:
    return str(card.get("status") or "running") == "running"


def card_name(card: Mapping[str, Any]) -> str:
    """``subagent_type·<call id tail>``: parallel subagents of one type stay apart."""
    name = str(card.get("name") or "agent")
    ident = re.sub(r"[^0-9A-Za-z]", "", str(card.get("tool_use_id") or ""))[-8:]
    return f"{name}·{ident}" if ident else name


def card_elapsed(card: Mapping[str, Any], now: float) -> float:
    start = _num(card.get("start_ts"), now)
    if card_running(card):
        return max(0.0, now - start)
    end = _num(card.get("end_ts") or card.get("last_event_ts"), start)
    return max(0.0, end - start)


def card_tokens(card: Mapping[str, Any]) -> int:
    return int(_num(card.get("tokens_in"))) + int(_num(card.get("tokens_out")))


def card_calls(card: Mapping[str, Any]) -> int:
    return max(0, int(_num(card.get("n_calls"))))


def card_activity(card: Mapping[str, Any]) -> str:
    title = " ".join(str(card.get("reasoning_title") or "").split())
    if title:
        return f"思考·{title}"
    description = " ".join(str(card.get("description") or "").split())
    return description or "—"


def snapshot_cards(snap: Any) -> list[Card]:
    """Every subagent card of the snapshot, in the order the calls were made."""
    indices = getattr(snap, "agent_card_indices", None) or {}
    messages = getattr(snap, "messages", None) or ()
    out: list[tuple[int, str, Mapping[str, Any]]] = []
    for uuid, idx in indices.items():
        if not (0 <= idx < len(messages)) or not messages[idx].content:
            continue
        payload = messages[idx].content[0].payload or {}
        if payload.get("kind") == "subagent":
            out.append((idx, str(uuid), payload))
    return [(uuid, payload) for _idx, uuid, payload in sorted(out, key=lambda t: t[0])]


def running_cards(snap: Any) -> list[Card]:
    return [(uuid, card) for uuid, card in snapshot_cards(snap) if card_running(card)]


# ── layout ──────────────────────────────────────────────────────────────


def _fit(text: str, width: int) -> str:
    """Cut to ``width`` columns, marking a cut with ``…``."""
    text = str(text or "")
    if width <= 0:
        return ""
    if string_width(text) <= width:
        return text
    while text and string_width(text) > width - 1:
        text = text[:-1]
    return text + "…"


def _pad(text: str, width: int) -> str:
    shown = _fit(text, width)
    return shown + " " * max(0, width - string_width(shown))


def _rjust(text: str, width: int) -> str:
    shown = _fit(text, width)
    return " " * max(0, width - string_width(shown)) + shown


def strip_window(ids: list[str], selected: str | None, start: int,
                 max_rows: int = MAX_ROWS) -> int:
    """First visible row: stays put unless the selection walks off an edge."""
    if len(ids) <= max_rows:
        return 0
    start = max(0, min(int(start or 0), len(ids) - max_rows))
    if selected in ids:
        at = ids.index(selected)
        if at < start:
            start = at
        elif at >= start + max_rows:
            start = at - max_rows + 1
    return start


def render_agent_strip(
    rows: list[Card],
    *,
    width: int,
    now: float | None = None,
    selected: str | None = None,
    hover: str | None = None,
    total: int | None = None,
    hidden: int = 0,
) -> list[str]:
    """``rows`` is the visible window; ``total`` counts every running subagent.

    The selected row and the row under the mouse sit on ``sel_bg`` (the selected one
    also says ``← 选中``); other rows carry the agent tint."""
    if not rows:
        return []
    now = time.time() if now is None else now
    pal = palette()
    w = max(40, int(width or 0) or 80)
    names = [card_name(card) for _u, card in rows]
    actions = [card_activity(card) for _u, card in rows]
    elapses = [format_elapsed(card_elapsed(card, now)) for _u, card in rows]
    tokens = [format_tokens(card_tokens(card)) for _u, card in rows]
    name_w = min(_NAME_W, max(12, max(string_width(s) for s in names)))
    elapsed_w = min(_ELAPSED_W, max(6, max(string_width(s) for s in elapses)))
    token_w = min(_TOKENS_W, max(6, max(string_width(s) for s in tokens)))
    fixed = (2 + _PFX_W) + (2 + name_w + 1) + (elapsed_w + 1 + token_w) + 1
    if selected in {uuid for uuid, _card in rows}:
        fixed += string_width(_SELECTED_NOTE)  # 注记不挤掉令牌列
    action_w = max(0, min(max(string_width(s) for s in actions), w - fixed))

    out = [f"{pal.line}{'─' * w}{pal.reset}"]
    header = _pad(f"  在途 AGENT ─ {len(rows) if total is None else int(total)}", w)
    out.append(f"{sgr_join(pal.panel_bg, pal.faint)}{header}{pal.reset}")
    for (uuid, _card), name, action, elapsed, token in zip(rows, names, actions, elapses, tokens):
        is_selected = uuid == selected
        hovered = not is_selected and uuid == hover
        badge = f"  {_pad(BADGE, _PFX_W)}"
        left = f"  {_pad(name, name_w)} {_pad(action, action_w)}"
        right = f"{_rjust(elapsed, elapsed_w)} {_rjust(token, token_w)}"
        if is_selected:
            right += _SELECTED_NOTE
        gap = max(1, w - string_width(badge) - string_width(left) - string_width(right))
        rest = f"{left}{' ' * gap}{right}"
        if is_selected or hovered:
            out.append(f"{sgr_join(pal.sel_bg, pal.text)}{_pad(badge + rest, w)}{pal.reset}")
            continue
        out.append(f"{sgr_join(pal.agent_bg, pal.dim)}{badge}"
                   f"{sgr_join(pal.agent_bg, pal.text)}"
                   f"{_pad(rest, w - string_width(badge))}{pal.reset}")
    if hidden > 0:
        fold = _pad(f"  … 另有 {int(hidden)} 个在途（↑↓ 翻看）", w)
        out.append(f"{sgr_join(pal.panel_bg, pal.faint)}{fold}{pal.reset}")
    out.append(f"{sgr_join(pal.panel_bg, pal.faint)}{_pad('  ' + HINT, w)}{pal.reset}")
    return out


__all__ = [
    "BADGE",
    "HINT",
    "MAX_ROWS",
    "card_activity",
    "card_calls",
    "card_elapsed",
    "card_name",
    "card_running",
    "card_tokens",
    "format_elapsed",
    "format_tokens",
    "render_agent_strip",
    "running_cards",
    "snapshot_cards",
    "strip_window",
]
