"""User-private files using POSIX modes or Windows' native ACL tool."""
from __future__ import annotations

import os
import subprocess
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def windows_account() -> str:
    return subprocess.check_output(["whoami"], text=True).strip()


def make_private(path: Path) -> None:
    if os.name != "nt":
        path.chmod(0o600)
        return
    result = subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", windows_account() + ":(F)"],
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise OSError("Unable to set private file ACL")


def is_private(path: Path) -> bool:
    if os.name != "nt":
        return path.stat().st_mode & 0o777 == 0o600
    result = subprocess.check_output(["icacls", str(path)], text=True).lower()
    return windows_account().lower() in result and "(i)" not in result
