"""Mark a tool result the model can fix itself (bad arguments, unknown tool name).

The UI draws these muted instead of red; the model still gets the full text.
Ported unchanged from InfoTest ``main/ist_core/tool_recoverable.py``.
"""

from __future__ import annotations

from typing import Any

RECOVERABLE_KEY = "recoverable"


class RecoverableToolError(RuntimeError):

    recoverable = True


def is_recoverable_error(exc: Any) -> bool:
    if isinstance(exc, RecoverableToolError):
        return True
    return getattr(exc, "recoverable", None) is True


def mark_recoverable(msg: Any) -> Any:
    extras = getattr(msg, "additional_kwargs", None)
    if isinstance(extras, dict):
        extras[RECOVERABLE_KEY] = True
    return msg


def is_recoverable_message(msg: Any) -> bool:
    extras = getattr(msg, "additional_kwargs", None)
    if not isinstance(extras, dict):
        return False
    return extras.get(RECOVERABLE_KEY) is True


__all__ = [
    "RECOVERABLE_KEY",
    "RecoverableToolError",
    "is_recoverable_error",
    "is_recoverable_message",
    "mark_recoverable",
]
