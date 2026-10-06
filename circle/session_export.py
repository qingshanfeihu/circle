"""A conversation written out as a file, and read back in.

- JSONL keeps every message as LangChain stores it, tool calls and results included, so
  ``/import`` can rebuild the conversation exactly.
- HTML is for reading: one self-contained page, your messages, the answers, thinking and
  tool calls folded under ``<details>``. It follows the browser's light or dark setting.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    ToolMessage,
    message_to_dict,
    messages_from_dict,
)

from circle.tui.content_blocks import parse_content
from circle.tui.replay import is_user_message, shown_text

FORMAT = "circle-session"
VERSION = 1


@dataclass
class SessionMeta:
    thread_id: str
    title: str = ""
    workspace: str = ""
    model: str = ""


# ── JSONL ──────────────────────────────────────────────────────────────────


def to_jsonl(messages: list[BaseMessage], meta: SessionMeta) -> str:
    header = {"format": FORMAT, "version": VERSION, "id": meta.thread_id, "title": meta.title,
              "workspace": meta.workspace, "model": meta.model,
              "exported": datetime.now(UTC).isoformat(timespec="seconds")}
    lines = [json.dumps(header, ensure_ascii=False)]
    lines += [json.dumps(message_to_dict(m), ensure_ascii=False, default=str) for m in messages]
    return "\n".join(lines) + "\n"


def from_jsonl(text: str) -> tuple[dict[str, Any], list[BaseMessage]]:
    """The header and the messages of a JSONL export. Raises ValueError when the text is
    not one."""
    header: dict[str, Any] = {}
    records: list[dict[str, Any]] = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"line {number} is not JSON: {exc.msg}") from exc
        if not isinstance(item, dict):
            raise ValueError(f"line {number} is not an object")
        if item.get("format") == FORMAT:
            header = item
        elif "type" in item and "data" in item:
            records.append(item)
        else:
            raise ValueError(f"line {number} is not a message")
    if not records:
        raise ValueError("no messages in it")
    try:
        return header, messages_from_dict(records)
    except Exception as exc:  # noqa: BLE001 - a record of the wrong shape, whatever it raised
        raise ValueError(f"a message could not be read: {exc}") from exc


# ── HTML ───────────────────────────────────────────────────────────────────

_STYLE = """
:root { color-scheme: light dark; }
body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
       max-width: 52rem; margin: 2rem auto; padding: 0 1rem; background: Canvas; color: CanvasText; }
header { border-bottom: 1px solid GrayText; margin-bottom: 1.5rem; }
header p { color: GrayText; margin: .2rem 0 1rem; }
.you, .answer, details, .note { margin: 1rem 0; }
.you { border-left: 3px solid LinkText; padding: .2rem .8rem; white-space: pre-wrap; }
.answer { white-space: pre-wrap; }
.note { color: GrayText; font-style: italic; white-space: pre-wrap; }
details { border: 1px solid color-mix(in srgb, GrayText 40%, transparent); border-radius: 6px;
          padding: .3rem .7rem; }
details > summary { cursor: pointer; color: GrayText; }
pre { background: color-mix(in srgb, GrayText 12%, transparent); padding: .6rem .8rem;
      border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
code { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
"""

_FENCE_RE = re.compile(r"```[^\n]*\n(.*?)```", re.S)
_INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
_BOLD_RE = re.compile(r"\*\*([^*\n]+)\*\*")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.M)


def _markdown(text: str) -> str:
    """The parts of Markdown that matter for reading an answer: code blocks, inline code,
    bold and headings. The rest stays as written."""
    out: list[str] = []
    last = 0
    for match in _FENCE_RE.finditer(text):
        out.append(_inline(text[last:match.start()]))
        out.append(f"<pre><code>{html.escape(match.group(1).rstrip())}</code></pre>")
        last = match.end()
    out.append(_inline(text[last:]))
    return "".join(out)


def _inline(text: str) -> str:
    escaped = html.escape(text)
    escaped = _HEADING_RE.sub(lambda m: f"<strong>{m.group(2)}</strong>", escaped)
    escaped = _BOLD_RE.sub(r"<strong>\1</strong>", escaped)
    return _INLINE_CODE_RE.sub(r"<code>\1</code>", escaped)


def _call_summary(call: dict[str, Any]) -> str:
    args = call.get("args") or {}
    first = next((str(v) for v in args.values() if isinstance(v, (str, int, float))), "") \
        if isinstance(args, dict) else ""
    first = " ".join(first.split())
    if len(first) > 80:
        # a path keeps its end, which names the file; anything else keeps its start
        first = "…" + first[-79:] if "/" in first and " " not in first else first[:79] + "…"
    return f"{call.get('name', 'tool')}({first})"


def to_html(messages: list[BaseMessage], meta: SessionMeta) -> str:
    results = {m.tool_call_id: m for m in messages if isinstance(m, ToolMessage)}
    body: list[str] = []
    for msg in messages:
        if isinstance(msg, HumanMessage):
            if is_user_message(msg):
                body.append(f'<div class="you">{html.escape(shown_text(msg))}</div>')
            continue
        if not isinstance(msg, AIMessage):
            continue
        parsed = parse_content(msg.content)
        if parsed.thinking.strip():
            body.append("<details><summary>thinking</summary>"
                        f"<pre>{html.escape(parsed.thinking.strip())}</pre></details>")
        if parsed.text.strip():
            body.append(f'<div class="answer">{_markdown(parsed.text.strip())}</div>')
        for call in msg.tool_calls or []:
            result = results.get(str(call.get("id") or ""))
            failed = result is not None and getattr(result, "status", "") == "error"
            output = parse_content(result.content).text if result is not None else "(no result)"
            arguments = json.dumps(call.get("args") or {}, ensure_ascii=False, indent=2)
            body.append(
                f'<details class="tool">'
                f"<summary>{'✖' if failed else '●'} {html.escape(_call_summary(call))}</summary>"
                f"<pre><code>{html.escape(arguments)}</code></pre>"
                f"<pre><code>{html.escape(output)}</code></pre></details>")
    title = html.escape(meta.title or meta.thread_id)
    facts = " · ".join(html.escape(part) for part in (
        meta.thread_id, meta.model, meta.workspace,
        datetime.now(UTC).astimezone().strftime("%Y-%m-%d %H:%M")) if part)
    return (f'<!doctype html>\n<html><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width, initial-scale=1">'
            f"<title>{title}</title><style>{_STYLE}</style></head><body>"
            f"<header><h1>{title}</h1><p>{facts}</p></header>\n"
            + "\n".join(body) + "\n</body></html>\n")


def export_kind(path_text: str) -> str:
    """``html``, ``jsonl`` or ``md``, from a file name or a bare kind word."""
    lowered = path_text.lower()
    if lowered in ("html", "jsonl", "md"):
        return lowered
    if lowered.endswith((".html", ".htm")):
        return "html"
    if lowered.endswith(".jsonl"):
        return "jsonl"
    return "md"


def read_saved_messages(home: Any, thread_id: str, *, workspace: Any = None,
                        checkpoint: str | None = None) -> list[BaseMessage]:
    """A saved conversation's messages, without a session open (``circle --export``).
    The state is read through a harness, which knows how the messages are stored; its
    model is never called."""
    from circle.checkpoint_store import make_checkpointer
    from circle.harness import create_harness
    from circle.testing import ScriptedModel

    from pathlib import Path

    root = workspace if workspace and Path(workspace).is_dir() else None
    agent = create_harness(ScriptedModel(), root_dir=root, home=home,
                           checkpointer=make_checkpointer(home))
    configurable = {"thread_id": thread_id}
    if checkpoint:
        configurable["checkpoint_id"] = checkpoint
    state = agent.get_state({"configurable": configurable})
    return list((getattr(state, "values", None) or {}).get("messages") or [])
