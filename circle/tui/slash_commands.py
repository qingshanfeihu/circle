"""Built-in slash commands aligned with Pi + OpenCode TUI surfaces."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SlashCommand:
    name: str
    description: str
    aliases: tuple[str, ...] = ()


BUILTIN_SLASH: tuple[SlashCommand, ...] = (
    SlashCommand("help", "List slash commands"),
    SlashCommand("hotkeys", "Show keyboard shortcuts"),
    SlashCommand(
        "login",
        "Sign in: /login anthropic|openai (OAuth); API key via circle --init",
        aliases=("connect",),
    ),
    SlashCommand("logout", "Clear saved credentials"),
    SlashCommand("init", "Create or refresh project AGENTS.md"),
    SlashCommand("trust", "Trust this workspace and create .agent/"),
    SlashCommand("settings", "Show current settings"),
    SlashCommand("themes", "List / set theme: /themes [name]"),
    SlashCommand("mcp", "List configured MCP servers"),
    SlashCommand("new", "Start a new session", aliases=("clear",)),
    SlashCommand(
        "resume",
        "List or switch sessions: /resume [n|id]",
        aliases=("sessions",),
    ),
    SlashCommand("continue", "Resume the previous session"),
    SlashCommand("name", "Set session display name: /name <title>"),
    SlashCommand("session", "Show session id, title, model, size"),
    SlashCommand("models", "List or switch model: /models [name]", aliases=("model",)),
    SlashCommand("compact", "Summarize context to free the window", aliases=("summarize",)),
    SlashCommand("undo", "Revert last user turn (conversation)"),
    SlashCommand("redo", "Restore after /undo"),
    SlashCommand("thinking", "Toggle thinking-block visibility"),
    SlashCommand("details", "Toggle tool-detail verbosity in footer"),
    SlashCommand("copy", "Copy last assistant message to clipboard"),
    SlashCommand("export", "Export transcript to Markdown: /export [path]"),
    SlashCommand("import", "Import a prior Markdown export: /import <path>"),
    SlashCommand("share", "Write a shareable Markdown copy under ~/.circle/shares/"),
    SlashCommand("unshare", "Delete the active local share file"),
    SlashCommand("editor", "Compose next message in $EDITOR / $VISUAL"),
    SlashCommand("reload", "Reload settings.json and rebuild the model"),
    SlashCommand("exit", "Quit Circle", aliases=("quit", "q")),
)


def _alias_map() -> dict[str, str]:
    out: dict[str, str] = {}
    for cmd in BUILTIN_SLASH:
        out[cmd.name] = cmd.name
        for alias in cmd.aliases:
            out[alias] = cmd.name
    return out


ALIAS_TO_CANONICAL = _alias_map()


@dataclass(frozen=True)
class ParsedSlash:
    name: str
    raw_name: str
    args: str


def parse_slash(text: str) -> ParsedSlash | None:
    trimmed = (text or "").strip()
    if not trimmed.startswith("/"):
        return None
    body = trimmed[1:].strip()
    if not body:
        return None
    parts = body.split(None, 1)
    raw = parts[0].lower()
    args = parts[1] if len(parts) > 1 else ""
    canon = ALIAS_TO_CANONICAL.get(raw)
    if canon is None:
        return None
    return ParsedSlash(name=canon, raw_name=raw, args=args)


def help_text() -> str:
    lines = ["Available commands:", ""]
    for cmd in BUILTIN_SLASH:
        alias = ""
        if cmd.aliases:
            alias = " (" + ", ".join(f"/{a}" for a in cmd.aliases) + ")"
        lines.append(f"  /{cmd.name:<10} {cmd.description}{alias}")
    lines.append("")
    lines.append("Type text without / to chat.")
    return "\n".join(lines)


def hotkeys_text() -> str:
    return "\n".join(
        [
            "Keyboard shortcuts:",
            "  enter           send",
            "  esc             cancel turn / clear prompt",
            "  ctrl+c          abort turn; twice to exit",
            "  ctrl+t          expand/collapse thinking",
            "  up/down         scroll transcript",
            "  /               slash commands (/help)",
        ]
    )


def known_slash_names() -> set[str]:
    return set(ALIAS_TO_CANONICAL.keys())
