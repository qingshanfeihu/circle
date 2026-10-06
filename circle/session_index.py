"""The list of saved conversations, so they can be reopened after Circle restarts.

A conversation's messages are in ``checkpoints.sqlite`` under its thread id; this index
says which folder each thread belongs to, its title and when it was last used. It lives
in ``sessions.sqlite`` in the data folder, which several Circle processes may share.
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from circle.paths import circle_home, normalize_workspace

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    thread_id TEXT PRIMARY KEY,
    workspace TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created REAL NOT NULL,
    updated REAL NOT NULL
)
"""
_LABELS = """
CREATE TABLE IF NOT EXISTS labels (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (thread_id, message_id)
)
"""
_COLUMNS = "thread_id, workspace, title, model, created, updated, leaf"


@dataclass(frozen=True)
class SavedSession:
    thread_id: str
    workspace: str
    title: str
    model: str
    created: float
    updated: float
    # The checkpoint the conversation was taken back to with /tree ("" = its latest)
    leaf: str = ""


def _connect(home: Path | None) -> sqlite3.Connection:
    root = Path(home) if home is not None else circle_home()
    root.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(root / "sessions.sqlite"), timeout=5)
    conn.execute(_SCHEMA)
    conn.execute(_LABELS)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
    if "leaf" not in columns:  # files written before /tree could go back
        conn.execute("ALTER TABLE sessions ADD COLUMN leaf TEXT NOT NULL DEFAULT ''")
    return conn


def record(home: Path | None, thread_id: str, workspace: str | Path, *, title: str = "",
           model: str = "") -> None:
    """Note that ``thread_id`` was used just now. An empty title keeps the saved one."""
    now = time.time()
    folder = str(normalize_workspace(workspace))
    with closing(_connect(home)) as conn, conn:
        conn.execute(
            "INSERT INTO sessions (thread_id, workspace, title, model, created, updated) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET "
            "updated = excluded.updated, "
            "title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END, "
            "model = CASE WHEN excluded.model != '' THEN excluded.model ELSE model END",
            (thread_id, folder, title, model, now, now),
        )


def for_workspace(home: Path | None, workspace: str | Path, *, limit: int = 20
                  ) -> list[SavedSession]:
    """The folder's conversations, most recently used first."""
    folder = str(normalize_workspace(workspace))
    with closing(_connect(home)) as conn:
        rows = conn.execute(
            f"SELECT {_COLUMNS} FROM sessions "
            "WHERE workspace = ? ORDER BY updated DESC LIMIT ?", (folder, limit)).fetchall()
    return [SavedSession(*row) for row in rows]


def everywhere(home: Path | None, *, limit: int = 200) -> list[SavedSession]:
    """Every folder's conversations, most recently used first."""
    with closing(_connect(home)) as conn:
        rows = conn.execute(
            f"SELECT {_COLUMNS} FROM sessions ORDER BY updated DESC LIMIT ?", (limit,)).fetchall()
    return [SavedSession(*row) for row in rows]


def rename(home: Path | None, thread_id: str, title: str) -> None:
    """Give a conversation a title, without counting as using it."""
    with closing(_connect(home)) as conn, conn:
        conn.execute("UPDATE sessions SET title = ? WHERE thread_id = ?",
                     (" ".join(title.split())[:80], thread_id))


def forget(home: Path | None, thread_id: str) -> None:
    """Take a conversation off the list (its messages are deleted by the caller)."""
    with closing(_connect(home)) as conn, conn:
        conn.execute("DELETE FROM sessions WHERE thread_id = ?", (thread_id,))
        conn.execute("DELETE FROM labels WHERE thread_id = ?", (thread_id,))


def set_leaf(home: Path | None, thread_id: str, checkpoint: str | None) -> None:
    """Where /tree took the conversation back to; None when it is at its latest again."""
    with closing(_connect(home)) as conn, conn:
        conn.execute("UPDATE sessions SET leaf = ? WHERE thread_id = ?",
                     (checkpoint or "", thread_id))


def labels(home: Path | None, thread_id: str) -> dict[str, str]:
    with closing(_connect(home)) as conn:
        rows = conn.execute("SELECT message_id, label FROM labels WHERE thread_id = ?",
                            (thread_id,)).fetchall()
    return dict(rows)


def set_label(home: Path | None, thread_id: str, message_id: str, label: str) -> None:
    """Bookmark a message in the tree; an empty label removes the bookmark."""
    label = " ".join(label.split())[:40]
    with closing(_connect(home)) as conn, conn:
        if label:
            conn.execute("INSERT INTO labels (thread_id, message_id, label) VALUES (?, ?, ?) "
                         "ON CONFLICT(thread_id, message_id) DO UPDATE SET label = excluded.label",
                         (thread_id, message_id, label))
        else:
            conn.execute("DELETE FROM labels WHERE thread_id = ? AND message_id = ?",
                         (thread_id, message_id))


def latest(home: Path | None, workspace: str | Path) -> SavedSession | None:
    found = for_workspace(home, workspace, limit=1)
    return found[0] if found else None


def find(home: Path | None, key: str) -> SavedSession | None:
    """A conversation by its id, or by the end of its id when only one matches."""
    key = key.strip()
    if not key:
        return None
    with closing(_connect(home)) as conn:
        rows = conn.execute(
            f"SELECT {_COLUMNS} FROM sessions "
            "WHERE thread_id = ? OR thread_id LIKE ? ESCAPE '\\' ORDER BY updated DESC",
            (key, "%" + key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")),
        ).fetchall()
    exact = [row for row in rows if row[0] == key]
    if exact:
        return SavedSession(*exact[0])
    return SavedSession(*rows[0]) if len(rows) == 1 else None


def age(seconds: float) -> str:
    """``3m``, ``5h``, ``2d``: how long ago, for lists."""
    gone = max(0.0, time.time() - seconds)
    for unit, size in (("d", 86400), ("h", 3600), ("m", 60)):
        if gone >= size:
            return f"{int(gone // size)}{unit}"
    return "now"
