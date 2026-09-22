"""Project trust gate and .agent/ bootstrap."""

from __future__ import annotations

import json
from pathlib import Path

from circle.paths import normalize_workspace, project_agent_dir
from circle.settings import CircleSettings, save_settings, trust_folder


AGENT_README = """# Circle project agent

Created when this folder was trusted. Keep project rules and local agent
notes here. Secrets stay in ~/.circle/credentials.json — never commit them.
"""

AGENT_SETTINGS = {
    "version": 1,
    "trusted": True,
}


def ensure_project_agent(workspace: str | Path) -> Path:
    root = project_agent_dir(workspace)
    root.mkdir(parents=True, exist_ok=True)
    readme = root / "README.md"
    if not readme.exists():
        readme.write_text(AGENT_README, encoding="utf-8")
    settings = root / "settings.json"
    if not settings.exists():
        settings.write_text(
            json.dumps(AGENT_SETTINGS, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    return root


def accept_trust(
    settings: CircleSettings,
    workspace: str | Path,
    *,
    home: Path | None = None,
) -> CircleSettings:
    """Record trust in user settings and create project .agent/."""
    target = normalize_workspace(workspace)
    if not target.is_dir():
        raise NotADirectoryError(f"workspace is not a directory: {target}")
    updated = trust_folder(settings, target)
    save_settings(updated, home)
    ensure_project_agent(target)
    return updated
