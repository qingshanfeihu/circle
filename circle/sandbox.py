"""Filesystem backend with host-absolute path passthrough.

Deep Agents' default ``virtual_mode=True`` treats every absolute path as
virtual under the workspace root, so a user-typed host path like
``/Users/…/OtherProject`` becomes ``{workspace}/Users/…`` and appears missing.

Circle keeps workspace-virtual paths for project-relative work
(``/src/foo``, ``note.txt``), but host-looking absolute paths stay real.
Writes still go through HITL (``interrupt_on``).
"""

from __future__ import annotations

import re
from pathlib import Path

from deepagents.backends import LocalShellBackend
from deepagents.backends.filesystem import _raise_if_symlink_loop

_HOST_TOP_LEVEL = frozenset(
    {
        "Users",
        "home",
        "private",
        "Volumes",
        "tmp",
        "var",
        "opt",
        "Library",
        "System",
        "Applications",
        "usr",
        "etc",
        "bin",
        "sbin",
        "dev",
        "mnt",
        "media",
        "root",
        "proc",
        "run",
        "boot",
    }
)


def is_host_absolute_path(path: str) -> bool:
    """True when ``path`` should resolve on the real host filesystem."""
    raw = (path or "").strip()
    if not raw:
        return False
    if raw.startswith("~"):
        return True
    if re.match(r"^[a-zA-Z]:[\\/]", raw):
        return True
    if not raw.startswith("/"):
        return False
    first = raw.lstrip("/").split("/", 1)[0]
    return first in _HOST_TOP_LEVEL


class CircleSandboxBackend(LocalShellBackend):
    """LocalShellBackend with host-absolute path passthrough."""

    def _resolve_path(self, key: str) -> Path:
        raw = (key or "").strip() or "/"
        if is_host_absolute_path(raw):
            path = Path(raw).expanduser()
            if not path.is_absolute():
                path = (self.cwd / path).resolve()
            else:
                path = path.resolve()
            _raise_if_symlink_loop(path)
            return path
        return super()._resolve_path(raw)

    def _to_virtual_path(self, path: Path) -> str:
        """Virtual under cwd; real absolute string for host paths outside cwd."""
        try:
            return super()._to_virtual_path(path)
        except ValueError:
            return path.resolve().as_posix()

    def _display_path(self, path: Path) -> str:
        if not self.virtual_mode:
            return str(path)
        try:
            return super()._to_virtual_path(path)
        except (ValueError, OSError, RuntimeError):
            return path.resolve().as_posix()
