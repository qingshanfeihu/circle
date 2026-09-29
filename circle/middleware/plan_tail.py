"""Remind the main agent of its current write_todos plan at model-call time."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from langchain.agents.middleware.types import (
    AgentMiddleware,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import HumanMessage
from langgraph.config import get_config

_OPEN = frozenset({"pending", "in_progress"})
_MARKERS = {"completed": "[x]", "in_progress": "[>]", "pending": "[ ]"}
_MAX_ITEMS = 15
_MAX_CONTENT_CHARS = 96
_INTRO = ("This is your current write_todos plan; update each step's status with "
          "write_todos when you finish it.")


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
    """Change only the current request; keep checkpointed messages and system stable."""

    @staticmethod
    def _with_plan(request: ModelRequest) -> ModelRequest:
        try:
            configurable = get_config().get("configurable", {})
        except RuntimeError:
            configurable = {}
        if configurable.get("ls_agent_type") == "subagent":
            return request
        state = request.state if isinstance(request.state, Mapping) else {}
        reminder = plan_tail(state.get("todos"))
        if not reminder:
            return request
        messages = list(request.messages)
        if messages and isinstance(messages[-1], HumanMessage):
            last = messages[-1]
            if isinstance(last.content, str):
                content: str | list = f"{last.content}\n\n{reminder}"
            else:
                content = [*last.content, {"type": "text", "text": f"\n\n{reminder}"}]
            messages[-1] = last.model_copy(update={"content": content})
        else:
            # Anthropic merges this with any preceding ToolMessage into one
            # user turn; OpenAI keeps the normal tool -> user sequence.
            messages.append(HumanMessage(content=reminder))
        return request.override(messages=messages)

    def wrap_model_call(self, request: ModelRequest,
                        handler: Callable[[ModelRequest], ModelResponse]) -> ModelResponse:
        return handler(self._with_plan(request))

    async def awrap_model_call(self, request: ModelRequest,
                               handler: Callable[[ModelRequest], Awaitable[ModelResponse]]
                               ) -> ModelResponse:
        return await handler(self._with_plan(request))
