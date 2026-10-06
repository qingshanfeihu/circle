"""``@path`` in a message: tab completes it, and sending attaches the file.

A mention is a word that starts with ``@``. When it names a text file inside the workspace
that is small enough, the file's text is added after the message for the model, so it
does not have to read it first. The screen keeps the message as typed.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

MAX_ATTACH_BYTES = 64 * 1024
_MENTION_RE = re.compile(r"(?<!\S)@([^\s@]+)")
_SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache",
                        ".pytest_cache", ".tox", "dist", "build", ".next", ".cache"})
_SEARCH_LIMIT = 5000


def _inside(root: Path, rel: str) -> Path | None:
    try:
        path = (root / rel).resolve()
        return path if path.is_relative_to(root.resolve()) else None
    except (OSError, ValueError, RuntimeError):
        return None


def attach_files(text: str, root: Path) -> str:
    """``text`` with the mentioned files' contents added after it, each once."""
    blocks: list[str] = []
    seen: set[Path] = set()
    for match in _MENTION_RE.finditer(text):
        rel = match.group(1).rstrip(".,;:!?)")
        path = _inside(root, rel)
        if path is None or path in seen or not path.is_file():
            continue
        try:
            if path.stat().st_size > MAX_ATTACH_BYTES:
                continue
            body = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        seen.add(path)
        blocks.append(file_block(path.relative_to(root.resolve()).as_posix(), body))
    return text if not blocks else text + "\n\n" + "\n\n".join(blocks)


def file_block(shown: str, body: str) -> str:
    """A file's text as it is added to a message for the model."""
    return f'<file path="{shown}">\n{body.rstrip()}\n</file>'


def _walk(root: Path):
    count = 0
    for folder, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in _SKIP_DIRS and not d.startswith("."))
        for name in sorted(files):
            count += 1
            if count > _SEARCH_LIMIT:
                return
            yield Path(folder, name)


def complete(partial: str, root: Path, *, limit: int = 20) -> list[str]:
    """Paths (relative to ``root``, folders ending in ``/``) that ``@partial`` could mean:
    entries of the folder it names that start with its last part, or else files anywhere
    in the workspace whose name contains it."""
    root = root.resolve()
    folder_part, _, prefix = partial.rpartition("/")
    folder = _inside(root, folder_part or ".")
    found: list[str] = []
    if folder is not None and folder.is_dir():
        try:
            entries = sorted(folder.iterdir(), key=lambda p: p.name)
        except OSError:
            entries = []
        for entry in entries:
            if entry.name in _SKIP_DIRS or (entry.name.startswith(".") and not prefix.startswith(".")):
                continue
            if entry.name.startswith(prefix):
                rel = entry.relative_to(root).as_posix()
                found.append(rel + "/" if entry.is_dir() else rel)
    if found or "/" in partial or not partial:
        return found[:limit]
    needle = partial.lower()
    hits = [p.relative_to(root).as_posix() for p in _walk(root) if needle in p.name.lower()]
    return sorted(hits, key=lambda rel: (len(rel), rel))[:limit]
