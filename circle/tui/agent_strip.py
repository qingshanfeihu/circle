"""Bottom strip for in-flight subagents, in the InfoTest layout
(``ist_app._render_agent_strip_lines``).

The strip only answers "who is running now": one row per running subagent card — its
lamp, name, what it is doing, and an ``elapsed · tokens`` meter right-aligned to the
edge. The doing column shows the subagent's reasoning title and otherwise the task
description the main agent gave it (``waiting for you`` when it is stopped on a question
or an approval); never raw reasoning prose, and never the current tool call, which the
folded block under the task row already shows.

At most ``MAX_ROWS`` rows. The window follows the selection; the header (``Agents · N``)
always counts every running subagent and a tail line (``… +N more``) says how many are
folded away. On a narrow screen the doing column gives way first, then the meter's unit
word, then the name (cut from the middle so its id tail survives).
"""

from __future__ import annotations

import re
import time
from collections.abc import Mapping
from typing import Any

from circle.ink.string_width import string_width
from circle.ink.theme import palette, sgr_join, status_light

MAX_ROWS = 6
_NAME_W = 24

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
    if card.get("awaiting_approval") or card.get("awaiting_question"):
        return "waiting for you"
    title = " ".join(str(card.get("reasoning_title") or "").split())
    if title:
        return title
    description = " ".join(str(card.get("description") or "").split())
    return description or "—"


def card_light(card: Mapping[str, Any], now: float | None = None) -> tuple[str, str]:
    """The lamp for a subagent row as ``(sgr, glyph)``: waiting on you (cyan) or running
    (yellow, blinking). Split so the caller can put the row's background in the same SGR —
    ink rebuilds each inline colour from the base style, so a foreground-only lamp would
    punch a hole in a tinted row."""
    state = "wait" if (card.get("awaiting_approval") or card.get("awaiting_question")) else "running"
    raw = status_light(state, now=now, reset=False)
    code, glyph = raw.rsplit("m", 1)
    return code + "m", glyph


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


def _fit_mid(text: str, width: int) -> str:
    """Cut from the middle so the id tail that tells parallel agents apart survives."""
    text = str(text or "")
    if width <= 0 or string_width(text) <= width:
        return text
    if width <= 3:
        return _fit(text, width)
    tail = text[-(width // 2):]
    head = text[: max(1, width - len(tail) - 1)]
    return f"{head}…{tail}"


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

    A header row on the panel background, then one row per subagent: its lamp (marker
    column 1), the name column sized to the longest name on screen, what it is doing (the
    column that gives way first), and the elapsed · tokens meter right-aligned to end one
    column short of the edge. The selected row and the row under the mouse sit on
    ``sel_bg``; the others carry the agent tint. No hint line: the keys are not taught here."""
    if not rows:
        return []
    now = time.time() if now is None else now
    pal = palette()
    w = max(20, int(width or 0) or 80)
    names = [card_name(card) for _u, card in rows]
    actions = [card_activity(card) for _u, card in rows]
    metas = [f"{format_elapsed(card_elapsed(card, now))} · {format_tokens(card_tokens(card))} tokens"
             for _u, card in rows]
    name_w = min(_NAME_W, max(string_width(s) for s in names))
    meta_w = max(string_width(s) for s in metas)
    # 一行 = 灯(列1) 名字 在做什么 计量，止于倒数第 2 列。窄屏：先让「在做什么」缩到 8 列，
    # 再缩名字，最后丢计量里的 "tokens" 单位——行宽永远不超过屏宽。
    def _doing(nw: int, mw: int) -> int:
        return w - 3 - nw - 2 - mw - 2 - 1

    if _doing(name_w, meta_w) < 8:
        # what gives way first: the unit word in the meter, then the name (never before the unit)
        metas = [m.replace(" tokens", "") for m in metas]
        meta_w = max(string_width(s) for s in metas)
    if _doing(name_w, meta_w) < 8:
        name_w = max(8, min(name_w, w - 3 - 2 - meta_w - 2 - 1 - 8))
    doing_w = max(0, _doing(name_w, meta_w))

    count = len(rows) if total is None else int(total)
    out = [f"{sgr_join(pal.panel_bg, pal.faint)}{_pad(f' Agents · {count}', w)}{pal.reset}"]
    for (uuid, card), name, action, meta in zip(rows, names, actions, metas):
        on_sel = uuid == selected or uuid == hover
        bg = pal.sel_bg if on_sel else pal.agent_bg
        fg = pal.em if on_sel else pal.text
        lamp_sgr, lamp_glyph = card_light(card, now)
        body = f"{_pad(_fit_mid(name, name_w), name_w)}  {_pad(action, doing_w)}  "
        out.append(f"{sgr_join(bg, '')} {sgr_join(bg, lamp_sgr)}{lamp_glyph}{sgr_join(bg, fg)} {body}"
                   f"{sgr_join(bg, pal.dim)}{_rjust(meta, meta_w)} {pal.reset}")
    if hidden > 0:
        out.append(f"{sgr_join(pal.panel_bg, pal.faint)}{_pad(f'  … +{int(hidden)} more', w)}{pal.reset}")
    return out


__all__ = [
    "MAX_ROWS",
    "card_activity",
    "card_light",
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
