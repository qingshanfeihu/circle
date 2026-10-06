"""``--tools``, ``--exclude-tools`` and ``--no-tools``: the main agent sees only the tools
chosen for this run, and a call to any other tool is answered with an error instead of
being run."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import ToolMessage


# Circle's own: /compact works by asking the model to call it
ALWAYS_ALLOWED = frozenset({"compact_conversation"})


def _name(tool: Any) -> str:
    if isinstance(tool, dict):
        return str(tool.get("name") or (tool.get("function") or {}).get("name") or "")
    return str(getattr(tool, "name", "") or "")


class ToolSelectionMiddleware(AgentMiddleware):
    def __init__(self, *, allowed: Iterable[str] | None, excluded: Iterable[str] = ()) -> None:
        super().__init__()
        self.allowed = frozenset(allowed) if allowed is not None else None
        self.excluded = frozenset(excluded)

    def permits(self, name: str) -> bool:
        if name in ALWAYS_ALLOWED:
            return True
        if name in self.excluded:
            return False
        return self.allowed is None or name in self.allowed

    def _narrowed(self, request: ModelRequest) -> ModelRequest:
        tools = [tool for tool in (request.tools or []) if self.permits(_name(tool))]
        return request.override(tools=tools)

    def wrap_model_call(self, request: ModelRequest,
                        handler: Callable[[ModelRequest], ModelResponse]) -> ModelResponse:
        return handler(self._narrowed(request))

    async def awrap_model_call(self, request: ModelRequest,
                               handler: Callable[[ModelRequest], Awaitable[ModelResponse]]
                               ) -> ModelResponse:
        return await handler(self._narrowed(request))

    def _refusal(self, request: Any) -> ToolMessage | None:
        call = getattr(request, "tool_call", None)
        call = call if isinstance(call, dict) else {}
        name = str(call.get("name") or "")
        if self.permits(name):
            return None
        return ToolMessage(content=f"The tool {name} is turned off for this run.", name=name,
                           tool_call_id=str(call.get("id") or ""), status="error")

    def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        refusal = self._refusal(request)
        return refusal if refusal is not None else handler(request)

    async def awrap_tool_call(self, request: Any,
                              handler: Callable[[Any], Awaitable[Any]]) -> Any:
        refusal = self._refusal(request)
        return refusal if refusal is not None else await handler(request)
