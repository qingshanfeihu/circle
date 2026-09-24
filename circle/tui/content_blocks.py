"""Content-block helpers — slim port of InfoTest IstInkApp stream/thinking paths.

InfoTest feeds MessageSnapshot (streaming_text + reasoning_* + BLOCK_THINKING).
Circle extracts the same fields from LangChain message ``content`` so the
session shell can drive transcript + footer the same way.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from circle.ink.theme import GLYPH_AGENT, palette, sgr_join


@dataclass
class ParsedContent:
    text: str = ""
    thinking: str = ""
    thinking_done: bool = True


def parse_content(content: Any) -> ParsedContent:
    """Split model content into visible text vs thinking/reasoning body."""
    if content is None:
        return ParsedContent()
    if isinstance(content, str):
        return ParsedContent(text=content.strip())

    texts: list[str] = []
    thinks: list[str] = []
    thinking_done = True

    blocks: list[Any]
    if isinstance(content, list):
        blocks = content
    elif isinstance(content, dict):
        blocks = [content]
    else:
        return ParsedContent(text=str(content).strip())

    for block in blocks:
        if isinstance(block, str):
            if block.strip():
                texts.append(block.strip())
            continue
        if not isinstance(block, dict):
            continue
        btype = str(block.get("type") or "")
        if btype in {"thinking", "reasoning", "redacted_thinking"}:
            body = str(
                block.get("thinking")
                or block.get("reasoning")
                or block.get("text")
                or ""
            ).strip()
            if body:
                thinks.append(body)
            # Anthropic streaming thinking often has no "done" flag until final
            if block.get("thinking_done") is False or btype == "thinking" and not block.get("signature"):
                # mid-stream thinking chunk
                if "signature" not in block:
                    thinking_done = False
            continue
        if btype in {"tool_use", "tool_result", "input_json"}:
            continue
        if btype == "text" or "text" in block:
            piece = block.get("text")
            if piece:
                texts.append(str(piece).strip())

    return ParsedContent(
        text="\n".join(t for t in texts if t),
        thinking="\n".join(t for t in thinks if t),
        thinking_done=thinking_done,
    )


def message_text(content: Any) -> str:
    return parse_content(content).text


def thinking_preview(content: Any, *, max_chars: int = 200) -> str:
    """Last line of thinking for footer reasoning_last_line (InfoTest style)."""
    body = parse_content(content).thinking
    if not body:
        return ""
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    if not lines:
        return ""
    last = lines[-1]
    return last[:max_chars]


def reasoning_chars(content: Any) -> int:
    return len(parse_content(content).thinking)


def assistant_block(rendered: str) -> str:
    """InfoTest ``_assistant_block``: glyph on first line, indent continuations."""
    lines = str(rendered).split("\n")
    head, rest = lines[0], lines[1:]
    return "\n".join(
        [f" {GLYPH_AGENT} {head}"]
        + [f"   {line}" if line else "" for line in rest]
    )


def indent_continuations(text: str, prefix: str = "   ") -> str:
    """InfoTest ``indent_continuations`` — first line bare, rest prefixed."""
    lines = str(text).split("\n")
    if not lines:
        return ""
    return "\n".join(
        [lines[0]] + [f"{prefix}{ln}" if ln else "" for ln in lines[1:]]
    )


def render_thinking_line(*, body: str, done: bool, expanded: bool = False,
                         title: str | None = None, duration_s: float | None = None) -> str:
    """InfoTest ``_render_main_thinking_line``: ``∴ Thinking[: title]`` while running,
    ``∴ Thought[: title][ · duration]`` when settled; ctrl+t shows the body."""
    from circle.ink.components.footer import _format_elapsed

    pal = palette()
    title = str(title or "").strip()
    if done:
        header = "∴ Thought" + (f": {title}" if title else "")
        if duration_s is not None:
            try:
                header += f" · {_format_elapsed(max(0.0, float(duration_s)))}"
            except (TypeError, ValueError, OverflowError):
                pass
    else:
        header = "∴ Thinking" + (f": {title}" if title else "")
    header_sgr = sgr_join(pal.reason_dim if expanded else pal.reason, "\x1b[3m")
    line = f" {header_sgr}{header}{pal.reset}"
    body = str(body or "").strip()
    if expanded and body:
        line += f"\n   {pal.faint}{indent_continuations(body, '   ')}{pal.reset}"
    elif not expanded:
        line += f" {pal.faint}(ctrl+t to expand){pal.reset}"
    return line
