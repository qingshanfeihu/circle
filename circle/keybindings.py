"""Your own keys for Circle's actions: ``keybindings.json`` in the data folder, as pi's.

The file maps an action to a key, or to a list of keys::

    {"model.select": "ctrl+k", "find": ["ctrl+f", "alt+f"]}

A key named here does that action instead of what it did before, everywhere (in a card
or a list too, where the action's default key has a meaning). The default key keeps
working unless the file gives it to another action, so a binding never leaves you
without a way to stop a turn or leave a list. Key names are those of /hotkeys: ``ctrl+x``,
``alt+up``, ``shift+tab``, ``escape``, ``f2``…
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from circle.paths import circle_home

logger = logging.getLogger(__name__)

FILE_NAME = "keybindings.json"

# action → the key it has by default
ACTIONS: dict[str, str] = {
    "interrupt": "escape",
    "clear": "ctrl+c",
    "exit": "ctrl+d",
    "suspend": "ctrl+z",
    "model.select": "ctrl+l",
    "model.cycle": "ctrl+p",
    "thinking.cycle": "shift+tab",
    "thinking.toggle": "ctrl+t",
    "tools.expand": "ctrl+o",
    "editor.external": "ctrl+g",
    "message.copy": "ctrl+x",
    "message.dequeue": "alt+up",
    "message.followup": "ctrl+q",
    "find": "ctrl+f",
    "history.search": "ctrl+r",
    "secret.enter": "ctrl+s",
    "newline": "ctrl+j",
}


def load_remap(home: Path | None = None) -> tuple[dict[str, str], list[str]]:
    """``{pressed key: the key Circle reads}`` from keybindings.json, and the problems
    found in it (unknown actions, values that are not keys)."""
    path = Path(home or circle_home()) / FILE_NAME
    if not path.is_file():
        return {}, []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {}, [f"{FILE_NAME} could not be read: {exc}"]
    if not isinstance(raw, dict):
        return {}, [f"{FILE_NAME} should be an object of action: key"]
    problems: list[str] = []
    bound: dict[str, str] = {}  # pressed key → default key of its action
    for action, value in raw.items():
        default = ACTIONS.get(str(action))
        if default is None:
            problems.append(f"unknown action {action!r} in {FILE_NAME}")
            continue
        keys = [value] if isinstance(value, str) else value
        if not isinstance(keys, list) or not all(isinstance(k, str) and k.strip() for k in keys):
            problems.append(f"{action}: give a key name or a list of them")
            continue
        for key in keys:
            bound[key.strip().lower()] = default
    return {k: v for k, v in bound.items() if k != v}, problems
