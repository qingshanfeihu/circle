"""Event bus between the agent run and the UI.

One bus per run; the progress handler emits ``llm_*`` / ``tool_*`` / ``run_*``
events, and a sink (``circle.tui.sink.TuiSink``) folds them into snapshots for the
screen. Ported from InfoTest ``main/ist_core/events.py`` with the compile-engine
kinds left out.
"""

from __future__ import annotations

import contextvars
import itertools
import logging
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Literal, TypedDict

logger = logging.getLogger(__name__)

EventKind = Literal[
    "run_start",
    "run_end",
    "run_error",
    "tool_call",
    "tool_start",
    "tool_result",
    "tool_end",
    "llm_start",
    "llm_token",
    "llm_end",
    "todo_list",
    "ask_user_request",
    "ask_user_presented",
    "ask_user_answered",
    "ask_user_resolved",
    "error",
    "warn",
    "info",
]


class CircleEvent(TypedDict, total=False):
    run_id: str
    parent_run_id: str | None
    seq: int
    ts: str
    kind: EventKind
    payload: dict[str, Any]
    tags: dict[str, Any]
    usage: dict[str, Any] | None
    elapsed_ms: int | None


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class EventBus:
    def __init__(self, run_id: str | None = None) -> None:
        self._run_id = run_id or ""
        self._seq = itertools.count(1)
        self._lock = threading.Lock()
        self._sinks: list[Callable[[CircleEvent], None]] = []
        self._default_tags: dict[str, Any] = {}

    def set_default_tags(self, tags: dict[str, Any]) -> None:
        self._default_tags.update(tags)

    def set_run_id(self, run_id: str) -> None:
        self._run_id = run_id

    def subscribe(self, sink: Callable[[CircleEvent], None]) -> None:
        self._sinks.append(sink)

    def emit(self, kind: EventKind, *, payload: dict[str, Any] | None = None,
             tags: dict[str, Any] | None = None, usage: dict[str, Any] | None = None,
             elapsed_ms: int | None = None, parent_run_id: str | None = None) -> CircleEvent:
        with self._lock:
            seq = next(self._seq)
        event: CircleEvent = {
            "run_id": self._run_id,
            "parent_run_id": parent_run_id,
            "seq": seq,
            "ts": _now(),
            "kind": kind,
            "payload": payload or {},
            "tags": {**self._default_tags, **(tags or {})},
            "usage": usage,
            "elapsed_ms": elapsed_ms,
        }
        for sink in list(self._sinks):
            try:
                sink(event)
            except Exception:  # noqa: BLE001 — one broken sink must not stop the others
                logger.debug("event sink failed for %s", kind, exc_info=True)
        return event


_DEFAULT_BUS: EventBus | None = None
_DEFAULT_BUS_LOCK = threading.Lock()
_CURRENT_BUS: contextvars.ContextVar[EventBus | None] = contextvars.ContextVar(
    "circle_current_event_bus", default=None)


def get_default_bus() -> EventBus:
    current = _CURRENT_BUS.get()
    if current is not None:
        return current
    global _DEFAULT_BUS
    if _DEFAULT_BUS is None:
        with _DEFAULT_BUS_LOCK:
            if _DEFAULT_BUS is None:
                _DEFAULT_BUS = EventBus()
    return _DEFAULT_BUS


def reset_default_bus(run_id: str | None = None) -> EventBus:
    global _DEFAULT_BUS
    with _DEFAULT_BUS_LOCK:
        _DEFAULT_BUS = EventBus(run_id=run_id)
        bus = _DEFAULT_BUS
    _CURRENT_BUS.set(bus)
    return bus


def current_bus() -> EventBus | None:
    """The bus of the run on this thread, if a UI bound one; never the global default."""
    return _CURRENT_BUS.get()


def bind_bus(bus: EventBus | None) -> contextvars.Token:
    return _CURRENT_BUS.set(bus)


def unbind_bus(token: contextvars.Token) -> None:
    _CURRENT_BUS.reset(token)
