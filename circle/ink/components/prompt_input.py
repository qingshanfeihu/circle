
from __future__ import annotations

import re
from typing import Callable

from ..cursor import CursorManager
from ..dom import DOMElement, DOMNode, NodeType, TextNode, create_element, create_text


_PASTE_THRESHOLD = 800
_PASTE_MAX_LINES = 2


_PASTE_REF_RE = re.compile(
    r"\[Pasted text #(\d+)(?: \+\d+ lines)?\]"
)


def _format_pasted_text_ref(paste_id: int, num_lines: int) -> str:
    if num_lines == 0:
        return f"[Pasted text #{paste_id}]"
    return f"[Pasted text #{paste_id} +{num_lines} lines]"


def _count_newlines(text: str) -> int:
    return len(re.findall(r"\r\n|\r|\n", text))


def _horizontal_window(value: str, cursor_pos: int, width: int) -> tuple[str, int]:
    from ..string_width import string_width
    if width <= 0 or string_width(value) <= width:
        return value, string_width(value[:cursor_pos])
    cursor_pos = max(0, min(cursor_pos, len(value)))
    start, acc = cursor_pos, 0
    while start > 0:
        cw = string_width(value[start - 1])
        if acc + cw > width - 1:
            break
        acc += cw
        start -= 1
    end = cursor_pos
    while end < len(value):
        cw = string_width(value[end])
        if acc + cw > width:
            break
        acc += cw
        end += 1
    return value[start:end], string_width(value[start:cursor_pos])


class PromptInput:

    def __init__(
        self,
        *,
        cursor_manager: CursorManager,
        on_submit: Callable[[str], None] | None = None,
        on_change: Callable[[str], None] | None = None,
        placeholder: str = "",
    ) -> None:
        self._cursor_mgr = cursor_manager
        self._on_submit = on_submit
        self._on_change = on_change
        self._placeholder = placeholder
        self._value = ""
        self._cursor_pos = 0
        
        
        
        self._pasted_contents: dict[int, str] = {}
        self._next_paste_id: int = 1
        self._node = create_element(NodeType.BOX)
        self._node.style.height = 1
        self._text_node = create_text("")
        self._node.append_child(self._text_node)
        self._refresh()

    @property
    def node(self) -> DOMElement:
        return self._node

    @property
    def value(self) -> str:
        return self._value

    @value.setter
    def value(self, v: str) -> None:
        self._value = v
        self._cursor_pos = min(self._cursor_pos, len(v))
        self._refresh()

    @property
    def cursor_pos(self) -> int:
        return self._cursor_pos

    @property
    def placeholder(self) -> str:
        return self._placeholder

    @placeholder.setter
    def placeholder(self, text: str) -> None:
        self._placeholder = text
        if not self._value:
            self._refresh()

    def set_value(self, text: str, *, cursor: int | None = None) -> None:
        self._value = text
        self._cursor_pos = len(text) if cursor is None else max(0, min(cursor, len(text)))
        self._refresh()

    def clear(self) -> None:
        self.set_value("")
        
        
        
        self._pasted_contents.clear()

    def insert(self, ch: str) -> None:
        self._value = self._value[:self._cursor_pos] + ch + self._value[self._cursor_pos:]
        self._cursor_pos += len(ch)
        if self._on_change:
            self._on_change(self._value)
        self._refresh()

    def handle_key(self, key: str, char: str = "") -> bool:
        if key in {"enter", "return"}:
            if self._on_submit and self._value:
                text = self._value
                self.clear()
                self._on_submit(text)
            return True
        if key == "backspace":
            if self._cursor_pos > 0:
                self._value = self._value[:self._cursor_pos - 1] + self._value[self._cursor_pos:]
                self._cursor_pos -= 1
                if self._on_change:
                    self._on_change(self._value)
                self._refresh()
            return True
        if key == "delete":
            if self._cursor_pos < len(self._value):
                self._value = self._value[:self._cursor_pos] + self._value[self._cursor_pos + 1:]
                if self._on_change:
                    self._on_change(self._value)
                self._refresh()
            return True
        if key == "left":
            if self._cursor_pos > 0:
                self._cursor_pos -= 1
                self._refresh()
            return True
        if key == "right":
            if self._cursor_pos < len(self._value):
                self._cursor_pos += 1
                self._refresh()
            return True
        if key in ("home", "ctrl+a"):
            self._cursor_pos = 0
            self._refresh()
            return True
        if key in ("end", "ctrl+e"):
            self._cursor_pos = len(self._value)
            self._refresh()
            return True
        if key == "ctrl+j" or key == "shift+enter":
            
            self.insert("↵")
            return True
        if key == "ctrl+u":
            
            self._value = ""
            self._cursor_pos = 0
            self._pasted_contents.clear()
            if self._on_change:
                self._on_change(self._value)
            self._refresh()
            return True
        
        if char and len(char) == 1 and char.isprintable():
            self.insert(char)
            return True
        return False

    def handle_paste(self, text: str) -> None:
        
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        num_lines = _count_newlines(normalized)
        is_long = (
            len(normalized) > _PASTE_THRESHOLD or num_lines > _PASTE_MAX_LINES
        )
        if is_long:
            paste_id = self._next_paste_id
            self._next_paste_id += 1
            self._pasted_contents[paste_id] = normalized
            self.insert(_format_pasted_text_ref(paste_id, num_lines))
            return
        
        clean = normalized.replace("\n", "↵")
        self.insert(clean)

    def pop_repeat_paste(self) -> str | None:
        return None

    def expand_pasted_refs(self, text: str) -> str:
        if not self._pasted_contents:
            return text
        matches = list(_PASTE_REF_RE.finditer(text))
        if not matches:
            return text
        out = text
        for m in reversed(matches):
            paste_id = int(m.group(1))
            content = self._pasted_contents.get(paste_id)
            if content is None:
                continue
            out = out[: m.start()] + content + out[m.end():]
        return out

    def consume_pasted_refs(self, text: str) -> str:
        if not self._pasted_contents:
            return text
        matches = list(_PASTE_REF_RE.finditer(text))
        if not matches:
            return text
        out = text
        seen: set[int] = set()
        for m in reversed(matches):
            paste_id = int(m.group(1))
            content = self._pasted_contents.get(paste_id)
            if content is None:
                continue
            seen.add(paste_id)
            out = out[: m.start()] + content + out[m.end():]
        for pid in seen:
            self._pasted_contents.pop(pid, None)
        return out

    def clear_pasted_refs(self) -> None:
        self._pasted_contents.clear()
        
        

    def _refresh(self) -> None:
        if not self._value and self._placeholder:
            self._text_node.set_value(f"> {self._placeholder}")
            self._cursor_mgr.declare(self._node, x=2, y=0)
            return
        rect = getattr(self._node, "rect", None)
        node_w = rect.width if (rect and getattr(rect, "width", 0)) else 80
        avail = max(10, node_w - 2)
        disp, cur_col = _horizontal_window(self._value, self._cursor_pos, avail)
        self._text_node.set_value(f"> {disp}")
        self._cursor_mgr.declare(self._node, x=2 + cur_col, y=0)
