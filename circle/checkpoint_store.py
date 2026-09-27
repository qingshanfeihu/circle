"""LangGraph short-term (checkpointer) + long-term (store) factories.

Prefer framework primitives over DIY transcript wipes:
- SqliteSaver for durable thread history across /resume
- InMemoryStore for optional cross-thread long-term memory
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from langgraph.checkpoint.memory import MemorySaver


def make_checkpointer(home: Path | None = None) -> Any:
    """Durable Sqlite checkpointer under ``home/checkpoints.sqlite``.

    Durable mode fails explicitly if its dependencies or database are unusable.
    """
    if home is None:
        return MemorySaver()
    from langgraph.checkpoint.sqlite import SqliteSaver

    path = Path(home).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True)
    db = path / "checkpoints.sqlite"
    conn = sqlite3.connect(str(db), check_same_thread=False)
    saver = SqliteSaver(conn)
    saver.setup()
    return saver


def make_store() -> Any:
    """LangGraph long-term memory store (in-process)."""
    try:
        from langgraph.store.memory import InMemoryStore

        return InMemoryStore()
    except ImportError:
        return None


def copy_thread_if_possible(
    checkpointer: Any,
    source_thread_id: str,
    target_thread_id: str,
) -> bool:
    """Copy checkpoints between threads when the saver supports it."""
    fn = getattr(checkpointer, "copy_thread", None)
    if not callable(fn):
        return False
    try:
        fn(source_thread_id, target_thread_id)
        return True
    except Exception:  # noqa: BLE001
        return False
