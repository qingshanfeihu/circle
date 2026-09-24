"""Plan panel above the composer: the ``write_todos`` list as it stands
(InfoTest ``plan_panel.PlanPanel``).

Shows each item's real status. At the end of a turn the items are left as the model
left them — an unfinished item is not drawn as done. Long lists show a window of
``MAX_ITEMS`` around the first unfinished item and say how many are above and below.
"""

from __future__ import annotations

from ..dom import NodeType, create_element, create_text
from ..string_width import string_width
from ..theme import GLYPH_AGENT, palette

MAX_ITEMS = 10


def _status_glyph(status: str) -> str:
    pal = palette()
    if status == "completed":
        return f"{pal.green}●{pal.reset}"
    if status == "in_progress":
        return f"{pal.yellow}◉{pal.reset}"
    return f"{pal.dim}○{pal.reset}"


def _fit(text: str, width: int) -> str:
    text = " ".join(str(text or "").split())
    if string_width(text) <= width:
        return text
    while text and string_width(text) > width - 1:
        text = text[:-1]
    return text + "…"


def plan_window(todos: list[dict], max_items: int = MAX_ITEMS) -> tuple[int, int]:
    if len(todos) <= max_items:
        return 0, len(todos)
    first_open = next((i for i, t in enumerate(todos) if t.get("status") != "completed"),
                      len(todos) - 1)
    start = max(0, min(first_open - 2, len(todos) - max_items))
    return start, start + max_items


def plan_lines(todos: list[dict], *, width: int = 100) -> list[str]:
    if not todos:
        return []
    pal = palette()
    done = sum(1 for t in todos if t.get("status") == "completed")
    lines = [f" {pal.em}{GLYPH_AGENT} Plan{pal.reset} {pal.dim}· {done}/{len(todos)} 完成{pal.reset}"]
    start, end = plan_window(todos)
    if start:
        lines.append(f"   {pal.faint}… 上面还有 {start} 项{pal.reset}")
    room = max(10, int(width or 0) - 6)
    for todo in todos[start:end]:
        status = str(todo.get("status") or "pending")
        content = _fit(str(todo.get("content") or ""), room)
        color = pal.dim if status == "completed" else pal.text
        lines.append(f"   {_status_glyph(status)} {color}{content}{pal.reset}")
    if end < len(todos):
        lines.append(f"   {pal.faint}… 下面还有 {len(todos) - end} 项{pal.reset}")
    return lines


class PlanPanel:

    def __init__(self) -> None:
        self._node = create_element(NodeType.BOX)
        self._node.style.height = 0
        self._text = create_text("")
        self._node.append_child(self._text)
        self._todos: list[dict] = []
        self._width = 100

    @property
    def node(self):
        return self._node

    @property
    def is_visible(self) -> bool:
        return bool(self._todos)

    @property
    def todos(self) -> list[dict]:
        return list(self._todos)

    def update(self, todos: list[dict] | None, *, width: int | None = None) -> None:
        self._todos = [dict(t) for t in (todos or []) if isinstance(t, dict)]
        if width:
            self._width = int(width)
        lines = plan_lines(self._todos, width=self._width)
        if not lines:
            self._node.style.height = 0
            self._text.set_value("")
            return
        # 上下各留一行空白，与转录、对话框分开
        self._text.set_value("\n".join(["", *lines, ""]))
        self._node.style.height = len(lines) + 2

    def clear(self) -> None:
        self.update([])


__all__ = ["MAX_ITEMS", "PlanPanel", "plan_lines", "plan_window"]
