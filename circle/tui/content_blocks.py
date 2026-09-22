"""Content-block helpers — slim port of InfoTest IstInkApp stream/thinking paths.

InfoTest feeds MessageSnapshot (streaming_text + reasoning_* + BLOCK_THINKING).
Circle extracts the same fields from LangChain message ``content`` so the
session shell can drive transcript + footer the same way.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from circle.ink.theme import GLYPH_AGENT, palette


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


def render_thinking_line(*, body: str, done: bool, expanded: bool = False) -> str:
    """InfoTest ``_render_main_thinking_line`` (collapsed by default)."""
    pal = palette()
    if done:
        header = "∴ Thought"
    else:
        header = "∴ Thinking"
    header_sgr = f"{pal.reason}\x1b[3m" if hasattr(pal, "reason") else "\x1b[2m\x1b[3m"
    reset = getattr(pal, "reset", "\x1b[0m")
    faint = getattr(pal, "faint", "\x1b[2m")
    line = f" {header_sgr}{header}{reset}"
    if expanded and body:
        indented = "\n".join(
            f"   {ln}" if ln else "" for ln in body.splitlines()
        )
        line += f"\n   {faint}{indented}{reset}"
    elif not expanded:
        line += f" {faint}(ctrl+t to expand){reset}"
    return line
