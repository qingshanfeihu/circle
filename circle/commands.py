"""Custom slash commands and prompt templates from Markdown files.

A file ``review.md`` in a command or prompt folder becomes ``/review``. The layouts of
OpenCode (``commands/``) and pi (``prompts/``) are both read, and arguments use pi's
syntax: ``$1`` … ``$N``, ``$@`` / ``$ARGUMENTS``, ``${N:-default}``, ``${@:N}``,
``${@:N:L}`` and ``${@:-default}``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_SHELL_RE = re.compile(r"!`([^`]+)`")
# ${N:-default}  ${@:-default}  ${ARGUMENTS:-default}  ${@:N}  ${@:N:L}  $N  $@  $ARGUMENTS
_ARG_RE = re.compile(
    r"\$\{(?P<all>@|ARGUMENTS):-(?P<all_default>[^}]*)\}"
    r"|\$\{(?P<num>\d+):-(?P<num_default>[^}]*)\}"
    r"|\$\{@:(?P<start>\d+)(?::(?P<length>\d+))?\}"
    r"|\$(?P<bare>ARGUMENTS|@|\d+)")


@dataclass(frozen=True)
class CustomCommand:
    name: str
    description: str
    template: str
    source: Path
    agent: str = ""
    model: str = ""
    argument_hint: str = ""


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
    """Lowest priority first: a later folder's command replaces an earlier one's."""
    dirs: list[Path] = []
    uh = Path.home()
    dirs.append(uh / ".config" / "opencode" / "commands")
    dirs.append(uh / ".pi" / "agent" / "prompts")
    if home is not None:
        data = Path(home).expanduser().resolve()
        dirs.extend([data / "commands", data / "prompts"])
    if workspace is not None:
        ws = Path(workspace).expanduser().resolve()
        dirs.extend(
            [
                ws / ".opencode" / "commands",
                ws / ".pi" / "commands",
                ws / ".pi" / "prompts",
                ws / ".circle" / "commands",
                ws / ".circle" / "prompts",
            ]
        )
    return dirs


def _first_line(body: str) -> str:
    """pi's fallback description: the first non-empty line, cut at 60 characters."""
    line = next((ln.strip() for ln in body.splitlines() if ln.strip()), "")
    return line if len(line) <= 60 else line[:60] + "..."


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
            desc = meta.get("description") or _first_line(body) or f"Custom command {name}"
            by_name[name] = CustomCommand(
                name=name,
                description=desc[:200],
                template=body.strip() or raw.strip(),
                source=path.resolve(),
                agent=meta.get("agent") or "",
                model=meta.get("model") or "",
                argument_hint=meta.get("argument-hint") or "",
            )
    return sorted(by_name.values(), key=lambda c: c.name)


def split_arguments(args: str) -> list[str]:
    """Split like a shell, as pi does: whitespace separates, ``"`` and ``'`` group, there
    is no backslash escaping, and quoted and unquoted text next to each other join."""
    import shlex

    lexer = shlex.shlex(args, posix=True)
    lexer.whitespace_split = True
    lexer.escape = ""
    lexer.commenters = ""
    try:
        return list(lexer)
    except ValueError:  # an unclosed quote: fall back to plain words
        return args.split()


def substitute_arguments(template: str, args: str) -> str:
    """Fill in the argument placeholders in one pass, so an argument that itself
    contains ``$1`` is left as written."""
    parts = split_arguments(args) if args.strip() else []
    every = " ".join(parts)

    def one(match: re.Match[str]) -> str:
        if match.group("all") is not None:
            return every or match.group("all_default")
        if match.group("num") is not None:
            index = int(match.group("num"))
            value = parts[index - 1] if 0 < index <= len(parts) else ""
            return value or match.group("num_default")
        if match.group("start") is not None:
            start = max(1, int(match.group("start"))) - 1
            length = match.group("length")
            chosen = parts[start:] if length is None else parts[start:start + int(length)]
            return " ".join(chosen)
        bare = match.group("bare")
        if bare in ("@", "ARGUMENTS"):
            return every
        index = int(bare)
        return parts[index - 1] if 0 < index <= len(parts) else ""

    return _ARG_RE.sub(one, template)


def expand_command_template(template: str, args: str, *, cwd: Path | None = None) -> str:
    """Expand the argument placeholders, then the !`shell` snippets."""
    import subprocess

    text = substitute_arguments(template, args)

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
