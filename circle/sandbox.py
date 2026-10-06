"""Filesystem backend with host-absolute path passthrough.

Deep Agents' default ``virtual_mode=True`` treats every absolute path as
virtual under the workspace root, so a user-typed host path like
``/Users/…/OtherProject`` becomes ``{workspace}/Users/…`` and appears missing.

Circle keeps workspace-virtual paths for project-relative work
(``/src/foo``, ``note.txt``), but host-looking absolute paths stay real.
Writes still go through HITL (``interrupt_on``).
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import time
from collections.abc import Mapping
from pathlib import Path

from deepagents.backends import LocalShellBackend
from deepagents.backends.filesystem import _raise_if_symlink_loop
from deepagents.backends.protocol import ExecuteResponse

# How often a running command checks whether the turn was stopped
_POLL_S = 0.2
STOPPED_OUTPUT = "Stopped: the user pressed esc, so the command was ended before it finished."

# 名字里任一段（按非字母数字切）是这些词、或以它们结尾，就当机密：API key、令牌、口令等
_SECRET_PARTS = ("KEY", "KEYS", "TOKEN", "TOKENS", "SECRET", "SECRETS", "PASS", "PASSWORD",
                 "PASSWD", "PASSPHRASE", "CREDENTIAL", "CREDENTIALS", "COOKIE", "COOKIES", "PRIVATE")


def _looks_secret(name: str) -> bool:
    parts = [p for p in re.split(r"[^A-Z0-9]+", name.upper()) if p]
    return any(p in _SECRET_PARTS or p.endswith(("PASS", "PASSWORD", "PASSWD", "TOKEN",
                                                  "SECRET", "APIKEY"))
               for p in parts)


def _own_venv(env: Mapping[str, str], workspace: Path | None) -> Path | None:
    """The virtual environment Circle runs from, when the shell that started Circle had it
    active: its ``python`` and ``pip`` are Circle's, not the project's. A venv inside the
    workspace belongs to the project (Circle installed into it, or Circle's own checkout)."""
    raw = env.get("VIRTUAL_ENV") or ""
    if not raw:
        return None
    try:
        venv = Path(raw).resolve()
        if venv != Path(sys.prefix).resolve():
            return None
        if workspace is not None and venv.is_relative_to(Path(workspace).resolve()):
            return None
    except (OSError, RuntimeError, ValueError):
        return None
    return venv


def shell_environment(source: Mapping[str, str] | None = None, *,
                      workspace: str | Path | None = None) -> dict[str, str]:
    """Environment for commands the model runs: the user's own, minus anything named like a secret,
    and minus Circle's own virtual environment (see ``_own_venv``).

    An empty environment (the old default) drops HOME, the user's PATH (venvs), locale and TLS
    trust settings such as SSL_CERT_FILE, so ordinary tools break; the API key circle itself puts
    into os.environ must still never reach model-run commands.
    """
    env = os.environ if source is None else source
    out = {k: v for k, v in env.items() if not _looks_secret(k)}
    venv = _own_venv(out, Path(workspace) if workspace is not None else None)
    if venv is not None:
        scripts = os.path.normcase(str(venv / ("Scripts" if os.name == "nt" else "bin")))
        out["PATH"] = os.pathsep.join(
            part for part in out.get("PATH", "").split(os.pathsep)
            if part and os.path.normcase(os.path.realpath(part)) != scripts)
        out.pop("VIRTUAL_ENV", None)
        out.pop("VIRTUAL_ENV_PROMPT", None)
    return out


_HOST_TOP_LEVEL = frozenset(
    {
        "Users",
        "home",
        "private",
        "Volumes",
        "tmp",
        "var",
        "opt",
        "Library",
        "System",
        "Applications",
        "usr",
        "etc",
        "bin",
        "sbin",
        "dev",
        "mnt",
        "media",
        "root",
        "proc",
        "run",
        "boot",
    }
)


def is_host_absolute_path(path: str) -> bool:
    """True when ``path`` should resolve on the real host filesystem."""
    raw = (path or "").strip()
    if not raw:
        return False
    if raw.startswith("~"):
        return True
    if re.match(r"^[a-zA-Z]:[\\/]", raw):
        return True
    if not raw.startswith("/"):
        return False
    first = raw.lstrip("/").split("/", 1)[0]
    return first in _HOST_TOP_LEVEL


def _turn_stopped(stop: object = None) -> bool:
    """Whether the user stopped the turn this tool call belongs to, or ``stop`` when the
    caller passed its own token (a command typed with ``!``)."""
    from langgraph.config import get_config

    from circle.middleware.cancellation import CancellationToken

    if stop is not None:
        return isinstance(stop, CancellationToken) and stop.cancelled
    try:
        token = (get_config().get("configurable") or {}).get("circle_cancel_token")
    except RuntimeError:
        return False
    return isinstance(token, CancellationToken) and token.cancelled


def _end_group(proc: subprocess.Popen) -> None:
    """End the command and everything it started (it runs in its own process group)."""
    for sig, grace in ((signal.SIGTERM, 1.0), (signal.SIGKILL, 1.0)):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            proc.wait(timeout=grace)
            return
        except subprocess.TimeoutExpired:
            continue


# Files deepagents keeps for itself: the older messages a summary replaced and tool
# results too long for the conversation. The model sees them at these paths; they are
# kept in the data folder (``offload_root``), not in the project.
OFFLOAD_FOLDERS = frozenset({"conversation_history", "large_tool_results"})


class CircleSandboxBackend(LocalShellBackend):
    """LocalShellBackend with host-absolute path passthrough, commands that stop when the
    turn is stopped, and ``/conversation_history`` and ``/large_tool_results`` kept in
    ``offload_root``."""

    def __init__(self, *args: object, offload_root: str | Path | None = None,
                 **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self.offload_root = Path(offload_root).expanduser().resolve() if offload_root else None

    def offload_path(self, key: str) -> Path | None:
        """Where a path under one of OFFLOAD_FOLDERS is kept; None for every other path."""
        if self.offload_root is None or not self.virtual_mode:
            return None
        raw = (key or "").strip().replace("\\", "/")
        if is_host_absolute_path(raw):
            return None
        parts = [part for part in raw.split("/") if part not in {"", "."}]
        if not parts or parts[0] not in OFFLOAD_FOLDERS:
            return None
        if ".." in parts or raw.startswith("~"):
            raise ValueError("Path traversal not allowed")
        full = self.offload_root.joinpath(*parts).resolve()
        if not full.is_relative_to(self.offload_root):
            raise ValueError(f"Path:{full} outside {self.offload_root}")
        return full

    def _offload_virtual(self, path: Path) -> str | None:
        if self.offload_root is None:
            return None
        try:
            rel = Path(path).resolve().relative_to(self.offload_root)
        except (ValueError, OSError, RuntimeError):
            return None
        return "/" + rel.as_posix() if rel.parts and rel.parts[0] in OFFLOAD_FOLDERS else None

    def execute(self, command: str, *, timeout: int | None = None,
                stop: object = None) -> ExecuteResponse:
        """Run like LocalShellBackend.execute, but wait in short steps: when the user stops
        the turn (or cancels ``stop``), or the timeout passes, the command's whole process
        group is ended instead of the turn waiting for it (or leaving a server behind)."""
        if not command or not isinstance(command, str) or sys.platform == "win32":
            return super().execute(command, timeout=timeout)
        limit = timeout if timeout is not None else self._default_timeout
        if limit <= 0:
            raise ValueError(f"timeout must be positive, got {limit}")
        try:
            proc = subprocess.Popen(  # noqa: S602 - the model's shell command, approved first
                command, shell=True, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, errors="replace", env=self._env,
                cwd=str(self.cwd), start_new_session=True)
        except Exception as exc:  # noqa: BLE001 - reported to the model like upstream
            return ExecuteResponse(output=f"Error executing command ({type(exc).__name__}): {exc}",
                                   exit_code=1, truncated=False)
        deadline = time.monotonic() + limit
        try:
            while True:
                try:
                    stdout, stderr = proc.communicate(timeout=_POLL_S)
                    break
                except subprocess.TimeoutExpired:
                    stopped = _turn_stopped(stop)
                    if not stopped and time.monotonic() < deadline:
                        continue
                    _end_group(proc)
                    proc.communicate()
                    if stopped:
                        return ExecuteResponse(output=STOPPED_OUTPUT, exit_code=130,
                                               truncated=False)
                    hint = ("(custom timeout). The command may be stuck or require more time."
                            if timeout is not None else
                            ". For long-running commands, re-run using the timeout parameter.")
                    return ExecuteResponse(
                        output=f"Error: Command timed out after {limit} seconds{hint}",
                        exit_code=124, truncated=False)
        except Exception as exc:  # noqa: BLE001 - reported to the model like upstream
            _end_group(proc)
            return ExecuteResponse(output=f"Error executing command ({type(exc).__name__}): {exc}",
                                   exit_code=1, truncated=False)
        parts = [stdout] if stdout else []
        if stderr:
            parts.extend(f"[stderr] {line}" for line in stderr.strip().split("\n"))
        output = "\n".join(parts) if parts else "<no output>"
        truncated = len(output) > self._max_output_bytes
        if truncated:
            output = (output[: self._max_output_bytes]
                      + f"\n\n... Output truncated at {self._max_output_bytes} bytes.")
        if proc.returncode != 0:
            output = f"{output.rstrip()}\n\nExit code: {proc.returncode}"
        return ExecuteResponse(output=output, exit_code=proc.returncode, truncated=truncated)

    def _resolve_path(self, key: str) -> Path:
        raw = (key or "").strip() or "/"
        offload = self.offload_path(raw)
        if offload is not None:
            return offload
        if is_host_absolute_path(raw):
            path = Path(raw).expanduser()
            if not path.is_absolute():
                path = (self.cwd / path).resolve()
            else:
                path = path.resolve()
            _raise_if_symlink_loop(path)
            return path
        return super()._resolve_path(raw)

    def _to_virtual_path(self, path: Path) -> str:
        """Virtual under cwd; real absolute string for host paths outside cwd."""
        offload = self._offload_virtual(path)
        if offload is not None:
            return offload
        try:
            return super()._to_virtual_path(path)
        except ValueError:
            return path.resolve().as_posix()

    def _display_path(self, path: Path) -> str:
        if not self.virtual_mode:
            return str(path)
        offload = self._offload_virtual(path)
        if offload is not None:
            return offload
        try:
            return super()._to_virtual_path(path)
        except (ValueError, OSError, RuntimeError):
            return path.resolve().as_posix()
