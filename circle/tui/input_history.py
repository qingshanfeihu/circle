"""Persistent prompt history — port of InfoTest ``InputHistory``.

Stored under ``~/.circle/history`` (override with ``CIRCLE_HISTORY_PATH``).
Supports ↑/↓ navigation and ctrl+r reverse-i-search.
"""

from __future__ import annotations

import os
from pathlib import Path


_HISTORY_PATH = Path(
    os.environ.get(
        "CIRCLE_HISTORY_PATH",
        str(Path.home() / ".circle" / "history"),
    )
)
_MAX_HISTORY = 1000


class InputHistory:
    def __init__(
        self, *, path: Path | None = None, max_items: int = _MAX_HISTORY
    ) -> None:
        self._path = path if path is not None else _HISTORY_PATH
        self._max = max_items
        self._items: list[str] = self._load()
        self._cursor: int | None = None
        self._draft: str = ""
        self._search_mode = False
        self._search_query: str = ""
        self._search_matches: list[int] = []
        self._search_idx: int = -1

    def _load(self) -> list[str]:
        try:
            if not self._path.exists():
                return []
            lines = self._path.read_text(encoding="utf-8").splitlines()
            return [ln.rstrip("\n") for ln in lines if ln.strip()][-self._max :]
        except Exception:
            return []

    def _persist(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(
                "\n".join(self._items[-self._max :]) + "\n",
                encoding="utf-8",
            )
        except Exception:
            pass

    def add(self, text: str) -> None:
        text = (text or "").rstrip()
        if not text:
            return
        if self._items and self._items[-1] == text:
            return
        self._items.append(text)
        if len(self._items) > self._max:
            self._items = self._items[-self._max :]
        self._persist()
        self._cursor = None
        self._draft = ""

    def up(self, current_input: str) -> str | None:
        if not self._items:
            return None
        if self._cursor is None:
            self._draft = current_input
            self._cursor = len(self._items) - 1
        elif self._cursor > 0:
            self._cursor -= 1
        return self._items[self._cursor]

    def down(self, current_input: str) -> str | None:
        if self._cursor is None:
            return None
        if self._cursor < len(self._items) - 1:
            self._cursor += 1
            return self._items[self._cursor]
        self._cursor = None
        return self._draft

    def reset_navigation(self) -> None:
        self._cursor = None
        self._draft = ""

    def start_search(self, current_input: str) -> str | None:
        self._search_mode = True
        self._search_query = current_input
        self._search_idx = -1
        self._draft = current_input
        return self.search_next()

    def update_search_query(self, query: str) -> str | None:
        if not self._search_mode:
            return None
        self._search_query = query
        self._search_idx = -1
        return self.search_next()

    def search_next(self) -> str | None:
        if not self._search_mode:
            return None
        q = (self._search_query or "").lower()
        if not q:
            return None
        self._search_matches = [
            i for i, item in enumerate(reversed(self._items)) if q in item.lower()
        ]
        if not self._search_matches:
            return None
        self._search_idx = (self._search_idx + 1) % len(self._search_matches)
        reverse_idx = self._search_matches[self._search_idx]
        return self._items[len(self._items) - 1 - reverse_idx]

    def exit_search(self, *, restore: bool = True) -> str:
        self._search_mode = False
        self._search_query = ""
        self._search_matches = []
        self._search_idx = -1
        if restore:
            return self._draft
        return ""

    @property
    def in_search_mode(self) -> bool:
        return self._search_mode

    @property
    def search_query(self) -> str:
        return self._search_query

    def __len__(self) -> int:
        return len(self._items)

    @property
    def items(self) -> list[str]:
        return list(self._items)
