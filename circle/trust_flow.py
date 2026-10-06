"""Trust prompt before enabling a workspace."""

from __future__ import annotations

from pathlib import Path

from circle.paths import normalize_workspace
from circle.settings import CircleSettings
from circle.trust import accept_trust


def run_trust_prompt(
    settings: CircleSettings,
    workspace: str | Path,
    *,
    home: Path | None = None,
) -> CircleSettings | None:
    target = normalize_workspace(workspace)
    print("Trust this folder?")
    print(f"  {target}")
    print("Circle reads, edits and runs commands here, asking first for anything that")
    print("changes files. Trusting also loads the folder's own commands, skills and")
    print("extensions.")
    raw = input("trust it? [y/N]: ").strip().lower()
    if raw not in {"y", "yes"}:
        print("Not trusted.")
        return None
    return accept_trust(settings, target, home=home)
