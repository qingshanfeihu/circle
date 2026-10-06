"""Project trust gate."""

from __future__ import annotations

from pathlib import Path

from circle.paths import normalize_workspace
from circle.settings import CircleSettings, save_settings, trust_folder


def accept_trust(
    settings: CircleSettings,
    workspace: str | Path,
    *,
    home: Path | None = None,
) -> CircleSettings:
    """Record trust in the user's settings. Nothing is written into the folder itself."""
    target = normalize_workspace(workspace)
    if not target.is_dir():
        raise NotADirectoryError(f"workspace is not a directory: {target}")
    updated = trust_folder(settings, target)
    save_settings(updated, home)
    return updated
