"""Frozen-aware home and project paths.

Data and credentials live under CIRCLE_HOME (default ~/.circle), never under
the install prefix or a Path(__file__) walk — so PyInstaller onedir stays
valid after re-homing.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def circle_home(override: str | Path | None = None) -> Path:
    if override is not None:
        return Path(override).expanduser().resolve()
    raw = (os.environ.get("CIRCLE_HOME") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".circle").resolve()


def settings_path(home: Path | None = None) -> Path:
    return (home or circle_home()) / "settings.json"


def credentials_path(home: Path | None = None) -> Path:
    """API keys land here (0600), not in the project tree."""
    return (home or circle_home()) / "credentials.json"


def ensure_home(home: Path | None = None) -> Path:
    root = home or circle_home()
    root.mkdir(parents=True, exist_ok=True)
    return root


def project_agent_dir(workspace: Path) -> Path:
    return Path(workspace).expanduser().resolve() / ".agent"


def normalize_workspace(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()
