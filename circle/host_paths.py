"""Let filesystem tools accept a leading ``~`` and Windows host drive paths.

Deep Agents rejects any path that starts with ``~`` before the sandbox sees
it. Circle already resolves host paths such as ``/Users/...``; expand the
tilde first so ``~/.circle/skills/...`` is that same host path.
``..`` is still rejected after expansion.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


def install_tilde_expansion() -> None:
    """Expand home paths and retain native Windows drives without bypassing path checks."""
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
        if sys.platform == "win32" and re.match(r"^[a-zA-Z]:[\\/]", path):
            # Reuse upstream traversal and prefix checks, but retain the drive for the
            # host-path backend instead of rejecting it as a virtual path.
            options = dict(kwargs)
            if options.get("allowed_prefixes") is not None:
                options["allowed_prefixes"] = ["/" + prefix.replace("\\", "/")
                                                for prefix in options["allowed_prefixes"]]
            return current("/" + path.replace("\\", "/"), *args, **options)[1:]
        return current(path, *args, **kwargs)

    validate_path._circle_tilde = True  # type: ignore[attr-defined]
    utils.validate_path = validate_path
    filesystem.validate_path = validate_path
    interrupt.validate_path = validate_path
