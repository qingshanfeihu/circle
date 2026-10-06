
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


# Word-wise keys, as in readline and pi. macOS terminals send option+arrow as alt+b/f.
_WORD_LEFT = frozenset({"alt+left", "ctrl+left", "alt+b"})
_WORD_RIGHT = frozenset({"alt+right", "ctrl+right", "alt+f"})
_DELETE_WORD_BACK = frozenset({"ctrl+w", "alt+backspace"})
_DELETE_WORD_FORWARD = frozenset({"alt+d", "alt+delete"})
_WORD_GAP = frozenset(" \t↵")


def _format_pasted_text_ref(paste_id: int, num_lines: int) -> str:
    if num_lines == 0:
        return f"[Pasted text #{paste_id}]"
    return f"[Pasted text #{paste_id} +{num_lines} lines]"


def _count_newlines(text: str) -> int:
    return len(re.findall(r"\r\n|\r|\n", text))


def visual_lines(value: str, width: int) -> list[tuple[int, int]]:
    """The rows a draft takes in a box ``width`` columns wide, as ``(start, end)`` indexes
    into ``value``: a ``↵`` ends a row (and is not shown), a long line wraps after the last
    space that fits, or anywhere in a word longer than the row. A row that ends with ``↵``
    stops before it."""
    from ..string_width import string_width

    width = max(1, width)
    rows: list[tuple[int, int]] = []
    start, used, space = 0, 0, -1
    for i, ch in enumerate(value):
        if ch == "↵":
            rows.append((start, i))
            start, used, space = i + 1, 0, -1
            continue
        w = string_width(ch)
        if used + w > width and i > start:
            if ch == " ":
                # the space where the row breaks is the break: it starts no row
                rows.append((start, i))
                start, used, space = i + 1, 0, -1
                continue
            cut = space + 1 if space >= start else i
            rows.append((start, cut))
            start, space = cut, -1
            used = string_width(value[start:i])
        if ch == " ":
            space = i
        used += w
    rows.append((start, len(value)))
    return rows


def cursor_row(rows: list[tuple[int, int]], cursor: int) -> int:
    """The row the cursor is on. At a wrap the cursor shows at the start of the next row;
    just before a ``↵`` it shows at the end of its own."""
    for index, (start, end) in enumerate(rows):
        following = rows[index + 1][0] if index + 1 < len(rows) else None
        if start <= cursor <= end and (following is None or cursor < following
                                       or following != end):
            return index
    return len(rows) - 1


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
        self._submitted_pastes: dict[int, str] = {}
        self._killed = ""
        # A secret being typed: the box shows one dot per character, never the text
        self._masked = False
        self._next_paste_id: int = 1
        self._node = create_element(NodeType.BOX)
        self._node.style.height = 1
        # The box grows with the draft up to this many rows, then scrolls (as pi's editor)
        self.max_rows = 5
        self._width = 0  # columns for text, set by the frame each repaint
        self._top_row = 0
        self.rows_shown = 1
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

    @property
    def masked(self) -> bool:
        return self._masked

    @masked.setter
    def masked(self, on: bool) -> None:
        if self._masked != bool(on):
            self._masked = bool(on)
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
            if self._cursor_pos > 0 and self._value[self._cursor_pos - 1] == "\\":
                # \ then enter is a line break, for terminals where shift+enter is enter
                self._value = self._value[:self._cursor_pos - 1] + self._value[self._cursor_pos:]
                self._cursor_pos -= 1
                self.insert("↵")
                return True
            if self._on_submit and self._value:
                self._on_submit(self.take())
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
        if key in _WORD_LEFT:
            self._cursor_pos = self._word_start(self._cursor_pos)
            self._refresh()
            return True
        if key in _WORD_RIGHT:
            self._cursor_pos = self._word_end(self._cursor_pos)
            self._refresh()
            return True
        if key in _DELETE_WORD_BACK:
            self._cut(self._word_start(self._cursor_pos), self._cursor_pos)
            return True
        if key in _DELETE_WORD_FORWARD:
            self._cut(self._cursor_pos, self._word_end(self._cursor_pos))
            return True
        if key == "ctrl+k":
            self._cut(self._cursor_pos, len(self._value))
            return True
        if key == "ctrl+y":
            if self._killed:
                self.insert(self._killed)
            return True
        
        if char and len(char) == 1 and char.isprintable():
            self.insert(char)
            return True
        return False

    def _word_start(self, pos: int) -> int:
        """Where the word before ``pos`` starts (spaces and ``↵`` separate words)."""
        while pos > 0 and self._value[pos - 1] in _WORD_GAP:
            pos -= 1
        while pos > 0 and self._value[pos - 1] not in _WORD_GAP:
            pos -= 1
        return pos

    def _word_end(self, pos: int) -> int:
        end = len(self._value)
        while pos < end and self._value[pos] in _WORD_GAP:
            pos += 1
        while pos < end and self._value[pos] not in _WORD_GAP:
            pos += 1
        return pos

    def _cut(self, start: int, end: int) -> None:
        """Delete ``start:end``; ``ctrl+y`` puts it back."""
        if start >= end:
            return
        self._killed = self._value[start:end]
        self._value = self._value[:start] + self._value[end:]
        self._cursor_pos = start
        if self._on_change:
            self._on_change(self._value)
        self._refresh()

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

    def take(self) -> str:
        """Empty the box for a send and return what was in it. The pastes it refers to
        stay available to ``model_text`` until the next send."""
        text = self._value
        self._submitted_pastes = dict(self._pasted_contents)
        self.clear()
        return text

    def submitted_pastes(self) -> dict[int, str]:
        """The pastes of the draft that was last sent."""
        return dict(self._submitted_pastes)

    def model_text(self, text: str) -> str:
        """A submitted draft in full, as the model should read it: ``↵`` back to line
        breaks and each ``[Pasted text #N …]`` replaced by what was pasted."""
        text = text.replace("↵", "\n")
        pastes = {**self._submitted_pastes, **self._pasted_contents}
        for m in reversed(list(_PASTE_REF_RE.finditer(text))):
            content = pastes.get(int(m.group(1)))
            if content is not None:
                text = text[: m.start()] + content + text[m.end():]
        return text

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

    def pasted_snapshot(self) -> dict[int, str]:
        """The long pastes the draft refers to (``[Pasted text #1 …]``), for parking a draft."""
        return dict(self._pasted_contents)

    def restore_draft(self, text: str, pasted: dict[int, str]) -> None:
        """Put a parked draft back together with the pastes its placeholders stand for."""
        self.set_value(text)
        self._pasted_contents = dict(pasted)
        self._next_paste_id = max(self._pasted_contents, default=0) + 1

    def clear_pasted_refs(self) -> None:
        self._pasted_contents.clear()
        
        

    def set_width(self, columns: int) -> None:
        """The box's inner width from the frame, before layout, so the rows are known."""
        if columns != self._width:
            self._width = columns
            self._refresh()

    def _avail(self) -> int:
        if self._width:
            return max(10, self._width - 3)
        rect = getattr(self._node, "rect", None)
        node_w = rect.width if (rect and getattr(rect, "width", 0)) else 80
        return max(10, node_w - 3)

    def move_vertical(self, step: int) -> bool:
        """↑ or ↓ inside a draft of several rows: the same column one row up or down.
        False on the first row going up or the last going down (history takes those)."""
        from ..string_width import string_width

        rows = visual_lines(self._value, self._avail())
        row = cursor_row(rows, self._cursor_pos)
        target = row + step
        if len(rows) < 2 or not 0 <= target < len(rows):
            return False
        start, _end = rows[row]
        column = string_width(self._value[start:self._cursor_pos])
        t_start, t_end = rows[target]
        pos, used = t_start, 0
        while pos < t_end and used + string_width(self._value[pos]) <= column:
            used += string_width(self._value[pos])
            pos += 1
        if (pos == t_end and pos > t_start and target + 1 < len(rows)
                and rows[target + 1][0] == t_end):
            pos -= 1  # the end of a wrapped row shows as the start of the next one
        self._cursor_pos = pos
        self._refresh()
        return True

    def _refresh(self) -> None:
        from ..string_width import string_width

        if not self._value and self._placeholder:
            self._text_node.set_value(f" › {self._placeholder}")
            self._set_rows(1)
            self._cursor_mgr.declare(self._node, x=3, y=0)
            return
        avail = self._avail()
        if self._masked:
            shown = "•" * len(self._value)
            disp, cur_col = _horizontal_window(shown, self._cursor_pos, avail)
            self._text_node.set_value(f" › {disp}")
            self._set_rows(1)
            self._cursor_mgr.declare(self._node, x=3 + cur_col, y=0)
            return
        rows = visual_lines(self._value, avail)
        row = cursor_row(rows, self._cursor_pos)
        visible = max(1, min(len(rows), self.max_rows))
        # Keep the cursor's row in view
        if row < self._top_row:
            self._top_row = row
        elif row >= self._top_row + visible:
            self._top_row = row - visible + 1
        self._top_row = max(0, min(self._top_row, len(rows) - visible))
        lines = []
        for index in range(self._top_row, self._top_row + visible):
            start, end = rows[index]
            # 标记列 1、文字列 3——和转录里的 › 同一列（框内再右移 1 是边框自己占的）
            lines.append((" › " if index == 0 else "   ") + self._value[start:end])
        self._text_node.set_value("\n".join(lines))
        self._set_rows(visible)
        start = rows[row][0]
        column = string_width(self._value[start:self._cursor_pos])
        self._cursor_mgr.declare(self._node, x=3 + column, y=row - self._top_row)

    def _set_rows(self, count: int) -> None:
        self.rows_shown = count
        self._node.style.height = count
