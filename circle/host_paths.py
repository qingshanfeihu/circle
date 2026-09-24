"""Let filesystem tools accept a leading ``~``.

Deep Agents rejects any path that starts with ``~`` before the sandbox sees
it. Circle already resolves host paths such as ``/Users/...``; expand the
tilde first so ``~/.circle/skills/...`` is that same host path.
``..`` is still rejected after expansion.
"""

from __future__ import annotations

from pathlib import Path


def install_tilde_expansion() -> None:
    """Patch Deep Agents path checks so a leading ``~`` expands to the home dir."""
    import deepagents.backends.utils as utils
    import deepagents.middleware._fs_interrupt as interrupt
    import deepagents.middleware.filesystem as filesystem

    current = utils.validate_path
    if getattr(current, "_circle_tilde", False):
        filesystem.validate_path = current
        interrupt.validate_path = current
        return

    def validate_path(path: str, *args, **kwargs):
        if isinstance(path, str) and path.startswith("~"):
            path = str(Path(path).expanduser())
        return current(path, *args, **kwargs)

    validate_path._circle_tilde = True  # type: ignore[attr-defined]
    utils.validate_path = validate_path
    filesystem.validate_path = validate_path
    interrupt.validate_path = validate_path
