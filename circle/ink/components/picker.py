"""A searchable list above the frame, for choosing a model, a session, a message.

Type to narrow it (every word must appear), ``↑`` ``↓`` move (wrapping), ``pageup``
``pagedown`` jump, ``enter`` picks, ``esc`` clears the search or closes. A picker can bind
extra keys (``ctrl+s`` save, ``ctrl+r`` rename, ``ctrl+d`` delete, ``tab`` scope …) and can
ask for a line of text in place of the search (a new name, a key shown as dots) or for a
confirmation. With ``free_text``, ``enter`` on a search nothing matches hands over what was
typed (a model id the endpoint does not list).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from ..string_width import string_width
from ..theme import palette, sgr_join
from .dialog_card import PopupItem, popup_rows, wrap


@dataclass
class PickerItem:
    key: str
    label: str
    meta: str = ""       # right-hand detail, dim
    search: str = ""     # more text the search looks in
    current: bool = False


class Picker:
    def __init__(
        self,
        *,
        title: str,
        items: list[PickerItem],
        on_pick: Callable[[PickerItem], None],
        render: Callable[[], None],
        on_close: Callable[[], None] | None = None,
        hint: str = "",
        keys: dict[str, Callable[[PickerItem | None], None]] | None = None,
        rows: int = 10,
        focus_key: str | None = None,
        empty: str = "Nothing to show",
        free_text: Callable[[str], None] | None = None,
    ) -> None:
        self.title = title
        self.hint = hint
        self.empty = empty
        self._items = list(items)
        self._on_pick = on_pick
        self._on_close = on_close or (lambda: None)
        self._render = render
        self._keys = dict(keys or {})
        self._rows = max(3, rows)
        self._free_text = free_text
        self.query = ""
        self._focus = 0
        self._top = 0
        # A line of text asked for in place of the search: (label, text, done)
        self._asking: tuple[str, str, Callable[[str], None]] | None = None
        self._masked = False
        self._ask_keys = ""
        self._confirming: tuple[str, Callable[[], None]] | None = None
        if focus_key is not None:
            self.focus_on(focus_key)

    # ── content ─────────────────────────────────────────────────────────────

    def matches(self) -> list[PickerItem]:
        words = self.query.lower().split()
        if not words:
            return list(self._items)
        return [item for item in self._items
                if all(w in f"{item.label} {item.meta} {item.search}".lower() for w in words)]

    def search(self, text: str) -> None:
        """Start with this search typed in, the first match focused."""
        self.query = text
        self._focus = self._top = 0
        self._clamp()

    def set_items(self, items: list[PickerItem]) -> None:
        """Replace the rows and keep the focus on the same item when it is still there."""
        current = self.focused()
        self._items = list(items)
        if current is not None:
            self.focus_on(current.key)
        self._clamp()

    def focus_on(self, key: str) -> None:
        for i, item in enumerate(self.matches()):
            if item.key == key:
                self._focus = i
                self._clamp()
                return

    def focused(self) -> PickerItem | None:
        shown = self.matches()
        return shown[self._focus] if 0 <= self._focus < len(shown) else None

    def _clamp(self) -> None:
        n = len(self.matches())
        self._focus = min(max(0, self._focus), max(0, n - 1))
        if self._focus < self._top:
            self._top = self._focus
        elif self._focus >= self._top + self._rows:
            self._top = self._focus - self._rows + 1
        self._top = min(self._top, max(0, n - self._rows))

    # ── asking for text or a confirmation ───────────────────────────────────

    def ask(self, label: str, text: str, done: Callable[[str], None], *,
            mask: bool = False, keys: str = "enter saves · esc cancels") -> None:
        """``mask`` shows what is typed or pasted as dots, as setup shows a key."""
        self._asking = (label, text, done)
        self._masked = mask
        self._ask_keys = keys
        self._render()

    @property
    def asking(self) -> bool:
        return self._asking is not None

    def confirm(self, question: str, done: Callable[[], None]) -> None:
        self._confirming = (question, done)
        self._render()

    # ── drawing ─────────────────────────────────────────────────────────────

    def render_lines(self, width: int) -> list[str]:
        pal = palette()
        shown = self.matches()
        window = shown[self._top:self._top + self._rows]
        info: list[str] = []
        if self._asking is not None:
            label, text, _done = self._asking
            typed = "•" * len(text) if self._masked else text
            info.append(f"{label}: {typed}▏  {self._ask_keys}")
        elif self._confirming is not None:
            info.append(f"{self._confirming[0]}  enter confirms · esc cancels")
        else:
            info.append(f"search: {self.query}▏" if self.query else "type to search")
            if self.hint:
                info.append(self.hint)
        items = [PopupItem(item.label, f"  {item.meta}" if item.meta else "", item.current)
                 for item in window]
        rows = popup_rows(self.title, items, self._focus - self._top, width, info=info)
        if not shown:
            rows.append(_dim_row(f"   {self.empty}", width, pal))
        elif len(shown) > self._rows:
            rows.append(_dim_row(f"   ({self._focus + 1}/{len(shown)})", width, pal))
        return rows

    # ── keys ────────────────────────────────────────────────────────────────

    def handle_key(self, key: str, char: str) -> bool:
        """Every key goes to the picker while it is open; returns False only for keys the
        session keeps (ctrl+c to stop a turn, ctrl+d to quit)."""
        if self._confirming is not None:
            question, done = self._confirming
            if key in ("enter", "return"):
                self._confirming = None
                done()
            elif key in ("escape", "ctrl+c"):
                self._confirming = None
            self._render()
            return True
        if self._asking is not None:
            return self._handle_asking(key, char)
        if key in self._keys:
            self._keys[key](self.focused())
            self._render()
            return True
        shown = self.matches()
        if key in ("up", "ctrl+p") and shown:
            self._focus = (self._focus - 1) % len(shown)
        elif key in ("down", "ctrl+n") and shown:
            self._focus = (self._focus + 1) % len(shown)
        elif key == "pageup":
            self._focus = max(0, self._focus - self._rows)
        elif key == "pagedown":
            self._focus = min(len(shown) - 1, self._focus + self._rows)
        elif key in ("enter", "return"):
            item = self.focused()
            if item is not None:
                self._on_pick(item)
            elif self._free_text is not None and self.query.strip():
                self._free_text(self.query.strip())
            return True
        elif key == "escape":
            if self.query:
                self.query = ""
            else:
                self._on_close()
                return True
        elif key == "backspace":
            self.query = self.query[:-1]
            self._focus = 0
        elif key == "ctrl+u":
            self.query = ""
            self._focus = 0
        elif key in ("ctrl+c", "ctrl+d"):
            return False
        elif char and len(char) == 1 and char.isprintable():
            self.query += char
            self._focus = 0
        else:
            return True  # nothing else leaks to the input box while the picker is open
        self._clamp()
        self._render()
        return True

    def handle_paste(self, text: str) -> None:
        """A paste goes where typing goes: the asked line, or the search. One line only."""
        line = "".join(ch for ch in text.replace("\r", "").replace("\n", "") if ch.isprintable())
        if self._confirming is not None or not line:
            return
        if self._asking is not None:
            label, asked, done = self._asking
            self._asking = (label, asked + line, done)
        else:
            self.query += line
            self._focus = 0
            self._clamp()
        self._render()

    def _handle_asking(self, key: str, char: str) -> bool:
        assert self._asking is not None
        label, text, done = self._asking
        if key in ("enter", "return"):
            self._asking = None
            done(text)
        elif key in ("escape", "ctrl+c"):
            self._asking = None
        elif key == "backspace":
            self._asking = (label, text[:-1], done)
        elif key == "ctrl+u":
            self._asking = (label, "", done)
        elif char and len(char) == 1 and char.isprintable():
            self._asking = (label, text + char, done)
        self._render()
        return True


def _dim_row(text: str, width: int, pal) -> str:
    text = wrap(text, width)[0]
    pad = " " * max(0, width - string_width(text))
    return f"{sgr_join(pal.panel_bg, pal.dim)}{text}{pad}{pal.reset}"


__all__ = ["Picker", "PickerItem"]
