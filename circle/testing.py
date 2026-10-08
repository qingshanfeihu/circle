"""Shared scripted chat model for sandbox / HITL selftests."""

from __future__ import annotations

import threading
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field, PrivateAttr


class ScriptedModel(BaseChatModel):
    """Minimal chat model that supports bind_tools and scripted AIMessages."""

    responses: list[BaseMessage] = Field(default_factory=list)
    i: int = 0

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        if not self.responses:
            raise RuntimeError("ScriptedModel has no responses")
        msg = self.responses[min(self.i, len(self.responses) - 1)]
        self.i += 1
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def bind_tools(self, tools: Any, **kwargs: Any) -> ScriptedModel:
        return self

    @property
    def _llm_type(self) -> str:
        return "circle-scripted"


class RoutedModel(BaseChatModel):
    """A scripted model for agents that run at the same time (a background subagent next to
    the main agent): each call goes to the script whose marker is in the conversation's first
    human message, else to ``default``. Thread-safe; ``seen`` keeps each call's messages."""

    routes: dict[str, list[BaseMessage]] = Field(default_factory=dict)
    default: list[BaseMessage] = Field(default_factory=list)
    seen: list = Field(default_factory=list)
    _lock: Any = PrivateAttr(default_factory=threading.Lock)
    _next: dict = PrivateAttr(default_factory=dict)

    def _route(self, messages: list[BaseMessage]) -> str:
        first = next((m for m in messages if getattr(m, "type", "") == "human"), None)
        text = str(getattr(first, "content", "") or "")
        return next((marker for marker in self.routes if marker in text), "")

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None,
                  run_manager: Any = None, **kwargs: Any) -> ChatResult:
        with self._lock:
            route = self._route(messages)
            script = self.routes.get(route, self.default) if route else self.default
            if not script:
                raise RuntimeError(f"RoutedModel has no responses for {route or 'default'}")
            index = self._next.get(route, 0)
            self._next[route] = index + 1
            self.seen.append((route, list(messages)))
            msg = script[min(index, len(script) - 1)]
        return ChatResult(generations=[ChatGeneration(message=msg)])

    def bind_tools(self, tools: Any, **kwargs: Any) -> RoutedModel:
        return self

    @property
    def _llm_type(self) -> str:
        return "circle-routed"
