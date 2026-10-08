"""Project trust gate."""

from __future__ import annotations

import os
from dataclasses import dataclass
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


@dataclass(frozen=True)
class FolderItem:
    """One kind of thing a folder brings with it, as the trust card and the welcome list it."""

    kind: str          # instructions | skills | commands | extensions | settings
    count: int
    where: str         # where it is, as shown: "AGENTS.md", ".circle/skills"
    names: tuple[str, ...] = ()


def folder_inventory(workspace: str | Path, home: Path | None = None) -> list[FolderItem]:
    """What trusting ``workspace`` loads from the folder itself, found by the same loaders
    the session uses: its instruction files, skills (up to the git root, as ``.agents/skills``
    is looked for), custom commands, extensions and project settings. Your own (user-level)
    skills, commands and extensions are not the folder's and are left out."""
    from circle.commands import discover_custom_commands
    from circle.extensions import ExtensionHost
    from circle.memory_sources import memory_source_paths
    from circle.settings import project_settings_path
    from circle.skills import discover_skills

    ws = normalize_workspace(workspace)
    items: list[FolderItem] = []

    def shown(path: Path) -> str:
        try:
            return str(path.relative_to(ws))
        except ValueError:
            text = str(path)
            user = str(Path.home())
            return "~" + text[len(user):] if text == user or text.startswith(user + os.sep) else text

    def where_of(paths: list[Path]) -> str:
        roots = sorted({shown(p) for p in paths})
        return roots[0] if len(roots) == 1 else ", ".join(roots[:2]) + (" …" if len(roots) > 2 else "")

    instructions = [Path(p) for p in memory_source_paths(ws, None) if _inside(Path(p), ws)]
    if instructions:
        items.append(FolderItem("instructions", len(instructions), where_of(instructions),
                                tuple(shown(p) for p in instructions)))
    skills = [s for s in discover_skills(ws, None, user_home=_NOWHERE)
              if s.source_label.startswith(("Project", "Ancestor"))]
    if skills:
        items.append(FolderItem("skills", len(skills), where_of([s.directory.parent for s in skills]),
                                tuple(s.name for s in skills)))
    commands = [c for c in discover_custom_commands(ws, None) if _inside(c.source, ws)]
    if commands:
        items.append(FolderItem("commands", len(commands), where_of([c.source.parent for c in commands]),
                                tuple(c.name for c in commands)))
    host = ExtensionHost(home=_NOWHERE, workspace=ws, trusted=True)
    extensions = [(name, path) for name, source, path in host.discover() if source == "project"]
    if extensions:
        items.append(FolderItem("extensions", len(extensions),
                                where_of([path.parent.parent for _name, path in extensions]),
                                tuple(name for name, _path in extensions)))
    settings = project_settings_path(ws)
    if settings.is_file():
        items.append(FolderItem("settings", 1, shown(settings)))
    return items


# A folder that does not exist: the loaders look there for your own things and find none
_NOWHERE = Path("/nonexistent-circle-user-home")


def _inside(path: Path, folder: Path) -> bool:
    try:
        Path(path).resolve().relative_to(folder)
        return True
    except ValueError:
        return False
