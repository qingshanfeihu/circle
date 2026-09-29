"""The plan box above the composer: the ``write_todos`` list as it stands.

Contract (2026-09-29): the plan is its own zone, a closed block directly above the
composer frame — square corners (round ones belong to the one focus frame), the title
in the top edge with the plan's lamp, ``PLAN_ROWS`` whole rows by default, magenta
inside (the plan is the model's own document). The window follows the current item and
moves one item per wheel notch; the bottom-right corner says which items are showing
(``2–6 / 14``). While a card holds the frame the box is hidden, and it comes back when
the question is answered.

Each item is its real status: an unfinished item is not drawn as done at the end of a
turn. The lamp is the same one every row uses — green done, yellow running, unlit not
started.
"""

from __future__ import annotations

from ..dom import NodeType, create_element, create_text
from ..string_width import string_width
from ..theme import palette, sgr_join, status_light

PLAN_ROWS = 5


def _state(status: str) -> str:
    if status == "completed":
        return "ok"
    if status == "in_progress":
        return "running"
    return "none"


def _fit(text: str, width: int) -> str:
    text = " ".join(str(text or "").split())
    if string_width(text) <= width:
        return text
    while text and string_width(text) > width - 1:
        text = text[:-1]
    return text + "…"


def _current_index(todos: list[dict]) -> int:
    for i, todo in enumerate(todos):
        if todo.get("status") == "in_progress":
            return i
    for i, todo in enumerate(todos):
        if todo.get("status") != "completed":
            return i
    return max(0, len(todos) - 1)


def plan_window(todos: list[dict], max_items: int = PLAN_ROWS) -> tuple[int, int]:
    """The default window: the current item with two rows of context above it."""
    if len(todos) <= max_items:
        return 0, len(todos)
    start = max(0, min(_current_index(todos) - 2, len(todos) - max_items))
    return start, start + max_items


def plan_lines(todos: list[dict], *, width: int = 100, start: int | None = None) -> list[str]:
    """The box, every line exactly ``width`` columns."""
    if not todos:
        return []
    pal = palette()
    width = max(20, int(width or 0))
    n = len(todos)
    rows = min(PLAN_ROWS, n)
    if start is None:
        start = plan_window(todos)[0]
    start = max(0, min(int(start), n - rows))
    done = sum(1 for t in todos if t.get("status") == "completed")
    running = any(t.get("status") == "in_progress" for t in todos)
    F, R = pal.faint, pal.reset
    lamp = status_light("running" if running else ("ok" if done == n else "none"), reset=False)
    title = f"Plan {done}/{n}"
    if lamp == " ":
        head = f"{F}┌─ {R}{pal.text}{title} {R}"
        used = 3 + string_width(title) + 1
    else:
        code, glyph = lamp.rsplit("m", 1)
        head = f"{F}┌─ {R}{code}m{glyph}{R}{pal.text} {title} {R}"
        used = 5 + string_width(title) + 1
    top = head + f"{F}{'─' * max(0, width - used - 1)}┐{R}"
    inner = width - 2
    out = [top]
    for j in range(start, start + rows):
        todo = todos[j]
        status = str(todo.get("status") or "pending")
        text = _fit(str(todo.get("content") or ""), max(4, inner - 8))
        color = pal.dim if status == "completed" else (pal.em if status == "in_progress" else pal.text)
        light = status_light(_state(status), reset=False)
        if light == " ":
            light_txt = " "
        else:
            # 灯的前景色要和行底色合成一条 SGR：ink 每条行内 SGR 都按「基样式 + 这一条」重算，
            # 分两条写灯格就没有底色了。
            code, glyph = light.rsplit("m", 1)
            light_txt = f"{sgr_join(pal.think_bg, code + 'm')}{glyph}"
        plain_cell = f" {'●' if light != ' ' else ' '} {j + 1:>2}  {text}"
        pad = " " * max(0, inner - string_width(plain_cell))
        # 底色要进每一段的 SGR：ink 的行内 SGR 按「基样式 + 这一条」重算，后一条会顶掉前一条，
        # 只在行首写一次底色，就只有第一格有底（截图里那块左边的灰条）。
        bg = pal.think_bg
        out.append(f"{F}│{R}{bg} {light_txt}{sgr_join(bg, color)} {j + 1:>2}  {text}{bg}{pad}{R}{F}│{R}")
    rng = f" {start + 1}–{start + rows} / {n} " if n > rows else ""
    fill = max(0, width - 3 - string_width(rng))
    out.append(f"{F}└{'─' * fill}{R}{pal.dim}{rng}{R}{F}{'─' if rng else '─'}┘{R}" if rng
               else f"{F}└{'─' * (width - 2)}┘{R}")
    return out


class PlanPanel:

    def __init__(self) -> None:
        self._node = create_element(NodeType.BOX)
        self._node.style.height = 0
        self._text = create_text("")
        self._node.append_child(self._text)
        self._todos: list[dict] = []
        self._width = 100
        self._start = 0
        self._suppressed = False

    @property
    def node(self):
        return self._node

    @property
    def is_visible(self) -> bool:
        return bool(self._todos) and not self._suppressed

    @property
    def todos(self) -> list[dict]:
        return list(self._todos)

    @property
    def window(self) -> tuple[int, int]:
        return self._start, min(len(self._todos), self._start + PLAN_ROWS)

    def update(self, todos: list[dict] | None, *, width: int | None = None) -> None:
        incoming = [dict(t) for t in (todos or []) if isinstance(t, dict)]
        changed = incoming != self._todos
        self._todos = incoming
        if width is not None:
            self._width = int(width)
        if changed:
            self._start = plan_window(self._todos)[0]
        else:
            self._start = max(0, min(self._start, max(0, len(self._todos) - PLAN_ROWS)))
        self._render()

    def set_suppressed(self, suppressed: bool) -> None:
        """Hide the box while a card holds the frame; it returns when the card is answered."""
        suppressed = bool(suppressed)
        if suppressed != self._suppressed:
            self._suppressed = suppressed
            self._render()

    def tick(self) -> None:
        """Redraw for the lamp's blink while something is running (called each frame)."""
        if self.is_visible and any(t.get("status") == "in_progress" for t in self._todos):
            self._render()

    def scroll(self, delta: int) -> bool:
        """Move the window one item per wheel notch, stopping at either end."""
        if len(self._todos) <= PLAN_ROWS or not delta or self._suppressed:
            return False
        next_start = max(0, min(self._start + int(delta), len(self._todos) - PLAN_ROWS))
        if next_start == self._start:
            return False
        self._start = next_start
        self._render()
        return True

    def follow(self) -> None:
        """A new turn starts at the current item again."""
        start = plan_window(self._todos)[0]
        if start != self._start:
            self._start = start
            self._render()

    def _render(self) -> None:
        lines = [] if self._suppressed else plan_lines(self._todos, width=self._width, start=self._start)
        if not lines:
            self._node.style.height = 0
            self._text.set_value("")
            return
        self._text.set_value("\n".join(lines))
        self._node.style.height = len(lines)

    def clear(self) -> None:
        self.update([])


__all__ = ["PLAN_ROWS", "PlanPanel", "plan_lines", "plan_window"]
