"""Load and assemble Circle system prompts.

Assembly order:

1. Model-family session prompt from ``circle/prompts/session/``.
2. Guidelines, cwd, and ``<project_context>`` from AGENTS.md / CLAUDE.md.
3. Path semantics overlay (host absolute vs workspace virtual).
"""

from __future__ import annotations

import platform
import subprocess
from datetime import date
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Iterable

_CONTEXT_CANDIDATES = (
    "AGENTS.override.md",
    "AGENTS.md",
    "AGENTS.MD",
    "CLAUDE.md",
    "CLAUDE.MD",
)

_MAX_CONTEXT_BYTES = 120_000


def _prompts_root() -> Path:
    try:
        root = resources.files("circle.prompts")
        if hasattr(root, "is_dir") and root.is_dir():
            return Path(str(root))
    except (TypeError, FileNotFoundError, ModuleNotFoundError, AttributeError):
        pass
    return Path(__file__).resolve().parent / "prompts"


def read_prompt(*parts: str) -> str:
    path = _prompts_root().joinpath(*parts)
    return path.read_text(encoding="utf-8").strip()


@lru_cache(maxsize=1)
def available_session_prompts() -> tuple[str, ...]:
    session = _prompts_root() / "session"
    if not session.is_dir():
        return ()
    return tuple(sorted(p.stem for p in session.glob("*.md")))


def select_session_prompt_name(model_id: str | None) -> str:
    """Pick ``session/*.md`` stem from the model id."""
    mid = (model_id or "").lower()
    if "muse" in mid:
        return "meta"
    if (
        "gpt-4" in mid
        or mid.startswith("o1")
        or mid.startswith("o3")
        or "/o1" in mid
        or "/o3" in mid
    ):
        return "beast"
    if "gpt" in mid:
        if "gpt-6" in mid:
            return "gpt-astra"
        if "codex" in mid:
            return "codex"
        if "copilot" in mid and "gpt-5" in mid:
            return "copilot-gpt-5"
        return "gpt"
    if "gemini-" in mid or mid.startswith("gemini"):
        return "gemini"
    if (
        "claude" in mid
        or "anthropic" in mid
        or "sonnet" in mid
        or "opus" in mid
        or "haiku" in mid
    ):
        return "anthropic"
    if "trinity" in mid:
        return "trinity"
    if "kimi" in mid or "moonshot" in mid:
        return "kimi"
    return "default"


def load_session_prompt(model_id: str | None = None) -> str:
    name = select_session_prompt_name(model_id)
    session_dir = _prompts_root() / "session"
    path = session_dir / f"{name}.md"
    if not path.is_file():
        path = session_dir / "default.md"
    text = path.read_text(encoding="utf-8").strip()
    text = text.replace("You are circle,", "You are Circle,")
    text = _strip_foreign_docs_block(text)
    return text


def _strip_foreign_docs_block(text: str) -> str:
    """Drop leftover third-party docs / feedback paragraphs."""
    lines = text.splitlines()
    out: list[str] = []
    skip = False
    for line in lines:
        low = line.lower()
        if "when the user directly asks about" in low and (
            "circle docs" in low or "webfetch" in low
        ):
            skip = True
            continue
        if skip:
            if not line.strip():
                skip = False
            continue
        if "to give feedback" in low:
            skip = True
            continue
        if skip and (
            not line.strip()
            or line.strip().startswith("http")
            or "github.com" in low
        ):
            if not line.strip():
                skip = False
            continue
        if skip:
            skip = False
        out.append(line)
    return "\n".join(out).strip()


def discover_context_files(cwd: str | Path) -> list[tuple[str, str]]:
    """Walk cwd → parents for AGENTS.md / CLAUDE.md instruction files."""
    root = Path(cwd).resolve()
    found: list[tuple[str, str]] = []
    seen: set[Path] = set()
    for directory in [root, *root.parents]:
        for name in _CONTEXT_CANDIDATES:
            path = directory / name
            if path in seen or not path.is_file():
                continue
            seen.add(path)
            try:
                raw = path.read_bytes()
            except OSError:
                continue
            if len(raw) > _MAX_CONTEXT_BYTES:
                raw = raw[:_MAX_CONTEXT_BYTES]
            try:
                content = raw.decode("utf-8")
            except UnicodeDecodeError:
                content = raw.decode("utf-8", errors="replace")
            found.append((str(path), content.strip()))
        if directory.parent == directory:
            break
        if (directory / ".git").exists() and directory != root:
            break
    return found


def format_project_context(files: Iterable[tuple[str, str]]) -> str:
    files = list(files)
    if not files:
        return ""
    parts = [
        "<project_context>",
        "",
        "Project-specific instructions and guidelines:",
        "",
    ]
    for path, content in files:
        parts.append(f'<project_instructions path="{path}">')
        parts.append(content)
        parts.append("</project_instructions>")
        parts.append("")
    parts.append("</project_context>")
    return "\n".join(parts)


def _is_git_repo(cwd: Path) -> bool:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=2,
        )
        return r.returncode == 0 and "true" in (r.stdout or "").lower()
    except (OSError, subprocess.SubprocessError):
        return False


def format_env_block(
    *,
    cwd: str | Path,
    model_id: str | None = None,
    protocol: str | None = None,
) -> str:
    """Environment facts block for the system prompt."""
    root = Path(cwd).resolve()
    lines = [
        "<env>",
        f"  Working directory: {root.as_posix()}",
        f"  Platform: {platform.system().lower()}",
        f"  Today's date: {date.today().isoformat()}",
        f"  Is directory a git repo: {'yes' if _is_git_repo(root) else 'no'}",
    ]
    if model_id:
        lines.append(f"  Model: {model_id}")
    if protocol:
        lines.append(f"  Protocol: {protocol}")
    lines.append("</env>")
    return "\n".join(lines)


def load_tool_prompt(name: str) -> str | None:
    path = _prompts_root() / "tools" / f"{name}.md"
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8").strip()


def load_agent_prompt(name: str) -> str | None:
    path = _prompts_root() / "agent" / f"{name}.md"
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8").strip()


def load_command_prompt(name: str) -> str | None:
    path = _prompts_root() / "commands" / f"{name}.md"
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8").strip()


def build_system_prompt(
    *,
    cwd: str | Path | None = None,
    model_id: str | None = None,
    protocol: str | None = None,
    context_files: list[tuple[str, str]] | None = None,
    append: str | None = None,
    include_tool_catalog: bool = True,
) -> str:
    """Assemble the full system prompt for the main Circle agent."""
    root = Path(cwd).resolve() if cwd else Path.cwd()
    sections: list[str] = [load_session_prompt(model_id)]

    try:
        sections.append(read_prompt("circle_guidelines.md"))
    except FileNotFoundError:
        pass
    try:
        sections.append(read_prompt("circle_paths.md"))
    except FileNotFoundError:
        pass

    if include_tool_catalog:
        catalog = _tool_catalog_section()
        if catalog:
            sections.append(catalog)

    files = (
        context_files if context_files is not None else discover_context_files(root)
    )
    ctx = format_project_context(files)
    if ctx:
        sections.append(ctx)

    sections.append(format_env_block(cwd=root, model_id=model_id, protocol=protocol))
    sections.append(f"Current working directory: {root.as_posix()}")

    if append and append.strip():
        sections.append(append.strip())

    return "\n\n".join(s for s in sections if s and s.strip())


def _tool_catalog_section() -> str:
    snippets = {
        "ls": "list directory entries",
        "read_file": "read a file (workspace-virtual or host-absolute path)",
        "write_file": "create or overwrite a file",
        "edit_file": "apply a surgical edit to an existing file",
        "glob": "find files by glob pattern",
        "grep": "search file contents with regex",
        "execute": "run a shell command in the workspace",
        "write_todos": "track multi-step task progress",
        "task": "delegate to a subagent (e.g. explore)",
        "webfetch": "fetch a URL as text/markdown",
        "question": "ask the user clarifying questions",
    }
    lines = ["Available tools:"]
    for name, desc in snippets.items():
        lines.append(f"- {name}: {desc}")
    return "\n".join(lines)


def default_system_prompt() -> str:
    return build_system_prompt()
