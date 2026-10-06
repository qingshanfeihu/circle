"""What the header shows about the repository a folder is in, read from ``.git`` without
running git."""

from __future__ import annotations

from pathlib import Path


def current_branch(folder: str | Path) -> str:
    """The checked-out branch, the short commit id when no branch is checked out, or ""
    outside a repository. A worktree's ``.git`` file is followed to its own HEAD."""
    start = Path(folder).resolve()
    for directory in [start, *start.parents]:
        marker = directory / ".git"
        try:
            if marker.is_dir():
                head = marker / "HEAD"
            elif marker.is_file():
                pointer = marker.read_text(encoding="utf-8").strip()
                if not pointer.startswith("gitdir:"):
                    return ""
                gitdir = Path(pointer[len("gitdir:"):].strip())
                head = (gitdir if gitdir.is_absolute() else directory / gitdir) / "HEAD"
            else:
                continue
            text = head.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            return ""
        if text.startswith("ref: refs/heads/"):
            return text[len("ref: refs/heads/"):]
        return text[:7]
    return ""
