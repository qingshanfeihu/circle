"""Messages typed while a turn runs reach the model before its next call.

Pressing enter during a turn puts the message in the turn's inbox. Before each model call
of the main agent the inbox is emptied into the conversation, so the model reads it after
the tool calls it was waiting for, without the turn being stopped. Whatever is still in
the inbox when the turn ends is sent as a new turn by the session.
"""

from __future__ import annotations

import threading
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import HumanMessage
from langgraph.config import get_config

from circle.events import current_bus

STEER_MARKER = "circle_steer"


class SteeringInbox:
    """The messages waiting for the running turn, as ``(text for the model, shown text)``."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: list[tuple[str, str]] = []
        self._delivered: list[str] = []

    def put(self, text: str, shown: str = "") -> int:
        with self._lock:
            self._pending.append((text, shown or text))
            return len(self._pending)

    def take(self) -> list[tuple[str, str]]:
        """Everything still waiting, which is then no longer waiting."""
        with self._lock:
            items, self._pending = self._pending, []
            return items

    def waiting(self) -> list[str]:
        """The shown text of each message still waiting, without taking them."""
        with self._lock:
            return [shown for _text, shown in self._pending]

    def mark_delivered(self, shown: str) -> None:
        with self._lock:
            self._delivered.append(shown)

    def take_delivered(self) -> list[str]:
        """The shown text of each message the model has read since the last call."""
        with self._lock:
            items, self._delivered = self._delivered, []
            return items

    def __len__(self) -> int:
        with self._lock:
            return len(self._pending)


def is_steering(message: Any) -> bool:
    return isinstance(message, HumanMessage) and bool(
        (message.additional_kwargs or {}).get(STEER_MARKER))


def _inbox() -> SteeringInbox | None:
    try:
        configurable = get_config().get("configurable") or {}
    except RuntimeError:
        return None
    inbox = configurable.get("circle_inbox")
    return inbox if isinstance(inbox, SteeringInbox) else None


class SteeringMiddleware(AgentMiddleware):
    """Before each model call of the main agent, add the waiting messages."""

    def before_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        inbox = _inbox()
        items = inbox.take() if inbox is not None else []
        if not items:
            return None
        bus = current_bus()
        messages = []
        for text, shown in items:
            extra: dict[str, Any] = {STEER_MARKER: True}
            if shown != text:
                extra["circle_shown"] = shown
            messages.append(HumanMessage(content=text, additional_kwargs=extra))
            inbox.mark_delivered(shown)
            if bus is not None:
                bus.emit("steer", payload={"text": shown})
        return {"messages": messages}

    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        return self.before_model(state, runtime)
