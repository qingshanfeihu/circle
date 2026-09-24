"""One subagent's detail page, in the InfoTest layout
(``ist_app._render_agent_detail_band`` / ``_render_agent_detail_lines``).

A three-line band (name, position among siblings, status, calls, tokens, elapsed,
keys) and the subagent's whole record top to bottom: one line per tool call —
``{light} {Short}({summary}) {result summary}`` — and each round's reasoning at the
point it happened (``∴ Thinking`` → ``∴ Thought · duration``, ctrl+t shows the text;
only its tail is kept, and the page says so only when it is expanded).
"""

from __future__ import annotations

import time
from typing import Any, Mapping

from circle.display_lexicon import strip_leading_status_glyph, tool_result_recoverable
from circle.ink.string_width import string_width
from circle.ink.theme import GLYPH_MILESTONE, palette, sgr_join
from circle.tui.agent_strip import (
    card_calls,
    card_elapsed,
    card_name,
    card_running,
    card_tokens,
    format_elapsed,
    format_tokens,
)
from circle.tui.transcript_view import subagent_call_row

KEYS = "esc 返回 · ←→ 切换"
NO_STEPS = "暂时还没有工具调用"


def _status_cn(card: Mapping[str, Any]) -> str:
    if card_running(card):
        return "运行中"
    if card.get("termination_cause") == "CANCELLED":
        return "已中止"
    return "完成" if card.get("status") == "ok" else "失败"


def _status_color(card: Mapping[str, Any], pal: Any) -> str:
    if card_running(card):
        return pal.yellow
    return pal.green if card.get("status") == "ok" else pal.red


def _clip(text: str, width: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= width else text[: width - 1] + "…"


def format_chars(n: int) -> str:
    n = max(0, int(n or 0))
    if n >= 10000:
        return f"{n / 10000:.1f} 万字"
    if n >= 1000:
        return f"{n / 1000:.1f} 千字"
    return f"{n} 字"


def render_detail_band(card: Mapping[str, Any], *, index: int, total: int,
                       width: int, now: float | None = None) -> list[str]:
    """Identity on the left, keys on the right; identity segments drop from the end
    on a narrow screen, the keys stay."""
    now = time.time() if now is None else now
    pal = palette()
    inner = max(40, int(width or 0) or 80) - 2
    segments = [
        (f" {card_name(card)}", pal.em),
        (f" ({index} of {total})", pal.dim),
        (f" · {_status_cn(card)}", _status_color(card, pal)),
        (f" · {card_calls(card)} calls", pal.dim),
        (f" · ↑{format_tokens(card_tokens(card))}", pal.dim),
        (f" · {format_elapsed(card_elapsed(card, now))}", pal.dim),
    ]
    keys = f"{KEYS} "
    keep = len(segments)
    while keep > 1 and sum(string_width(t) for t, _c in segments[:keep]) + 1 + string_width(keys) > inner:
        keep -= 1
    room = inner - 1 - string_width(keys)
    if keep == 1 and string_width(segments[0][0]) > room:
        name = segments[0][0]
        while name and string_width(name) > room - 1:
            name = name[:-1]
        segments[0] = (name + "…", segments[0][1])
    left_plain = "".join(t for t, _c in segments[:keep])
    show_keys = string_width(left_plain) + 1 + string_width(keys) <= inner
    gap = max(1, inner - string_width(left_plain) - (string_width(keys) if show_keys else 0))
    left = "".join(f"{sgr_join(pal.panel_bg, color)}{text}" for text, color in segments[:keep])
    body = f"{left}{sgr_join(pal.panel_bg, pal.dim)}{' ' * gap}{keys if show_keys else ''}"
    rule = "─" * inner
    return [f"{pal.line}╭{rule}╮{pal.reset}",
            f"{pal.line}│{body}{pal.line}│{pal.reset}",
            f"{pal.line}╰{rule}╯{pal.reset}"]


def _call_line(item: Mapping[str, Any], pal: Any, now: float) -> str:
    row = subagent_call_row(item, now=now)
    status = str(item.get("status") or "running")
    if status == "running":
        return row
    output = strip_leading_status_glyph(
        next((ln.strip() for ln in str(item.get("output") or "").splitlines() if ln.strip()), ""))
    summary = _clip(output, 120)
    if status == "error" and tool_result_recoverable(item):
        return f"{row}{pal.muted_strike} {summary}{pal.reset}" if summary else row
    return f"{row} {pal.dim}{summary or '工具已返回'}{pal.reset}"


def _thinking_lines(item: Mapping[str, Any], pal: Any, *, expanded: bool) -> list[str]:
    title = " ".join(str(item.get("title") or "").split())
    body = str(item.get("text") or "").strip()
    done = bool(item.get("done"))
    header = "∴ Thought" if done else "∴ Thinking"
    if title:
        header += f": {_clip(title, 120)}"
    if done and item.get("duration_s") is not None:
        header += f" · {format_elapsed(float(item.get('duration_s') or 0.0))}"
    chars = max(0, int(item.get("chars") or 0))
    truncated = bool(item.get("truncated")) and bool(body)
    if chars:
        header += f" · {format_chars(chars)}"
        if expanded and truncated:
            header += f" · 下面是末 {len(body)} 字"
    head = sgr_join(pal.reason_dim if expanded else pal.reason, "\x1b[3m")
    lines = [f"{head}⎿ {header}{pal.reset}"]
    if not body:
        return lines
    if not expanded:
        lines[0] += f" {pal.faint}(ctrl+t 展开){pal.reset}"
        return lines
    body_lines = body.splitlines()
    if truncated and body_lines:
        body_lines[0] = f"…{body_lines[0]}"
    lines += [f"  {pal.faint}{raw}{pal.reset}" for raw in body_lines]
    return lines


def render_detail_lines(card: Mapping[str, Any], *, now: float | None = None,
                        expanded: bool = False) -> list[str]:
    now = time.time() if now is None else now
    pal = palette()
    lines: list[str] = []
    description = " ".join(str(card.get("description") or "").split())
    if description:
        lines.append(f"{pal.faint}任务: {_clip(description, 400)}{pal.reset}")
    lines.append("")
    steps = thinking = 0
    for item in card.get("transcript") or ():
        if not isinstance(item, Mapping):
            continue
        if item.get("kind") == "tool":
            lines.append(_call_line(item, pal, now))
            steps += 1
        elif item.get("kind") == "thinking_body" and (item.get("text") or item.get("title")):
            lines += _thinking_lines(item, pal, expanded=expanded)
            steps += 1
            thinking += 1
    if not steps:
        lines.append(f"{pal.dim}{NO_STEPS}{pal.reset}")
    idle = format_elapsed(max(0.0, now - float(card.get("last_event_ts") or card.get("start_ts") or now)))
    lines.append("")
    facts = f"工具 {card_calls(card)} 次" + (f" · 思考 {thinking} 段" if thinking else "")
    if card_running(card):
        facts += f" · 距上次事件 {idle}"
    lines.append(f"{pal.faint}{facts}{pal.reset}")
    if not card_running(card):
        lines.append(f"{pal.dim}{GLYPH_MILESTONE} 结果：{_status_cn(card)} · {card_calls(card)} calls · "
                     f"↑{format_tokens(card_tokens(card))} · "
                     f"{format_elapsed(card_elapsed(card, now))}{pal.reset}")
        summary = str(card.get("summary") or "").strip()
        if summary:
            lines.append(f"   ⎿ {pal.faint}{_clip(summary, 200)}{pal.reset}")
    return lines


__all__ = ["KEYS", "NO_STEPS", "format_chars", "render_detail_band", "render_detail_lines"]
