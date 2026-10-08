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
import subprocess
import sys
import tempfile
import time
from collections.abc import Mapping
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from deepagents.backends import LocalShellBackend
from deepagents.backends.filesystem import _raise_if_symlink_loop
from deepagents.backends.protocol import ExecuteResponse

from circle.jobs import (
    FOLDER as JOBS_FOLDER,
    Job,
    JobRegistry,
    Owner,
    end_groups,
    end_process,
    group_alive,
    job_owner,
    output_limit_bytes,
    read_head_chars,
    spawn_shell,
)

# How often a running command checks whether the turn was stopped
_POLL_S = 0.2
STOPPED_OUTPUT = "Stopped: the user pressed esc, so the command was ended before it finished."
# A command that is only ``sleep N``: it ends early when a background job of the model ends
_BARE_SLEEP = re.compile(r"^\s*sleep\s+\d+(?:\.\d+)?[smhd]?\s*$")
# After the shell ends, how long what it started may take to end too before it is adopted
_ADOPT_GRACE_S = 0.5

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


@dataclass
class ShellResponse(ExecuteResponse):
    """A command's result when it became a background job: started as one, moved to the
    background while running, or left processes running that were adopted. ``exit_code`` is
    None while the command itself still runs."""

    job: Job | None = None
    how: str = ""  # "started" | "moved" | "adopted"


def _unlink(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink()
    except OSError:
        pass


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _job_text(job: Job, what: str, who: Owner) -> str:
    where = job.virtual_path or job.output_path
    if who.started_by == "user":
        after = "Its output is shared with the conversation when it ends."
    elif who.subagent:
        after = "Use wait_jobs when you need its result; stop it with stop_job."
    else:
        after = ("Circle adds a notice when it ends, so do not poll or sleep for it; stop it "
                 "with stop_job.")
    return f"[{what} It continues as background job {job.id}; its output goes to {where}. {after}]"


# Files deepagents keeps for itself: the older messages a summary replaced and tool
# results too long for the conversation. The model sees them at these paths; they are
# kept in the data folder (``offload_root``), not in the project. Background jobs write
# their output under ``background_jobs`` there too.
OFFLOAD_FOLDERS = frozenset({"conversation_history", "large_tool_results", JOBS_FOLDER})


class CircleSandboxBackend(LocalShellBackend):
    """LocalShellBackend with host-absolute path passthrough, commands that stop when the
    turn is stopped, and ``/conversation_history`` and ``/large_tool_results`` kept in
    ``offload_root``."""

    def __init__(self, *args: object, offload_root: str | Path | None = None,
                 jobs: JobRegistry | None = None, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)
        self.offload_root = Path(offload_root).expanduser().resolve() if offload_root else None
        # The session's background jobs; without one, processes a command leaves running are
        # ended with it and nothing can run in the background
        self.jobs: JobRegistry | None = None
        if jobs is not None:
            self.bind_jobs(jobs)

    def bind_jobs(self, jobs: JobRegistry) -> None:
        self.jobs = jobs
        if self.offload_root is not None:
            jobs.bind_root(self.offload_root / JOBS_FOLDER)

    def guard(self, command: str) -> ExecuteResponse | None:
        """A refusal for ``command`` before it runs (plan mode, refused commands), or None."""
        return None

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

    def execute(self, command: str, *, timeout: int | None = None, stop: object = None,
                owner: Owner | dict[str, Any] | None = None) -> ExecuteResponse:
        """Run a command and wait for it, in short steps. Its output goes to a file, so the
        call returns when the shell ends even if it started something with ``&``; what is
        still running then becomes a background job (or, without a job registry, is ended).

        While waiting: esc (the turn's token or ``stop``) ends the command with its whole
        process group; ctrl+b moves it to the background; an explicit ``timeout`` ends it,
        the default one moves it to the background; a bare ``sleep`` ends early when a
        background job of the model ends."""
        if isinstance(command, str) and command:
            blocked = self.guard(command)
            if blocked is not None:
                return blocked
        if not command or not isinstance(command, str):
            return super().execute(command, timeout=timeout)
        limit = timeout if timeout is not None else self._default_timeout
        if limit <= 0:
            raise ValueError(f"timeout must be positive, got {limit}")
        jobs = self.jobs
        who = job_owner(owner)
        try:
            path = jobs.run_output_path() if jobs is not None else None
        except OSError:
            path = None  # the data folder cannot be written: the command still runs
        if path is None:
            handle, name = tempfile.mkstemp(prefix="circle-run-", suffix=".log")
            os.close(handle)
            path = Path(name)
        try:
            proc = spawn_shell(command, env=self._env, cwd=str(self.cwd), output_path=path)
        except Exception as exc:  # noqa: BLE001 - reported to the model like upstream
            _unlink(path)
            return ExecuteResponse(output=f"Error executing command ({type(exc).__name__}): {exc}",
                                   exit_code=1, truncated=False)
        try:
            early = self._wait(proc, path, command, limit=limit, explicit=timeout is not None,
                               stop=stop, jobs=jobs, who=who)
            if early is not None:
                return early
            return self._finished(proc, path, command, jobs=jobs, who=who)
        except Exception as exc:  # noqa: BLE001 - reported to the model like upstream
            end_process(proc)
            _unlink(path)
            return ExecuteResponse(output=f"Error executing command ({type(exc).__name__}): {exc}",
                                   exit_code=1, truncated=False)

    def _wait(self, proc: subprocess.Popen, path: Path, command: str, *, limit: float,
              explicit: bool, stop: object, jobs: JobRegistry | None,
              who: Owner) -> ExecuteResponse | None:
        """Wait for the shell to end (None), or return what ended the wait first."""
        deadline = time.monotonic() + limit
        sleeping = jobs is not None and _BARE_SLEEP.match(command) is not None
        seq = jobs.end_seq() if jobs is not None else 0
        cap = output_limit_bytes()
        checked = time.monotonic()
        waiting = jobs.foreground(command, who, proc) if jobs is not None else nullcontext(None)
        with waiting as run:
            while True:
                try:
                    proc.wait(timeout=_POLL_S)
                    return None
                except subprocess.TimeoutExpired:
                    pass
                if _turn_stopped(stop):
                    end_process(proc)
                    _unlink(path)
                    return ExecuteResponse(output=STOPPED_OUTPUT, exit_code=130, truncated=False)
                if run is not None and run.detach.is_set():
                    return self._moved(proc, path, command, jobs, who,
                                       "The command was moved to the background.")
                if sleeping:
                    ended = jobs.ended_since(who.thread_id, seq)
                    if ended:
                        end_process(proc)
                        _unlink(path)
                        return ExecuteResponse(output=_slept(ended, who), exit_code=0,
                                               truncated=False)
                now = time.monotonic()
                if now - checked >= 1.0:
                    checked = now
                    if _size(path) > cap:
                        end_process(proc)
                        head, _ = read_head_chars(path, self._max_output_bytes)
                        _unlink(path)
                        return ExecuteResponse(
                            output=(f"{head.rstrip()}\n\nError: the command was ended because "
                                    f"its output passed {cap // (1024 * 1024)} MB."),
                            exit_code=1, truncated=True)
                if now >= deadline:
                    if explicit or jobs is None:
                        end_process(proc)
                        _unlink(path)
                        hint = ("(custom timeout). The command may be stuck or require more time."
                                if explicit else
                                ". For long-running commands, re-run using the timeout parameter.")
                        return ExecuteResponse(
                            output=f"Error: Command timed out after {limit} seconds{hint}",
                            exit_code=124, truncated=False)
                    return self._moved(proc, path, command, jobs, who,
                                       f"The command was still running after {int(limit)} "
                                       "seconds.")

    def _moved(self, proc: subprocess.Popen, path: Path, command: str, jobs: JobRegistry,
               who: Owner, what: str) -> ShellResponse:
        head, truncated = read_head_chars(path, self._max_output_bytes)
        job = jobs.promote(proc, path, command, owner=who, reason=what)
        text = f"{head.rstrip()}\n\n" if head.strip() else ""
        return ShellResponse(output=text + _job_text(job, what, who), exit_code=None,
                             truncated=truncated, job=job, how="moved")

    def _finished(self, proc: subprocess.Popen, path: Path, command: str, *,
                  jobs: JobRegistry | None, who: Owner) -> ExecuteResponse:
        """The shell has ended: its output, and what it left running."""
        left = group_alive(proc.pid)
        if left:
            deadline = time.monotonic() + _ADOPT_GRACE_S
            while time.monotonic() < deadline and left:
                time.sleep(0.02)
                left = group_alive(proc.pid)
        output, truncated = read_head_chars(path, self._max_output_bytes)
        adopted = None
        if left and jobs is not None:
            adopted = jobs.adopt(proc.pid, path, command, owner=who)
        else:
            if left:
                end_groups([proc.pid])
            _unlink(path)
        if not output:
            output = "<no output>"
        if truncated:
            output = (output[: self._max_output_bytes]
                      + f"\n\n... Output truncated at {self._max_output_bytes} bytes.")
        if proc.returncode != 0:
            output = f"{output.rstrip()}\n\nExit code: {proc.returncode}"
        if adopted is not None:
            what = "The command has ended, but processes it started are still running."
            return ShellResponse(output=f"{output.rstrip()}\n\n{_job_text(adopted, what, who)}",
                                 exit_code=proc.returncode, truncated=truncated, job=adopted,
                                 how="adopted")
        return ExecuteResponse(output=output, exit_code=proc.returncode, truncated=truncated)

    def start_background(self, command: str, *, timeout: float | None = None,
                         owner: Owner | dict[str, Any] | None = None) -> ExecuteResponse:
        """Start ``command`` as a background job and return at once. ``timeout`` is the most
        it may run."""
        blocked = self.guard(command)
        if blocked is not None:
            return blocked
        if self.jobs is None:
            return ExecuteResponse(output="Error: background jobs are not available here.",
                                   exit_code=1)
        who = job_owner(owner)
        try:
            job = self.jobs.start_shell(command, env=self._env, cwd=str(self.cwd),
                                        owner=who, timeout=timeout)
        except RuntimeError as exc:
            return ExecuteResponse(output=f"Error: {exc}. Stop one with stop_job first.",
                                   exit_code=1)
        except OSError as exc:
            return ExecuteResponse(output=f"Error starting the command ({type(exc).__name__}): "
                                          f"{exc}", exit_code=1)
        limit = f" It is stopped after {int(timeout)} seconds." if timeout else ""
        after = ("Use wait_jobs when you need its result. Stop it with stop_job."
                 if who.subagent else
                 "Circle adds a notice when it ends, so do not poll or sleep for it; if you have "
                 "nothing else to do, end your turn. Stop it with stop_job.")
        text = (f"Started background job {job.id}.{limit} Its output goes to "
                f"{job.virtual_path or job.output_path}. {after}")
        return ShellResponse(output=text, exit_code=None, job=job, how="started")

    def _job_file(self, key: str) -> Path | None:
        full = self.offload_path(key)
        if full is None or self.offload_root is None:
            return None
        try:
            rel = full.relative_to(self.offload_root)
        except ValueError:
            return None
        return full if rel.parts and rel.parts[0] == JOBS_FOLDER else None

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> Any:  # noqa: ANN401
        job_file = self._job_file(file_path)
        if job_file is None:
            return super().read(file_path, offset, limit)
        return _read_lines(job_file, file_path, offset, limit)

    def write(self, file_path: str, content: str) -> Any:  # noqa: ANN401
        if self._job_file(file_path) is not None:
            from deepagents.backends.protocol import WriteResult

            return WriteResult(error="Background job output is kept by Circle and is read-only.")
        return super().write(file_path, content)

    def edit(self, file_path: str, old_string: str, new_string: str,
             replace_all: bool = False) -> Any:  # noqa: ANN401
        if self._job_file(file_path) is not None:
            from deepagents.backends.protocol import EditResult

            return EditResult(error="Background job output is kept by Circle and is read-only.")
        return super().edit(file_path, old_string, new_string, replace_all=replace_all)

    def delete(self, file_path: str) -> Any:  # noqa: ANN401
        if self._job_file(file_path) is not None:
            from deepagents.backends.protocol import DeleteResult

            return DeleteResult(error="Background job output is kept by Circle and is read-only.")
        return super().delete(file_path)

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


def _slept(ended: list[Job], who: Owner) -> str:
    """What a bare ``sleep`` returns when a background job ended while it waited."""
    parts = []
    for job in ended:
        outcome = job.status if job.exit_code is None else f"{job.status}, exit code {job.exit_code}"
        where = f"; output in {job.virtual_path}" if job.virtual_path else ""
        parts.append(f"{job.id} ({job.title}) ended: {outcome}{where}")
    after = ("Read its output, or use wait_jobs for the others." if who.subagent
             else "Circle adds the full notice before your next step.")
    return "sleep ended early because a background job ended:\n" + "\n".join(parts) + "\n" + after


def _read_lines(path: Path, shown: str, offset: int, limit: int) -> Any:  # noqa: ANN401
    """Read a window of a job's output file line by line, so a large log is never read whole
    and bytes that are not UTF-8 do not fail the read."""
    from deepagents.backends.protocol import FileData, ReadResult
    from deepagents.backends.utils import check_empty_content, normalize_read_bounds

    if not path.is_file():
        return ReadResult(error=f"File '{shown}' not found")
    offset, limit = normalize_read_bounds(offset, limit)
    window: list[str] = []
    total = 0
    try:
        with open(path, encoding="utf-8", errors="replace", newline="") as handle:
            for line in handle:
                if offset <= total < offset + limit:
                    window.append(line)
                total += 1
    except OSError as exc:
        return ReadResult(error=f"Error reading file '{shown}': {exc}")
    if total == 0:
        return ReadResult(file_data=FileData(content=check_empty_content("") or "",
                                             encoding="utf-8"))
    if limit == 0:
        return ReadResult(file_data=FileData(content="", encoding="utf-8"),
                          no_lines_requested=True)
    if offset >= total:
        return ReadResult(error=f"Line offset {offset} exceeds file length ({total} lines)")
    content = "".join(window).replace("\r\n", "\n").replace("\r", "\n")
    end = min(offset + limit, total)
    return ReadResult(file_data=FileData(content=content, encoding="utf-8"), total_lines=total,
                      start_line=offset + 1, end_line=end,
                      next_offset=end if end < total else None)
