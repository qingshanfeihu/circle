"""Built-in slash commands for the Circle TUI."""

from __future__ import annotations

import re
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
        "Sign in or change the endpoint, key and model",
        aliases=("connect",),
    ),
    SlashCommand("logout", "Clear saved credentials"),
    SlashCommand("init", "Analyze repo and write AGENTS.md"),
    SlashCommand("trust", "Trust this workspace"),
    SlashCommand("settings", "Show current settings"),
    SlashCommand("themes", "Show or set the theme: /themes [auto|dark|light]"),
    SlashCommand("mcp", "List / reload MCP servers and tools"),
    SlashCommand("extensions", "List extensions: /extensions [reload]", aliases=("ext",)),
    SlashCommand("approvals", "Session approvals: /approvals [revoke N]"),
    SlashCommand("jobs", "Background jobs: open one, or stop it", aliases=("tasks",)),
    SlashCommand("new", "Start a new session", aliases=("clear",)),
    SlashCommand(
        "resume",
        "Choose a session to open: /resume [n|id]",
        aliases=("sessions",),
    ),
    SlashCommand("continue", "Resume the previous session"),
    SlashCommand("name", "Set session display name: /name <title>"),
    SlashCommand("session", "Show the session: id, title, messages, tokens"),
    SlashCommand("models", "Choose a model: /models [name]", aliases=("model",)),
    SlashCommand("compact", "Summarize context to free the window", aliases=("summarize",)),
    SlashCommand(
        "plan",
        "Toggle read-only (plan) mode: /plan [on|off]",
        aliases=("plan-mode",),
    ),
    SlashCommand(
        "skill",
        "List or load a skill: /skill [name] [args] or /skill:name [args]",
        aliases=("skills",),
    ),
    SlashCommand("tree", "Go back to an earlier point of the session: /tree [words]"),
    SlashCommand("fork", "New session from before one of your messages: /fork [words]"),
    SlashCommand("clone", "Clone the active branch into a new session"),
    SlashCommand("undo", "Revert last user turn (conversation)"),
    SlashCommand("redo", "Restore after /undo"),
    SlashCommand("thinking", "Hide or show thinking; /thinking <level> sets the depth"),
    SlashCommand("effort", "Choose the thinking depth: /effort [minimal|low|medium|high|xhigh|max]"),
    SlashCommand("details", "Toggle tool-detail verbosity in footer"),
    SlashCommand("copy", "Copy last assistant message to clipboard"),
    SlashCommand("export", "Write the conversation to a file: /export [html|jsonl|path]"),
    SlashCommand("import", "Start a session from an export: /import <file.jsonl|file.md>"),
    SlashCommand("share", "Write a shareable Markdown copy under ~/.circle/shares/"),
    SlashCommand("unshare", "Delete the active local share file"),
    SlashCommand("editor", "Compose next message in $EDITOR / $VISUAL"),
    SlashCommand("reload", "Reload settings.json and rebuild the model"),
    SlashCommand("yolo", "Toggle auto mode: approve every tool call without asking", aliases=("auto",)),
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


# ``/name`` or ``/name args``: a command, known or not. ``/usr/bin/x`` is a path, not this.
_COMMAND_WORD_RE = re.compile(r"^/([A-Za-z][\w:-]*)(?:\s|$)")


def command_word(text: str) -> str:
    """The command name a message starts with, or "" when it is not shaped like one."""
    match = _COMMAND_WORD_RE.match(text or "")
    return match.group(1).lower() if match else ""


@dataclass(frozen=True)
class ParsedSlash:
    name: str
    raw_name: str
    args: str


def parse_slash(text: str, *, extra_commands: set[str] | None = None) -> ParsedSlash | None:
    trimmed = (text or "").strip()
    if not trimmed.startswith("/"):
        return None
    body = trimmed[1:].strip()
    if not body:
        return None

    # Pi-style /skill:name [args]
    if body.lower().startswith("skill:"):
        rest = body[6:]
        parts = rest.split(None, 1)
        skill_name = parts[0].strip() if parts else ""
        skill_args = parts[1] if len(parts) > 1 else ""
        if skill_name:
            combined = skill_name if not skill_args else f"{skill_name} {skill_args}"
            return ParsedSlash(name="skill", raw_name=f"skill:{skill_name}", args=combined)

    parts = body.split(None, 1)
    raw = parts[0].lower()
    args = parts[1] if len(parts) > 1 else ""
    canon = ALIAS_TO_CANONICAL.get(raw)
    if canon is None and extra_commands and raw in extra_commands:
        return ParsedSlash(name=raw, raw_name=raw, args=args)
    if canon is None:
        return None
    return ParsedSlash(name=canon, raw_name=raw, args=args)


def help_text(*, custom: list[tuple[str, str]] | None = None) -> str:
    lines = ["Available commands:", ""]
    for cmd in BUILTIN_SLASH:
        alias = ""
        if cmd.aliases:
            alias = " (" + ", ".join(f"/{a}" for a in cmd.aliases) + ")"
        lines.append(f"  /{cmd.name:<10} {cmd.description}{alias}")
    if custom:
        lines.append("")
        lines.append("Custom commands:")
        for name, desc in custom:
            lines.append(f"  /{name:<10} {desc}")
    lines.append("")
    lines.append("Type text without / to chat. Skills also: /skill:name")
    return "\n".join(lines)


def hotkeys_text() -> str:
    return "\n".join(
        [
            "Keyboard shortcuts:",
            "  enter           send; while busy, the model reads it after its current step",
            "  ctrl+q          queue a follow-up: sent when the turn ends (also alt+enter)",
            "  alt+up          take back messages the model has not read yet",
            "  esc             cancel turn / clear prompt",
            "  esc esc         the session tree (/tree), with an empty prompt",
            "  ctrl+c          abort turn; clear the prompt; on an empty prompt twice to exit",
            "  ctrl+d          exit (with an empty prompt; otherwise delete forward)",
            "  ctrl+z          suspend to the shell; fg comes back",
            "  ctrl+b          move a running command to the background (/jobs lists them)",
            "  \\ enter         line break (also shift+enter, ctrl+j)",
            "  ctrl+t          expand/collapse thinking",
            "  ctrl+o          expand/collapse tool output",
            "  ctrl+r          reverse-i-search history",
            "  ctrl+l          choose a model (/models); also redraws the screen",
            "  ctrl+p          next model, for this session",
            "  shift+tab       next thinking depth, for this session",
            "  ctrl+g          edit the draft in $VISUAL / $EDITOR (/editor)",
            "  ctrl+x          copy the last answer (/copy)",
            "  ctrl+f          find in the conversation; enter next, esc closes",
            "  alt+left/right  move by word (also ctrl+left/right, alt+b / alt+f)",
            "  ctrl+w          delete the word before the cursor (also alt+backspace)",
            "  alt+d           delete the word after the cursor",
            "  ctrl+k / ctrl+u delete to the end / the whole line; ctrl+y puts back the last cut",
            "  up/down         prompt history; with an empty prompt and no more history,",
            "                  scroll the transcript",
            "  down (empty)    select a running subagent; up/down move, enter opens it",
            "  left/right      previous/next subagent on its detail page; esc goes back",
            "  pageup/pagedown scroll transcript (or the detail page) when the prompt is empty",
            "  home/end        top / bottom of the transcript when the prompt is empty",
            "  mouse drag      select and copy; dragging to the top or bottom edge scrolls",
            "  tab             complete a /command or an @path",
            "  ?               this list (with an empty prompt)",
            "  /               slash commands (/help)",
            "  1-9, up/down    answer a permission or question card; enter confirms, esc rejects,",
            "                  y / a / n also work on permission cards",
            "  mouse wheel     over the plan box scrolls it; elsewhere it scrolls the transcript",
        ]
    )


def known_slash_names() -> set[str]:
    return set(ALIAS_TO_CANONICAL.keys())
