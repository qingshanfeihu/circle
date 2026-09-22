"""Discover and load Agent Skills (SKILL.md) for the Circle harness.

Aligned with the Agent Skills layout used by common coding agents:

- User: ``~/.circle/skills``, ``~/.agents/skills`` (optional ``~/.claude/skills``)
- Project: ``.agent/skills``, ``.circle/skills``, ``.agents/skills``
  (``.agents/skills`` also walks ancestors up to the git root)

Deep Agents ``SkillsMiddleware`` lists metadata in the system prompt and
expects the model to ``read_file`` full instructions (progressive disclosure).
Circle also exposes an explicit ``skill`` tool and ``/skill`` slash command
so skills can be force-loaded like a dedicated skill tool.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from circle.system_prompt import load_tool_prompt

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")


@dataclass(frozen=True)
class SkillInfo:
    name: str
    description: str
    path: Path  # SKILL.md
    source_label: str

    @property
    def directory(self) -> Path:
        return self.path.parent


def _parse_frontmatter(text: str) -> dict[str, str]:
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}
    data: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip().strip("'\"")
        if key:
            data[key] = value
    return data


def _read_skill_md(path: Path) -> SkillInfo | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    meta = _parse_frontmatter(raw)
    name = (meta.get("name") or path.parent.name).strip().lower()
    description = (meta.get("description") or "").strip()
    if not name or not _NAME_RE.match(name):
        name = re.sub(r"[^a-z0-9-]+", "-", path.parent.name.lower()).strip("-")[:64]
    if not name:
        return None
    if not description:
        description = f"Skill from {path.parent.name}"
    return SkillInfo(
        name=name,
        description=description[:1024],
        path=path.resolve(),
        source_label="",
    )


def _iter_skill_dirs(root: Path) -> list[Path]:
    """Return directories under ``root`` that contain ``SKILL.md`` (one level + nested)."""
    if not root.is_dir():
        return []
    found: list[Path] = []
    try:
        # Prefer shallow dirs; also accept one nesting level for grouping folders.
        for child in sorted(root.iterdir()):
            if not child.is_dir():
                continue
            skill_md = child / "SKILL.md"
            if skill_md.is_file():
                found.append(child)
                continue
            try:
                for nested in sorted(child.iterdir()):
                    if nested.is_dir() and (nested / "SKILL.md").is_file():
                        found.append(nested)
            except OSError:
                continue
    except OSError:
        return []
    return found


def _git_root(start: Path) -> Path | None:
    cur = start.resolve()
    for directory in [cur, *cur.parents]:
        if (directory / ".git").exists():
            return directory
        if directory.parent == directory:
            break
    return None


def _ancestor_agents_skills(workspace: Path) -> list[tuple[Path, str]]:
    """Walk cwd → git root for ``.agents/skills`` (shared Agent Skills layout)."""
    root = workspace.resolve()
    stop = _git_root(root) or root
    out: list[tuple[Path, str]] = []
    seen: set[Path] = set()
    for directory in [root, *root.parents]:
        candidate = directory / ".agents" / "skills"
        if candidate.is_dir():
            resolved = candidate.resolve()
            if resolved not in seen:
                seen.add(resolved)
                label = "Project Agents" if directory == root else "Ancestor Agents"
                out.append((resolved, label))
        if directory == stop or directory.parent == directory:
            break
    return out


def skill_source_dirs(
    workspace: Path | None,
    home: Path | None,
    *,
    user_home: Path | None = None,
) -> list[str]:
    """Backward-compatible path list for ``create_deep_agent(skills=...)``."""
    return [path for path, _label in skill_sources(workspace, home, user_home=user_home)]


def skill_sources(
    workspace: Path | None,
    home: Path | None,
    *,
    user_home: Path | None = None,
) -> list[tuple[str, str]]:
    """Ordered ``(path, label)`` sources; later entries override earlier names."""
    uh = Path(user_home).expanduser().resolve() if user_home else Path.home()
    ordered: list[tuple[Path, str]] = []

    # Lowest priority first.
    for path, label in (
        (uh / ".agents" / "skills", "Agents"),
        (uh / ".claude" / "skills", "Claude"),
    ):
        if path.is_dir():
            ordered.append((path.resolve(), label))

    if home is not None:
        circle_skills = Path(home).expanduser().resolve() / "skills"
        if circle_skills.is_dir():
            ordered.append((circle_skills, "Circle"))

    if workspace is not None:
        ws = Path(workspace).expanduser().resolve()
        ordered.extend(_ancestor_agents_skills(ws))
        for path, label in (
            (ws / ".circle" / "skills", "Project Circle"),
            (ws / ".agent" / "skills", "Project"),
        ):
            if path.is_dir():
                ordered.append((path.resolve(), label))

    # Deduplicate identical paths (keep last label/occurrence by re-adding).
    dedup: dict[str, str] = {}
    for path, label in ordered:
        dedup[str(path)] = label
    # Preserve priority: rebuild in order of first appearance of final map keys
    # by walking ordered and only emitting when key matches final.
    seen: set[str] = set()
    final: list[tuple[str, str]] = []
    # Emit in order but if path repeats, only last wins — reverse then reverse.
    for path, label in reversed(ordered):
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        final.append((key, label))
    final.reverse()
    return final


def discover_skills(
    workspace: Path | None,
    home: Path | None,
    *,
    user_home: Path | None = None,
) -> list[SkillInfo]:
    """Load skill metadata; later sources override same ``name``."""
    by_name: dict[str, SkillInfo] = {}
    for root, label in skill_sources(workspace, home, user_home=user_home):
        for skill_dir in _iter_skill_dirs(Path(root)):
            info = _read_skill_md(skill_dir / "SKILL.md")
            if info is None:
                continue
            by_name[info.name] = SkillInfo(
                name=info.name,
                description=info.description,
                path=info.path,
                source_label=label,
            )
    return sorted(by_name.values(), key=lambda s: s.name)


def load_skill_body(name: str, skills: list[SkillInfo] | None = None, **kwargs: Any) -> str:
    """Return full SKILL.md text for ``name``, or an error string."""
    catalog = skills if skills is not None else discover_skills(**kwargs)
    needle = (name or "").strip().lower()
    if not needle:
        return "Error: skill name is required"
    for skill in catalog:
        if skill.name == needle:
            try:
                text = skill.path.read_text(encoding="utf-8")
            except OSError as exc:
                return f"Error: could not read {skill.path}: {exc}"
            files = []
            try:
                for child in sorted(skill.directory.iterdir()):
                    if child.name == "SKILL.md" or child.name.startswith("."):
                        continue
                    files.append(str(child.resolve()))
                    if len(files) >= 10:
                        break
            except OSError:
                files = []
            parts = [
                f'<skill_content name="{skill.name}">',
                f"# Skill: {skill.name}",
                "",
                text.strip(),
                "",
                f"Base directory for this skill: {skill.directory}",
                "Relative paths in this skill are relative to this base directory.",
                "",
            ]
            if files:
                parts.append("<skill_files>")
                parts.extend(f"<file>{p}</file>" for p in files)
                parts.append("</skill_files>")
            parts.append("</skill_content>")
            return "\n".join(parts)
    available = ", ".join(s.name for s in catalog) or "(none)"
    return f"Error: skill {name!r} not found. Available: {available}"


class _SkillInput(BaseModel):
    name: str = Field(description="Skill name from the available skills list.")


def build_skill_tool(
    workspace: Path | None,
    home: Path | None,
    *,
    user_home: Path | None = None,
) -> StructuredTool:
    """OpenCode-style ``skill`` tool: inject full SKILL.md into the tool result."""
    description = load_tool_prompt("skill") or (
        "Load a specialized skill by name into the conversation."
    )
    # Snapshot catalog at build time; /reload rebuilds the harness.
    catalog = discover_skills(workspace, home, user_home=user_home)

    def _run(name: str) -> str:
        return load_skill_body(name, skills=catalog)

    return StructuredTool.from_function(
        name="skill",
        description=description,
        func=_run,
        args_schema=_SkillInput,
    )


def format_skills_slash_list(skills: list[SkillInfo]) -> str:
    if not skills:
        return "No skills found. Add SKILL.md under ~/.circle/skills or .agent/skills."
    lines = ["Skills:", ""]
    for skill in skills:
        src = f" ({skill.source_label})" if skill.source_label else ""
        lines.append(f"  {skill.name:<20} {skill.description[:80]}{src}")
    lines.append("")
    lines.append("Load with /skill <name>")
    return "\n".join(lines)
