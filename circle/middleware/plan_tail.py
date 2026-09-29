"""Persist occasional plan reminders after tool results in the main agent thread."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.config import get_config

_OPEN = frozenset({"pending", "in_progress"})
_MARKERS = {"completed": "[x]", "in_progress": "[>]", "pending": "[ ]"}
_MAX_ITEMS = 15
_MAX_CONTENT_CHARS = 96
_MIN_MODEL_CALLS = 10
REMINDER_MARKER = "circle_plan_reminder"
_INTRO = (
    "This is a Circle automatically added reminder, not a user message. "
    "This is your current write_todos plan; privately update each step's status "
    "with write_todos when you finish it. Do not reply to this reminder."
)


def is_plan_reminder(message: Any) -> bool:
    """Identify the synthetic message without relying on its localized text."""
    return isinstance(message, HumanMessage) and (
        getattr(message, "additional_kwargs", {}).get(REMINDER_MARKER) is True
    )


def _is_real_user(message: Any) -> bool:
    if not isinstance(message, HumanMessage):
        return False
    kwargs = getattr(message, "additional_kwargs", {})
    return not (is_plan_reminder(message) or kwargs.get("circle_internal")
                or kwargs.get("lc_source") == "summarization")


def _visible_messages(state: Mapping[str, Any]) -> list[Any]:
    """Apply Deep Agents' persisted summary boundary for cadence decisions."""
    messages = list(state.get("messages") or [])
    event = state.get("_summarization_event")
    if not isinstance(event, Mapping):
        return messages
    cutoff = event.get("cutoff_index")
    summary = event.get("summary_message")
    if not isinstance(cutoff, int) or cutoff < 0 or summary is None:
        return messages
    return [summary, *messages[cutoff:]]


def plan_tail(todos: Any) -> str:
    """Bound the reminder while keeping the next unfinished step in view."""
    if not isinstance(todos, list):
        return ""
    items = []
    for item in todos:
        if not isinstance(item, Mapping):
            continue
        status = item.get("status")
        content = " ".join(str(item.get("content") or "").split())
        if status in _MARKERS and content:
            items.append((status, content))
    if not any(status in _OPEN for status, _content in items):
        return ""
    first_open = next(index for index, (status, _content) in enumerate(items) if status in _OPEN)
    start = max(0, min(first_open - 2, len(items) - _MAX_ITEMS)) if len(items) > _MAX_ITEMS else 0
    selected = items[start:start + _MAX_ITEMS]
    lines = [_INTRO]
    if start:
        lines.append(f"… {start} earlier steps")
    for status, content in selected:
        if len(content) > _MAX_CONTENT_CHARS:
            content = content[:_MAX_CONTENT_CHARS - 1] + "…"
        lines.append(f"{_MARKERS[status]} {content}")
    remaining = len(items) - start - len(selected)
    if remaining:
        lines.append(f"… {remaining} later steps")
    return "\n".join(lines)


class PlanTailMiddleware(AgentMiddleware):
    """Append a checkpointed reminder after ten model replies without a plan update."""

    @staticmethod
    def _reminder(state: Mapping[str, Any]) -> HumanMessage | None:
        try:
            configurable = get_config().get("configurable", {})
        except RuntimeError:
            configurable = {}
        if configurable.get("ls_agent_type") == "subagent":
            return None
        reminder = plan_tail(state.get("todos"))
        if not reminder:
            return None
        raw = list(state.get("messages") or [])
        if not raw or not isinstance(raw[-1], ToolMessage):
            return None
        last_user = max((i for i, msg in enumerate(raw) if _is_real_user(msg)), default=-1)
        completed_calls = {
            msg.tool_call_id for msg in raw[last_user + 1:]
            if isinstance(msg, ToolMessage) and msg.status != "error"
        }
        last_write = max((i for i, msg in enumerate(raw)
                          if i > last_user and isinstance(msg, AIMessage)
                          and any(call.get("name") == "write_todos"
                                  and call.get("id") in completed_calls
                                  for call in msg.tool_calls)), default=-1)
        if last_write < 0:
            return None

        visible = _visible_messages(state)
        if not visible or not isinstance(visible[-1], ToolMessage):
            return None
        write_id = raw[last_write].id
        visible_write = next((i for i, msg in enumerate(visible)
                              if msg is raw[last_write] or (write_id and msg.id == write_id)), -1)
        last_reminder = max((i for i, msg in enumerate(visible) if is_plan_reminder(msg)),
                            default=-1)
        if visible_write < 0 and last_reminder < 0:
            # Compaction hid this turn's write_todos call and its previous reminder.
            due = True
        else:
            anchors = [i for i in (visible_write, last_reminder) if i >= 0]
            due = all(sum(isinstance(msg, AIMessage) for msg in visible[i + 1:])
                      >= _MIN_MODEL_CALLS for i in anchors)
        if not due:
            return None
        return HumanMessage(content=reminder, additional_kwargs={REMINDER_MARKER: True})

    def before_model(self, state: Mapping[str, Any], runtime: Any) -> dict[str, Any] | None:
        reminder = self._reminder(state)
        return {"messages": [reminder]} if reminder is not None else None

    async def abefore_model(self, state: Mapping[str, Any], runtime: Any) -> dict[str, Any] | None:
        return self.before_model(state, runtime)
