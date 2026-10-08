"""Turn a ``MessageSnapshot`` into the transcript entries of the current turn.

Pure: the same snapshot and options always give the same entries, so live rendering
and a ctrl+o / ctrl+t re-render draw the same bytes. Each entry is one transcript
message (it may span several lines).

Layout follows InfoTest's single tool-row form: every tool call is one row
``{light} {Short}({summary})`` with its result on ``⎿`` lines right below it, whether
it succeeded, failed or was refused. A failure the model can fix itself (bad
arguments, unknown tool name) gets no lamp and a muted strikethrough instead of red.

Pacing and tints follow InfoTest's final display contract (07 §11.25): blocks are
separated by exactly one blank entry and nothing inside a block — an answer block is
its ``∴`` thinking rows plus the ``⏺`` text after them, a tool group is consecutive
tool rows; two text entries are two blocks. A tool row and its ``⎿`` lines carry the
tool's type tint (read blue, write green, agent bright cyan), thinking rows the
thinking tint; answer text is never tinted.

A ``task`` row carries its subagent folded underneath: one meta line (name, calls,
elapsed, tokens) and, while it runs, its last few calls; ctrl+o lists them all. The
whole call-by-call record is on the agent's detail page.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from circle.display_lexicon import (
    tool_arg_summary,
    tool_result_recoverable,
    tool_short_name,
)
from circle.ink.components.markdown_renderer import MarkdownRenderer, word_wrap
from circle.ink.string_width import char_width, string_width
from circle.ink.theme import GLYPH_AGENT, GLYPH_ERROR, palette, status_light
from circle.tui.agent_strip import (
    card_calls,
    card_elapsed,
    card_running,
    card_tokens,
    format_elapsed,
    format_tokens,
    snapshot_cards,
)
from circle.tui.content_blocks import render_thinking_line
from circle.tui.job_rows import background_line, notice_rows, plain_output
from circle.tui.message_model import (
    BLOCK_ERROR,
    BLOCK_JOB_NOTICE,
    BLOCK_STEER,
    BLOCK_TEXT,
    BLOCK_THINKING,
    BLOCK_TODO_LIST,
    BLOCK_TOOL_RESULT,
    BLOCK_TOOL_USE,
    BLOCK_WARN,
    ContentBlock,
    MessageSnapshot,
)
from circle.tui.tool_display import PREVIEW_LINES, display_lines

_WAIT_SUFFIX_W = len("  waiting for you")
COLLAPSED_HINT_MIN_HIDDEN = 1
COLLAPSED_WRAP_ROWS = 3
SUBAGENT_RECENT_CALLS = 3
_HIDDEN_TOOLS = frozenset({"write_todos"})  # 由计划面板显示，不占工具行
_READ_RANGE = re.compile(r"^@@ lines (\d+)-(\d+) of \d+ @@")
# What the model is told when a command goes on in the background, and the exit status
# deepagents adds after it: the transcript says it in one line instead
_JOB_NOTE = re.compile(r"\[The command[^\[\]]*stop_job\.\]\s*$", re.S)
_EXIT_STATUS = re.compile(r"\n*\[Command (?:succeeded|failed) with exit code -?\d+\]\s*$")

# 动作类型 → 底色（InfoTest 07 章 §11.25(2)，同类同色）：读＝查阅文件/代码/网页/skill，
# 写＝改文件，agent＝子代理；执行命令、问询这类不归类的不铺底色。
_TOOL_TYPE_READ = frozenset({"read_file", "ls", "glob", "grep", "lsp", "skill",
                             "webfetch", "websearch"})
# 契约 D0：Bash（execute）会改状态，归写色；question 是模型在向你提问，归思考/计划的洋红。
_TOOL_TYPE_WRITE = frozenset({"write_file", "edit_file", "apply_patch", "delete", "execute"})
_TOOL_TYPE_AGENT = frozenset({"task"})
_TOOL_TYPE_THINK = frozenset({"question"})

# 块间空行裁决表：本块紧跟在哪些块后面算同一块（不补空行）；其余一律隔 1 行。
# text 只续 thinking（∴ → ⏺ 同一回答块）；text → text 不续，两个 ⏺ 块之间恒 1 空行。
def user_rows(text: str, width: int | None = None) -> list[str]:
    """Your message: the blue ``›`` on the first row (marker column 1), the words emphasised,
    continuation rows indented to the text column. With ``width`` long lines are broken
    between words, as answers are."""
    pal = palette()
    lines: list[str] = []
    for line in text.split("\n"):
        styled = f"{pal.em}{line}{pal.reset}"
        lines.extend(word_wrap(styled, width - 3, pal.reset) if width else [styled])
    return [(f" {pal.blue}›{pal.reset} " if i == 0 else "   ") + ln for i, ln in enumerate(lines)]


_BLOCK_CONTINUES: dict[str, frozenset[str]] = {
    "text": frozenset({"thinking"}),
    "thinking": frozenset({"thinking"}),
    "tool": frozenset({"tool"}),
}

Row = tuple[str, str | None]


@dataclass
class ViewOptions:
    width: int = 100
    tools_expanded: bool = False
    thinking_expanded: bool = False
    show_thinking: bool = True
    # 扩展为某个工具注册的结果渲染器：fn(update) -> list[str]
    renderer_for: Callable[[str], Callable[[Any], Iterable[str]] | None] = lambda _name: None
    # 等待审批、尚未执行的调用（HITL 请求里的 name/args）
    pending_calls: list[dict] = field(default_factory=list)
    # 在跑子代理的耗时与黄灯明暗相都按它算；None 取当前时间
    now: float | None = None


def _fit_summary(name: str, summary: str, width: int) -> str:
    available = max(8, width - string_width(name) - 6)
    if string_width(summary) <= available:
        return summary
    if name in {"Read", "Write", "Edit", "Patch"} and "/" in summary:
        tail = "…/" + summary.rsplit("/", 1)[-1]
        if string_width(tail) <= available:
            return tail
        kept = ""
        for char in reversed(tail):
            if string_width(kept) + char_width(char) > available - 1:
                break
            kept = char + kept
        return "…" + kept
    used, out = 0, []
    for char in summary:
        if used + char_width(char) > available - 1:
            break
        used += char_width(char)
        out.append(char)
    return "".join(out) + "…"


def _wrap(text: str, width: int, *, max_rows: int | None = None) -> tuple[list[str], int]:
    """Wrap a line and report any characters hidden by the collapsed row limit."""
    if not text:
        return [""], 0
    parts: list[str] = []
    current, used = "", 0
    for index, char in enumerate(text):
        char_w = char_width(char)
        if current and used + char_w > width:
            parts.append(current)
            if max_rows is not None and len(parts) >= max_rows:
                return parts, len(text) - index
            current, used = "", 0
        current += char
        used += char_w
    parts.append(current)
    return parts, 0


def _line_word(count: int) -> str:
    return "line" if count == 1 else "lines"


def _read_summary(summary: str, result: ContentBlock | None) -> str:
    if result is None or result.is_error:
        return summary
    match = _READ_RANGE.match(str(result.output or ""))
    return f"{summary}:{match.group(1)}-{match.group(2)}" if summary and match else summary


def tool_type_bg_hex(name: str) -> str | None:
    """The type tint (hex) for a tool's row and its ``⎿`` lines; None for no tint."""
    pal = palette()
    name = str(name or "")
    if name in _TOOL_TYPE_READ:
        return pal.read_bg_hex or None
    if name in _TOOL_TYPE_WRITE:
        return pal.write_bg_hex or None
    if name in _TOOL_TYPE_AGENT:
        return pal.agent_bg_hex or None
    if name in _TOOL_TYPE_THINK:
        return pal.think_bg_hex or None
    return None


def tool_type_bg_sgr(name: str) -> str:
    """The same tint as an SGR background, for blocks built from raw escape codes (the
    approval card carries the tint of the tool it asks about)."""
    pal = palette()
    name = str(name or "")
    if name in _TOOL_TYPE_READ:
        return pal.read_bg
    if name in _TOOL_TYPE_WRITE:
        return pal.write_bg
    if name in _TOOL_TYPE_AGENT:
        return pal.agent_bg
    if name in _TOOL_TYPE_THINK:
        return pal.think_bg
    return ""


def _text_entry(text: str, opts: ViewOptions) -> str:
    # 标记占 3 列（" ⏺ "），续行同样缩 3 列：正文宽 = 总宽 - 3
    rendered = MarkdownRenderer(width=max(20, opts.width - 3)).render_streaming(text.strip())
    lines = rendered.split("\n")
    return "\n".join([f" {GLYPH_AGENT} {lines[0]}"] + [f"   {ln}" if ln else "" for ln in lines[1:]])


def _tool_row(block: ContentBlock, result: ContentBlock | None, opts: ViewOptions) -> str:
    pal = palette()
    name = tool_short_name(block.name)
    summary = tool_arg_summary(block.name, dict(block.input))
    if block.name == "read_file":
        summary = _read_summary(summary, result)
    waiting = result is None and block.name == "question" and block.status != "error"
    # the "  waiting for you" suffix is part of the row: make room for it, or the row wraps
    summary = _fit_summary(name, summary, opts.width - (_WAIT_SUFFIX_W if waiting else 0))
    call = f"{name}({summary})"
    if waiting:
        # 提问没有回执之前就是在等用户：青灯（第五态）
        return f" {status_light('wait')} {pal.text}{call}{pal.reset}  {pal.blue}waiting for you{pal.reset}"
    if result is None:
        light = status_light("running" if block.status == "running" else "none")
        return f" {light} {pal.text}{call}{pal.reset}"
    if result.is_error and tool_result_recoverable(result.payload):
        return f" {status_light('none')} {pal.muted_strike}{call}{pal.reset}"
    light = status_light("error" if result.is_error else "ok")
    return f" {light} {pal.text}{call}{pal.reset}"


def _job_result_lines(job: Any, result: ContentBlock, opts: ViewOptions) -> list[str]:
    """A call that went on as a background job: what it printed before (for a command moved
    there, or one that left processes running), then one faint line naming the job. The
    note to the model about notices is not shown."""
    pal = palette()
    text = str(result.output or "")
    if job.get("how") == "started":
        text = ""
    text = _EXIT_STATUS.sub("", text).rstrip()
    text = plain_output(_JOB_NOTE.sub("", text).rstrip())
    out: list[str] = []
    if text and text != "<no output>":
        raw = text.splitlines()
        shown = raw if opts.tools_expanded else raw[:PREVIEW_LINES]
        for index, line in enumerate(shown):
            prefix = "   ⎿ " if index == 0 else "     "
            for part_index, part in enumerate(_wrap(line, max(20, opts.width - 6),
                                                    max_rows=COLLAPSED_WRAP_ROWS)[0]):
                out.append(f"{prefix if part_index == 0 else '     '}{pal.faint}{part}{pal.reset}")
        hidden = len(raw) - len(shown)
        if hidden >= COLLAPSED_HINT_MIN_HIDDEN:
            out.append(f"     {pal.faint}… +{hidden} {_line_word(hidden)} · ctrl+o{pal.reset}")
    prefix = "     " if out else "   ⎿ "
    out.append(f"{prefix}{pal.faint}{background_line(job)}{pal.reset}")
    return out


def _result_lines(block: ContentBlock, result: ContentBlock, opts: ViewOptions) -> list[str]:
    pal = palette()
    job = (result.payload or {}).get("job")
    if isinstance(job, Mapping) and not result.is_error:
        return _job_result_lines(job, result, opts)
    lines = display_lines(str(result.output or ""), result.payload, is_error=result.is_error)
    while lines and not lines[-1]["text"]:
        lines.pop()
    if not lines:
        lines = [{"text": "(no output)", "tone": ""}]
    recoverable = result.is_error and tool_result_recoverable(result.payload)
    if block.name == "read_file" and not result.is_error and not opts.tools_expanded:
        raw = str(result.output or "").rstrip("\n").splitlines()
        match = _READ_RANGE.match(raw[0]) if raw else None
        # The range is in the call row already; the result says how much came back.
        count = int(match.group(2)) - int(match.group(1)) + 1 if match else len(raw)
        header = f"Read {count} line{'s' if count != 1 else ''}"
        hidden = max(0, len(raw) - (1 if match else 0))
        hint = " · ctrl+o" if hidden else ""
        return [f"   ⎿ {pal.faint}{header}{hint}{pal.reset}"]
    if not opts.tools_expanded:
        shown = lines[:PREVIEW_LINES]
        hidden = len(lines) - len(shown)
        if hidden >= COLLAPSED_HINT_MIN_HIDDEN:
            shown = [*shown, {"text": f"… +{hidden} {_line_word(hidden)} · ctrl+o", "tone": ""}]
    else:
        shown = lines
    out: list[str] = []
    for index, item in enumerate(shown):
        prefix = "   ⎿ " if index == 0 else "     "
        color = pal.muted_strike if recoverable else (pal.red if result.is_error else pal.faint)
        if not (recoverable or result.is_error):
            color = {"added": pal.green, "removed": pal.red}.get(item["tone"], pal.faint)
        parts, hidden_chars = _wrap(
            item["text"],
            max(20, opts.width - string_width(prefix) - 1),
            max_rows=None if opts.tools_expanded else COLLAPSED_WRAP_ROWS,
        )
        for part_index, part in enumerate(parts):
            out.append(f"{prefix if part_index == 0 else '     '}{color}{part}{pal.reset}")
        if hidden_chars:
            out.append(f"     {pal.faint}… +{hidden_chars} chars · ctrl+o{pal.reset}")
    return out


def _extension_lines(block: ContentBlock, result: ContentBlock, opts: ViewOptions) -> list[str] | None:
    renderer = opts.renderer_for(block.name)
    if renderer is None:
        return None
    update = SimpleNamespace(tool_name=block.name, tool_output=str(result.output or ""),
                             tool_call_id=block.tool_use_id, is_error=result.is_error)
    try:
        lines = [str(line) for line in (renderer(update) or [])]
    except Exception:  # noqa: BLE001 — a broken renderer falls back to the default lines
        return None
    if not lines or opts.tools_expanded or len(lines) <= PREVIEW_LINES:
        return lines or None
    hidden = len(lines) - PREVIEW_LINES
    return [*lines[:PREVIEW_LINES], f"     {palette().faint}… +{hidden} {_line_word(hidden)} · ctrl+o{palette().reset}"]


def subagent_call_row(item: Mapping[str, Any], *, now: float | None = None) -> str:
    """One call a subagent made, in the same form as a main tool row (no indent)."""
    pal = palette()
    tool = str(item.get("tool") or "tool")
    args = item.get("input") if isinstance(item.get("input"), Mapping) else {}
    call = f"{tool_short_name(tool)}({tool_arg_summary(tool, dict(args))})"
    status = str(item.get("status") or "running")
    if status == "error" and tool_result_recoverable(item):
        return f"{status_light('none')} {pal.muted_strike}{call}{pal.reset}"
    light = status_light(status if status in ("ok", "error") else "running", now=now)
    return f"{light} {pal.text}{call}{pal.reset}"


def _subagent_lines(card: Mapping[str, Any], opts: ViewOptions, now: float) -> list[str]:
    pal = palette()
    meta = (f"{card.get('name') or 'agent'} · {card_calls(card)} calls · "
            f"{format_elapsed(card_elapsed(card, now))} · "
            f"{format_tokens(card_tokens(card))} tokens")
    if card.get("awaiting_approval") or card.get("awaiting_question"):
        meta += " · waiting for you"
    lines = [f"   ⎿ {pal.faint}{meta}{pal.reset}"]
    calls = [item for item in card.get("transcript") or ()
             if isinstance(item, Mapping) and item.get("kind") == "tool"]
    if opts.tools_expanded:
        shown = calls
    elif card_running(card):
        shown = calls[-SUBAGENT_RECENT_CALLS:]
    else:
        shown = []
    if shown and len(calls) > len(shown):
        lines.append(f"     {pal.faint}… +{len(calls) - len(shown)} earlier · ctrl+o{pal.reset}")
    lines += [f"     {subagent_call_row(item, now=now)}" for item in shown]
    return lines


def _tool_entry(block: ContentBlock, result: ContentBlock | None, opts: ViewOptions,
                card: Mapping[str, Any] | None = None) -> str:
    parts = [_tool_row(block, result, opts)]
    if card is not None:
        parts += _subagent_lines(card, opts, time.time() if opts.now is None else opts.now)
    if result is not None:
        parts += _extension_lines(block, result, opts) or _result_lines(block, result, opts)
    return "\n".join(parts)


def _pending_entry(request: dict, width: int = 100) -> str:
    pal = palette()
    name = str(request.get("name") or "tool")
    args = request.get("args") if isinstance(request.get("args"), dict) else {}
    short = tool_short_name(name)
    summary = _fit_summary(short, tool_arg_summary(name, {"args": args}), width - _WAIT_SUFFIX_W)
    call = f"{short}({summary})"
    return f" {status_light('wait')} {pal.text}{call}{pal.reset}  {pal.blue}waiting for you{pal.reset}"


def render_turn_rows(snap: MessageSnapshot, opts: ViewOptions) -> list[Row]:
    """The turn's entries with each one's background tint (hex, or None)."""
    results: dict[str, ContentBlock] = {}
    for msg in snap.messages:
        for block in msg.content:
            if block.type == BLOCK_TOOL_RESULT and block.tool_use_id:
                results[block.tool_use_id] = block
    called = {b.tool_use_id for m in snap.messages for b in m.content if b.type == BLOCK_TOOL_USE}
    cards = {str(card.get("tool_use_id") or ""): card for _uuid, card in snapshot_cards(snap)}
    think_bg = palette().think_bg_hex or None

    rows: list[Row] = []
    last_kind = ""

    def add(entry: str, kind: str, bg: str | None = None) -> None:
        nonlocal last_kind
        if rows and last_kind not in _BLOCK_CONTINUES.get(kind, frozenset()):
            rows.append(("", None))
        rows.append((entry, bg or None))
        last_kind = kind

    for msg in snap.messages:
        if msg.parent_tool_use_id:
            continue  # 子代理内部事件：由子代理卡片承载
        for block in msg.content:
            if block.type == BLOCK_THINKING:
                if opts.show_thinking and (block.thinking or block.thinking_title):
                    add(render_thinking_line(body=block.thinking, done=block.thinking_done,
                                             expanded=opts.thinking_expanded,
                                             title=block.thinking_title,
                                             duration_s=block.thinking_duration_s,
                                             width=opts.width),
                        "thinking", think_bg)
            elif block.type == BLOCK_TEXT:
                if block.text.strip():
                    add(_text_entry(block.text, opts), "text")
            elif block.type == BLOCK_STEER:
                add("\n".join(user_rows(str((block.payload or {}).get("text") or ""),
                                         opts.width)), "steer")
            elif block.type == BLOCK_JOB_NOTICE:
                add("\n".join(notice_rows((block.payload or {}).get("jobs") or [])), "notice")
            elif block.type == BLOCK_TOOL_USE:
                if block.name not in _HIDDEN_TOOLS:
                    add(_tool_entry(block, results.get(block.tool_use_id), opts,
                                    cards.get(block.tool_use_id)),
                        "tool", tool_type_bg_hex(block.name))
            elif block.type == BLOCK_TOOL_RESULT:
                if block.tool_use_id not in called and block.name not in _HIDDEN_TOOLS:
                    orphan = ContentBlock(type=BLOCK_TOOL_USE, name=block.name, status="done")
                    add(_tool_entry(orphan, block, opts), "tool", tool_type_bg_hex(block.name))
            elif block.type == BLOCK_ERROR:
                pal = palette()
                text = str(block.payload.get("text") or "")
                add(f" {pal.red}{GLYPH_ERROR}{pal.reset} {text}", "error")
            elif block.type == BLOCK_WARN:
                pal = palette()
                add(f" {pal.yellow}{GLYPH_ERROR}{pal.reset} {block.payload.get('text') or ''}", "warn")
    for request in opts.pending_calls:
        add(_pending_entry(request, opts.width), "tool", tool_type_bg_hex(str(request.get("name") or "")))
    if snap.streaming_text and snap.streaming_text.strip():
        add(_text_entry(snap.streaming_text, opts), "text")
    return rows


def render_turn(snap: MessageSnapshot, opts: ViewOptions) -> list[str]:
    return [entry for entry, _bg in render_turn_rows(snap, opts)]


def latest_todos(snap: MessageSnapshot) -> list[dict] | None:
    """The newest ``write_todos`` list in the snapshot; None when there is none."""
    for msg in reversed(snap.messages):
        for block in msg.content:
            if block.type == BLOCK_TODO_LIST:
                todos = block.payload.get("todos") if block.payload else None
                return [dict(t) for t in todos or () if isinstance(t, Mapping)]
    return None


def turn_had_output(snap: MessageSnapshot) -> bool:
    """Whether the main agent answered or called anything this turn."""
    for msg in snap.messages:
        if msg.parent_tool_use_id:
            continue
        for block in msg.content:
            if block.type == BLOCK_TOOL_USE:
                return True
            if block.type == BLOCK_TEXT and block.text.strip():
                return True
    return bool(snap.streaming_text and snap.streaming_text.strip())


def final_text(snap: MessageSnapshot) -> str:
    """The last answer text of the turn (for history and the session tree)."""
    for msg in reversed(snap.messages):
        if msg.parent_tool_use_id:
            continue
        for block in msg.content:
            if block.type == BLOCK_TEXT and block.text.strip():
                return block.text.strip()
    return ""
