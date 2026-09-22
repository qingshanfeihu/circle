"""Custom slash commands from markdown (OpenCode-compatible layout)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_SHELL_RE = re.compile(r"!`([^`]+)`")


@dataclass(frozen=True)
class CustomCommand:
    name: str
    description: str
    template: str
    source: Path
    agent: str = ""
    model: str = ""


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, text
    meta: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line or not line.strip() or line.lstrip().startswith("#"):
            continue
        key, _, value = line.partition(":")
        meta[key.strip().lower()] = value.strip().strip("'\"")
    body = text[match.end() :]
    return meta, body


def _command_dirs(workspace: Path | None, home: Path | None) -> list[Path]:
    dirs: list[Path] = []
    if home is not None:
        dirs.append(Path(home).expanduser().resolve() / "commands")
    uh = Path.home()
    dirs.append(uh / ".config" / "opencode" / "commands")
    if workspace is not None:
        ws = Path(workspace).expanduser().resolve()
        dirs.extend(
            [
                ws / ".circle" / "commands",
                ws / ".opencode" / "commands",
                ws / ".pi" / "commands",
            ]
        )
    return dirs


def discover_custom_commands(
    workspace: Path | None,
    home: Path | None,
) -> list[CustomCommand]:
    by_name: dict[str, CustomCommand] = {}
    for root in _command_dirs(workspace, home):
        if not root.is_dir():
            continue
        try:
            files = sorted(root.glob("*.md"))
        except OSError:
            continue
        for path in files:
            try:
                raw = path.read_text(encoding="utf-8")
            except OSError:
                continue
            meta, body = _parse_frontmatter(raw)
            name = (meta.get("name") or path.stem).strip().lower()
            name = re.sub(r"[^a-z0-9_-]+", "-", name).strip("-")
            if not name:
                continue
            desc = meta.get("description") or f"Custom command {name}"
            by_name[name] = CustomCommand(
                name=name,
                description=desc[:200],
                template=body.strip() or raw.strip(),
                source=path.resolve(),
                agent=meta.get("agent") or "",
                model=meta.get("model") or "",
            )
    return sorted(by_name.values(), key=lambda c: c.name)


def expand_command_template(template: str, args: str, *, cwd: Path | None = None) -> str:
    """Expand $ARGUMENTS, $1..$n and !`shell` placeholders."""
    import shlex
    import subprocess

    parts = shlex.split(args) if args.strip() else []
    text = template
    text = text.replace("$ARGUMENTS", args.strip())
    for i, part in enumerate(parts, 1):
        text = text.replace(f"${i}", part)

    def _shell(match: re.Match[str]) -> str:
        cmd = match.group(1)
        try:
            out = subprocess.check_output(
                cmd,
                shell=True,
                cwd=str(cwd) if cwd else None,
                stderr=subprocess.STDOUT,
                timeout=30,
                text=True,
            )
            return out.strip()
        except Exception as exc:  # noqa: BLE001
            return f"[shell error: {exc}]"

    return _SHELL_RE.sub(_shell, text)
