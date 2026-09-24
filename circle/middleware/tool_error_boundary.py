"""Exceptions escaping a tool become an error ToolMessage (the turn keeps going).

Without this, one tool raising an unexpected exception (a bug in an extension tool,
an MCP transport error, a backend failure) ends the whole agent run. The model gets
the exception type and the first line of its message, redacted and capped; for
argument-schema errors it gets the field paths and received types, never the values.

Graph control flow (interrupts, ``GraphBubbleUp``) and hard budgets
(``ToolCallLimitExceededError``) are re-raised: catching them would break approval
prompts and turn a hard limit into a soft one.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphBubbleUp

from circle.middleware.redact import redact

logger = logging.getLogger(__name__)

TOOL_EXECUTION_FAULT_PREFIX = "Tool execution failed: "
_MESSAGE_CAP = 300
_VALIDATION_DETAIL_CAP = 600
_MAX_LISTED_FIELD_ERRORS = 6


def _pass_through_types() -> tuple[type[BaseException], ...]:
    out: list[type[BaseException]] = [GraphBubbleUp]
    try:
        from langchain.agents.middleware.tool_call_limit import ToolCallLimitExceededError

        out.append(ToolCallLimitExceededError)
    except Exception:  # noqa: BLE001 — older langchain without the limit middleware
        pass
    return tuple(out)


_PASS_THROUGH = _pass_through_types()


def _call_identity(request: Any) -> tuple[str, str]:
    call = getattr(request, "tool_call", None)
    call = call if isinstance(call, dict) else {}
    name = str(call.get("name") or "tool")
    tool = getattr(request, "tool", None)
    if tool is not None:
        name = str(getattr(tool, "name", "") or name)
    call_id = str(call.get("id") or "") or f"tool-fault-{name}"
    return name, call_id


def validation_detail(exc: BaseException) -> str | None:
    """Field path + expectation + received *type* from a pydantic-style ``errors()``."""
    errors = getattr(exc, "errors", None)
    if not callable(errors):
        return None
    try:
        rows = list(errors())
    except Exception:  # noqa: BLE001
        return None
    parts: list[str] = []
    for row in rows[:_MAX_LISTED_FIELD_ERRORS]:
        if not isinstance(row, dict):
            continue
        loc = ".".join(str(item) for item in (row.get("loc") or ())) or "<root>"
        note = str(row.get("msg") or "is invalid")
        # for a missing field ``input`` is the enclosing object, not this field's value
        missing = str(row.get("type") or "").startswith("missing")
        received = type(row.get("input")).__name__ if "input" in row and not missing else ""
        parts.append(f"{loc}: {note}" + (f" (received {received})" if received else ""))
    if not parts:
        return None
    more = len(rows) - len(parts)
    return "; ".join(parts) + (f"; +{more} more field(s)" if more > 0 else "")


def fault_text(exc: BaseException, *, tool_name: str = "") -> str:
    detail = validation_detail(exc)
    if detail is not None:
        named = f"{tool_name} " if tool_name else "this tool "
        return (f"{TOOL_EXECUTION_FAULT_PREFIX}{type(exc).__name__}: {named}was called with "
                f"invalid arguments — {redact(detail)[:_VALIDATION_DETAIL_CAP]}. Re-issue the "
                "call with arguments that satisfy the declared schema; no work was done.")
    raw = str(exc)
    first = redact(raw.splitlines()[0] if raw else "")[:_MESSAGE_CAP]
    return f"{TOOL_EXECUTION_FAULT_PREFIX}{type(exc).__name__}: {first}"


class ToolErrorBoundaryMiddleware(AgentMiddleware):
    """Outermost tool wrapper: mount it first so it also covers the other middleware."""

    def _handle(self, request: Any, exc: Exception) -> ToolMessage:
        tool_name, call_id = _call_identity(request)
        logger.exception("tool %s raised out of the execution boundary", tool_name)
        return ToolMessage(content=fault_text(exc, tool_name=tool_name), name=tool_name,
                           tool_call_id=call_id, status="error")

    def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        try:
            return handler(request)
        except _PASS_THROUGH:
            raise
        except Exception as exc:  # noqa: BLE001 — every other tool fault becomes a result
            return self._handle(request, exc)

    async def awrap_tool_call(self, request: Any,
                              handler: Callable[[Any], Awaitable[Any]]) -> Any:
        try:
            return await handler(request)
        except _PASS_THROUGH:
            raise
        except Exception as exc:  # noqa: BLE001
            return self._handle(request, exc)
