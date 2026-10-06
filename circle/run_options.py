"""What the command line asked for one run. Nothing here is saved to settings."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

# pi's names for the built-in tools, so ``--tools read,grep`` works for people used to it
TOOL_ALIASES = {
    "read": "read_file",
    "write": "write_file",
    "edit": "edit_file",
    "bash": "execute",
    "find": "glob",
}


def tool_names(raw: str) -> list[str]:
    """A comma-separated tool list, with pi's names translated."""
    out: list[str] = []
    for part in raw.split(","):
        name = part.strip()
        if name:
            out.append(TOOL_ALIASES.get(name, name))
    return out


def prompt_text(value: str) -> str:
    """A prompt given on the command line: the file's text when it names a file, else the
    words themselves."""
    try:
        path = Path(value).expanduser()
        if "\n" not in value and path.is_file():
            return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError, ValueError):
        pass
    return value


@dataclass
class RunOptions:
    # Replaces Circle's own instructions (``--system-prompt``)
    system_prompt: str | None = None
    # Added after them (``--append-system-prompt``, repeatable)
    append_system_prompt: list[str] = field(default_factory=list)
    # Leave out AGENTS.md and CLAUDE.md (``--no-context-files``)
    no_context_files: bool = False
    # Only these tools (``--tools``; an empty list is ``--no-tools``), None for all
    tools: list[str] | None = None
    exclude_tools: list[str] = field(default_factory=list)
    session_name: str = ""
    # Keep the conversation in memory only (``--no-session``)
    no_session: bool = False
    # What ctrl+p goes through (``--models``), in place of ``enabled_models``
    models: list[str] = field(default_factory=list)

    def limits_tools(self) -> bool:
        return self.tools is not None or bool(self.exclude_tools)
