"""Minimal footer lexicon stubs (subset of InfoTest display_lexicon)."""

from __future__ import annotations

FOOTER_API_ERROR_LEAD = "API"
FOOTER_RETRY_TIMEOUT = "timed out"
FOOTER_LONG_WAIT_S = 60
FOOTER_NO_TOKENS_YET = "no tokens yet"
FOOTER_MODEL_CALL = "model call"
FOOTER_BETWEEN_ROUNDS = "between rounds"
FOOTER_WORKER_PREFIX = "worker"


def _slot_int(value: object) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _wait_duration_slot(seconds: object) -> str:
    secs = _slot_int(seconds)
    if secs is None or secs <= 0:
        return ""
    return f"{secs // 60}m" if secs >= FOOTER_LONG_WAIT_S else f"{secs}s"


def api_error_slot(
    code: object,
    attempt: object = None,
    max_attempts: object = None,
    waited_s: object = None,
    *,
    exhausted: bool = False,
) -> str:
    head = str(code if code not in (None, "") else "").strip()
    if not head:
        return ""
    parts = [f"{FOOTER_API_ERROR_LEAD} {head}"]
    n, total = _slot_int(attempt), _slot_int(max_attempts)
    if n is not None and total is not None and total > 0:
        parts.append(f"retry {n}/{total}")
    elif n is not None and n > 0 and max_attempts is None:
        parts.append(f"retry #{n}")
    if exhausted:
        parts.append(FOOTER_RETRY_TIMEOUT)
    else:
        secs = _slot_int(waited_s)
        if secs is not None and secs > 0:
            parts.append(f"waiting {secs}s")
    return " · ".join(parts)


def api_waiting_aggregate_slot(
    workers: object,
    code: object,
    longest_s: object,
    worker_id: object = "",
) -> str:
    n = _slot_int(workers) or 0
    if n <= 0:
        return ""
    head = str(code if code not in (None, "") else "").strip()
    parts = [f"{n} workers waiting"]
    if head:
        parts.append(f"{FOOTER_API_ERROR_LEAD} {head}")
    span = _wait_duration_slot(longest_s)
    if span:
        name = str(worker_id or "").strip()
        parts.append(f"{name} {span}".strip() if name else span)
    return " · ".join(parts)


def footer_model_call_slot(seconds: object) -> str:
    span = _wait_duration_slot(seconds)
    return f"{FOOTER_MODEL_CALL} {span}".strip() if span else FOOTER_MODEL_CALL


def footer_tool_slot(tool: object, seconds: object) -> str:
    name = str(tool or "tool").strip() or "tool"
    span = _wait_duration_slot(seconds)
    return f"{name} {span}".strip() if span else name


def footer_between_rounds_slot(seconds: object) -> str:
    span = _wait_duration_slot(seconds)
    return f"{FOOTER_BETWEEN_ROUNDS} {span}".strip() if span else FOOTER_BETWEEN_ROUNDS


def footer_worker_slot(worker_id: object, tail: str) -> str:
    name = str(worker_id or "").strip()
    head = f"{FOOTER_WORKER_PREFIX} {name}".strip() if name else FOOTER_WORKER_PREFIX
    return f"{head} · {tail}" if tail else head


# ── 工具结果判读（移植自 InfoTest display_lexicon；reducer 与渲染共用这一处）──

from collections.abc import Mapping as _Mapping  # noqa: E402

ERROR_WITHOUT_TEXT = "出错了，但没有给出可读的说明"

_ERROR_LEAD_TEXTS = ("error:", "错误")
_ERROR_LEAD_GLYPHS = ("✗", "❌", "✖")
_INBOUND_STATUS_GLYPH_RE = __import__("re").compile(r"^[✓✗❌✖●]\s*")


def structured_args(args):
    """Tool input as a mapping; a ``{"raw": …, "args": {…}}`` envelope yields its args."""
    if not args:
        return {}
    envelope = args.get("args")
    if isinstance(envelope, _Mapping) and set(args) <= {"raw", "args"}:
        return envelope
    return {k: v for k, v in args.items() if k != "raw"}


def extract_from_raw(args, key: str) -> str:
    import re

    raw = (args or {}).get("raw") or ""
    if not isinstance(raw, str):
        return ""
    m = re.search(rf"""['"]?{re.escape(key)}['"]?\s*[:=]\s*['"]([^'"]+)['"]""", raw)
    return m.group(1) if m else ""


def tool_arg_value(args, key: str) -> str:
    value = structured_args(args).get(key)
    if isinstance(value, str) and value:
        return value
    if value not in (None, "", (), [], {}) and not isinstance(value, (list, tuple, set, dict)):
        return str(value)
    return extract_from_raw(args, key)


def strip_leading_status_glyph(text: str) -> str:
    return _INBOUND_STATUS_GLYPH_RE.sub("", str(text or ""))


def tool_result_is_error(output: object, status: object = "") -> bool:
    """``status == "error"`` or a result that opens with an error marker.

    The union matters: results recorded before status was carried have only the text.
    """
    if str(status or "").strip().lower() == "error":
        return True
    lead = str(output or "").lstrip()
    if not lead:
        return False
    return lead.lower().startswith(_ERROR_LEAD_TEXTS) or lead.startswith(_ERROR_LEAD_GLYPHS)


def tool_result_recoverable(payload) -> bool:
    return isinstance(payload, _Mapping) and payload.get("recoverable") is True


# ── 工具行：短名与参数摘要（一处声明；渲染层只查表，不按工具名写分支）──

TOOL_SHORT_NAMES: dict[str, str] = {
    "read_file": "Read",
    "write_file": "Write",
    "edit_file": "Edit",
    "apply_patch": "Patch",
    "delete": "Delete",
    "ls": "Ls",
    "glob": "Glob",
    "grep": "Grep",
    "execute": "Bash",
    "task": "Agent",
    "write_todos": "TodoWrite",
    "webfetch": "Fetch",
    "websearch": "Search",
    "question": "Ask",
    "skill": "Skill",
    "lsp": "Lsp",
    "compact_conversation": "Compact",
}

# 工具名 → ((入参键, 压行方式), …)；按顺序取第一个有值的键
TOOL_ARG_SUMMARY: dict[str, tuple[tuple[str, str], ...]] = {
    "read_file": (("file_path", "path_tail"), ("path", "path_tail")),
    "write_file": (("file_path", "path_tail"), ("path", "path_tail")),
    "edit_file": (("file_path", "path_tail"), ("path", "path_tail")),
    "delete": (("file_path", "path_tail"), ("path", "path_tail")),
    "apply_patch": (("patchText", "patch_target"),),
    "ls": (("path", "path_tail"),),
    "glob": (("pattern", "text"),),
    "grep": (("pattern", "text"),),
    "execute": (("command", "first_line"),),
    "task": (("description", "first_line"), ("subagent_type", "text")),
    "webfetch": (("url", "text"),),
    "websearch": (("query", "text"),),
    "question": (("questions", "first_line"),),
    "skill": (("name", "text"), ("skill", "text")),
    "lsp": (("operation", "text"), ("file_path", "path_tail")),
}

_SUMMARY_MAX = 60


def tool_short_name(raw: str) -> str:
    return TOOL_SHORT_NAMES.get(str(raw or ""), str(raw or ""))


def _clip(text: str, width: int = _SUMMARY_MAX) -> str:
    text = " ".join(str(text or "").split())
    return text[:width - 1] + "…" if len(text) > width else text


def _summarize(style: str, value: object) -> str:
    if isinstance(value, (list, tuple, set, dict)) or value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    if style == "path_tail":
        parts = [p for p in text.replace("\\", "/").split("/") if p]
        tail = "/".join(parts[-2:]) if len(parts) > 2 else text
        return _clip(tail if tail == text else f"…/{tail}")
    if style == "first_line":
        return _clip(text.splitlines()[0] if text.splitlines() else "")
    if style == "patch_target":
        import re

        match = re.search(r"\*\*\* (?:Add|Update|Delete) File:\s*(\S+)", text)
        return _summarize("path_tail", match.group(1)) if match else ""
    return _clip(text)


def tool_arg_summary(name: str, args) -> str:
    """One short phrase for the tool row; tools not in the table show their first
    scalar argument, and nothing at all rather than a dict repr."""
    values = structured_args(args if isinstance(args, _Mapping) else {})
    for key, style in TOOL_ARG_SUMMARY.get(str(name or ""), ()):
        value = values.get(key)
        if value in (None, "") and isinstance(args, _Mapping):
            value = extract_from_raw(args, key) or None
        shown = _summarize(style, value)
        if shown:
            return shown
    if str(name or "") in TOOL_ARG_SUMMARY:
        return ""
    for value in values.values():
        shown = _summarize("text", value)
        if shown:
            return shown
    return ""
