"""One subagent's detail page, in the InfoTest layout
(``ist_app._render_agent_detail_band`` / ``_render_agent_detail_lines``).

A one-row band on the panel background (the agent's lamp, name, position among siblings,
status, calls, tokens, elapsed, and the text buttons ``main · prev · next``) and the
subagent's whole record top to bottom: one line per tool call — ``{light}
{Short}({summary}) {result summary}`` — and each round's reasoning at the point it
happened (``∴ Thinking`` → ``∴ Thought 2.1s · title``, ctrl+t shows the text; only its
tail is kept, and the page says so only when it is expanded). Call rows carry their tool's type tint and reasoning rows the
thinking tint, the same mapping as the main transcript.
"""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any

from circle.display_lexicon import strip_leading_status_glyph, tool_result_recoverable
from circle.ink.string_width import string_width
from circle.ink.theme import palette, sgr_join, status_light
from circle.tui.agent_strip import (
    card_calls,
    card_elapsed,
    card_name,
    card_running,
    card_tokens,
    format_elapsed,
    format_tokens,
)
from circle.tui.content_blocks import render_thinking_markdown
from circle.tui.transcript_view import subagent_call_row, tool_type_bg_hex

# 顶栏纯文字按钮（InfoTest 07 §11.25(6)，图标退役）：(动作, 文字)；键盘 esc/⌫、←→ 不变
BUTTONS = (("back", "main"), ("prev", "prev"), ("next", "next"))
NO_STEPS = "No tool calls yet"


def _status_word(card: Mapping[str, Any]) -> str:
    if card_running(card) and (card.get("awaiting_approval") or card.get("awaiting_question")):
        return "waiting for you"
    if card_running(card):
        return "running"
    if card.get("termination_cause") == "CANCELLED":
        return "interrupted"
    return "done" if card.get("status") == "ok" else "failed"


def _status_color(card: Mapping[str, Any], pal: Any) -> str:
    if card_running(card) and (card.get("awaiting_approval") or card.get("awaiting_question")):
        return pal.blue
    if card_running(card):
        return pal.yellow
    return pal.green if card.get("status") == "ok" else pal.red


def _clip(text: str, width: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= width else text[: width - 1] + "…"


def format_chars(n: int) -> str:
    n = max(0, int(n or 0))
    if n >= 1000:
        return f"{n / 1000:.1f}k chars"
    return f"{n} chars"


def render_detail_band(card: Mapping[str, Any], *, index: int, total: int, width: int,
                       now: float | None = None,
                       hover: str | None = None) -> tuple[list[str], list[tuple[int, int, str]]]:
    """Identity on the left, the text buttons on the right; identity segments drop from
    the end on a narrow screen, the buttons stay (they are the page's mouse exit).

    Returns the three lines and each button's ``(start_col, end_col, action)`` on the
    middle line. A button sits on ``panel_bg``; the hovered one on ``sel_bg``, brighter."""
    now = time.time() if now is None else now
    pal = palette()
    inner = max(20, int(width or 0) or 80)
    lamp = "running" if card_running(card) else ("ok" if card.get("status") == "ok" else "error")
    if card_running(card) and (card.get("awaiting_approval") or card.get("awaiting_question")):
        lamp = "wait"
    lamp_raw = status_light(lamp, reset=False)
    segments = [
        (card_name(card), pal.em),
        (f" ({index} of {total})", pal.dim),
        (f" · {_status_word(card)}", _status_color(card, pal)),
        (f" · {card_calls(card)} calls", pal.dim),
        (f" · ↑{format_tokens(card_tokens(card))}", pal.dim),
        (f" · {format_elapsed(card_elapsed(card, now))}", pal.dim),
    ]
    buttons_w = string_width("  ".join(f" {text} " for _act, text in BUTTONS) + " ")
    lead = 3  # " ● " — the lamp sits in marker column 1
    keep = len(segments)
    while keep > 1 and lead + sum(string_width(t) for t, _c in segments[:keep]) + 1 + buttons_w > inner:
        keep -= 1
    room = inner - lead - 1 - buttons_w
    if keep == 1 and string_width(segments[0][0]) > room:
        name = segments[0][0]
        while name and string_width(name) > room - 1:
            name = name[:-1]
        segments[0] = (name + "…", segments[0][1])
    left_plain = "".join(t for t, _c in segments[:keep])
    show_buttons = lead + string_width(left_plain) + 1 + buttons_w <= inner
    gap = max(1, inner - lead - string_width(left_plain) - (buttons_w if show_buttons else 0))
    on_panel = sgr_join(pal.panel_bg, pal.dim)
    if lamp_raw == " ":
        lamp_cell = " "
    else:
        lamp_code, lamp_glyph = lamp_raw.rsplit("m", 1)
        lamp_cell = f"{sgr_join(pal.panel_bg, lamp_code + 'm')}{lamp_glyph}"
    body = f"{on_panel} {lamp_cell}{on_panel} "
    body += "".join(f"{sgr_join(pal.panel_bg, color)}{text}" for text, color in segments[:keep])
    body += f"{on_panel}{' ' * gap}"
    spans: list[tuple[int, int, str]] = []
    if show_buttons:
        cursor = lead + string_width(left_plain) + gap
        styled: list[str] = []
        for action, text in BUTTONS:
            label = f" {text} "
            spans.append((cursor, cursor + string_width(label), action))
            cursor += string_width(label) + 2
            hovered = action == hover
            styled.append(f"{sgr_join(pal.sel_bg if hovered else pal.panel_bg, pal.em if hovered else pal.text)}"
                          f"{label}")
        body += f"{on_panel}  ".join(styled) + f"{on_panel} "
    return [f"{body}{pal.reset}"], spans


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
    return f"{row} {pal.dim}{summary or 'returned'}{pal.reset}"


def _thinking_lines(item: Mapping[str, Any], pal: Any, *, expanded: bool,
                    width: int) -> list[str]:
    title = " ".join(str(item.get("title") or "").split())
    body = str(item.get("text") or "").strip("\n")
    done = bool(item.get("done"))
    header = "∴ Thought" if done else "∴ Thinking"
    if done and item.get("duration_s") is not None:
        header += f" {format_elapsed(float(item.get('duration_s') or 0.0))}"
    if title:
        header += f" · {_clip(title, 120)}"
    chars = max(0, int(item.get("chars") or 0))
    truncated = bool(item.get("truncated")) and bool(body)
    if chars:
        header += f" · {format_chars(chars)}"
        if expanded and truncated:
            header += f" · last {len(body)} shown"
    head = sgr_join(pal.reason_dim if expanded else pal.reason, "\x1b[3m")
    lines = [f"{head}⎿ {header}{pal.reset}"]
    if not body:
        return lines
    if not expanded:
        lines[0] += f"  {pal.faint}ctrl+t{pal.reset}"
        return lines
    fence = item.get("tail_fence")
    if truncated and "tail_fence" not in item:
        # Old snapshots lack the discarded-prefix state; preserve their text literally.
        body_lines = body.splitlines()
    elif truncated and isinstance(fence, Mapping):
        opener = (" " * int(fence["indent"]) + str(fence["marker"]) * int(fence["count"])
                  + str(fence["lang"]))
        body_lines = render_thinking_markdown(f"{opener}\n{body}", width - 3).splitlines()
    elif truncated and item.get("tail_partial_line"):
        # A single line longer than the tail cap may begin with a fragment.
        first, _, rest = body.partition("\n")
        body_lines = [first]
        if rest:
            body_lines.extend(render_thinking_markdown(rest, width - 3).splitlines())
    else:
        body_lines = render_thinking_markdown(body, width - 3).splitlines()
    if truncated and body_lines:
        body_lines[0] = f"…{body_lines[0]}"
    lines += [f"  {pal.faint}{raw}{pal.reset}" for raw in body_lines]
    return lines


def render_detail_rows(card: Mapping[str, Any], *, now: float | None = None,
                       expanded: bool = False, width: int = 80) -> list[tuple[str, str | None]]:
    """The page's lines with each one's background tint (hex, or None)."""
    now = time.time() if now is None else now
    pal = palette()
    think_bg = pal.think_bg_hex or None
    rows: list[tuple[str, str | None]] = []
    description = " ".join(str(card.get("description") or "").split())
    if description:
        rows.append((f"{pal.faint}Task · {_clip(description, 400)}{pal.reset}", None))
    rows.append(("", None))
    steps = thinking = 0
    for item in card.get("transcript") or ():
        if not isinstance(item, Mapping):
            continue
        if item.get("kind") == "tool":
            rows.append((_call_line(item, pal, now), tool_type_bg_hex(str(item.get("tool") or ""))))
            steps += 1
        elif item.get("kind") == "thinking_body" and (item.get("text") or item.get("title")):
            rows += [(line, think_bg) for line in _thinking_lines(item, pal, expanded=expanded,
                                                                 width=width)]
            steps += 1
            thinking += 1
    if not steps:
        rows.append((f"{pal.dim}{NO_STEPS}{pal.reset}", None))
    idle = format_elapsed(max(0.0, now - float(card.get("last_event_ts") or card.get("start_ts") or now)))
    rows.append(("", None))
    facts = f"{card_calls(card)} tool calls" + (f" · {thinking} thinking" if thinking else "")
    if card_running(card):
        facts += f" · {idle} since the last event"
    rows.append((f"{pal.faint}{facts}{pal.reset}", None))
    if not card_running(card):
        result = (f"{pal.dim}Result · {_status_word(card)} · {card_calls(card)} calls · "
                  f"↑{format_tokens(card_tokens(card))} · "
                  f"{format_elapsed(card_elapsed(card, now))}{pal.reset}")
        rows.append((result, None))
        summary = str(card.get("summary") or "").strip()
        if summary:
            rows.append((f"   ⎿ {pal.faint}{_clip(summary, 200)}{pal.reset}", None))
    return rows


def render_detail_lines(card: Mapping[str, Any], *, now: float | None = None,
                        expanded: bool = False, width: int = 80) -> list[str]:
    return [line for line, _bg in render_detail_rows(card, now=now, expanded=expanded,
                                                     width=width)]


__all__ = ["BUTTONS", "NO_STEPS", "format_chars", "render_detail_band", "render_detail_lines",
           "render_detail_rows"]
