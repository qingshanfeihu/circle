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
