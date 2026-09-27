"""Effect declarations for tools; parameter shapes and MCP hints are not proof."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Effect = Literal["read", "write", "unknown"]
READ_TOOLS = frozenset({"ls", "read_file", "glob", "grep", "websearch", "webfetch", "lsp", "skill"})
CONTROL_TOOLS = frozenset({"write_todos", "question", "task", "compact_conversation"})
WRITE_TOOLS = frozenset({"write_file", "edit_file", "apply_patch", "delete", "execute"})


@dataclass(frozen=True)
class ToolCapability:
    name: str
    effect: Effect
    source: str


class ToolRegistry:
    def __init__(self):
        self._items: dict[str, ToolCapability] = {}
        for name in READ_TOOLS | CONTROL_TOOLS:
            self.register(name, "read", "builtin")
        for name in WRITE_TOOLS:
            self.register(name, "write", "builtin")

    def register(self, name: str, effect: Effect = "unknown", source: str = "external") -> None:
        self._items[name] = ToolCapability(name, effect, source)

    def get(self, name: str) -> ToolCapability:
        return self._items.get(name, ToolCapability(name, "unknown", "unregistered"))

    def gated(self) -> list[str]:
        return [item.name for item in self._items.values() if item.effect != "read"]

    def list(self) -> list[ToolCapability]:
        return list(self._items.values())
