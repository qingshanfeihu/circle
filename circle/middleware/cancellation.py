"""Stop a cancelled TUI turn at every agent model and tool boundary."""

from __future__ import annotations

import threading
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langgraph.config import get_config
from langgraph.errors import GraphBubbleUp


class CircleCancelled(GraphBubbleUp):
    """Control-flow exit for a user-cancelled turn, not a tool failure."""


class CancellationToken:
    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    def check(self) -> None:
        if self._event.is_set():
            raise CircleCancelled("Circle turn cancelled")


def _token(config: Any) -> CancellationToken | None:
    configurable = config.get("configurable") if isinstance(config, dict) else None
    token = configurable.get("circle_cancel_token") if isinstance(configurable, dict) else None
    return token if isinstance(token, CancellationToken) else None


class CancellationMiddleware(AgentMiddleware):
    """Share the turn token through LangGraph's inherited runnable config."""

    @staticmethod
    def _check_model() -> None:
        try:
            token = _token(get_config())
        except RuntimeError:
            token = None
        if token is not None:
            token.check()

    @staticmethod
    def _check_tool(request: Any) -> None:
        token = _token(getattr(getattr(request, "runtime", None), "config", None))
        if token is not None:
            token.check()

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        self._check_model()
        return handler(request)

    async def awrap_model_call(self, request: Any,
                               handler: Callable[[Any], Awaitable[Any]]) -> Any:
        self._check_model()
        return await handler(request)

    def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        self._check_tool(request)
        return handler(request)

    async def awrap_tool_call(self, request: Any,
                              handler: Callable[[Any], Awaitable[Any]]) -> Any:
        self._check_tool(request)
        return await handler(request)
