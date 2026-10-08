"""Background jobs: commands, agents and watches that keep running after the tool call that
started them has returned.

One ``JobRegistry`` belongs to a session (the full-screen app, a print run, line mode, an
RPC server) and outlives agent rebuilds. A shell job is a process group: it is running while
anything in the group is, its output goes to one file the model reads with ``read_file``,
and it is stopped with the whole group. When a job the model started ends, a notice for its
conversation is queued; the session hands it to the model in the running turn or starts a
turn for it.

No module-level imports of POSIX-only modules: Windows imports this too.
"""

from __future__ import annotations

import atexit
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# How often the monitor looks at running shell jobs
POLL_S = 0.25
# Running shell and watch jobs at most; processes adopted from a finished command are not refused
MAX_RUNNING = 16
# What a notice quotes from a job's output
NOTICE_TAIL_LINES = 20
NOTICE_TAIL_BYTES = 4096
# Notices that arrive close together go to the model in one turn
DEBOUNCE_S = 1.0
DEBOUNCE_MAX_S = 5.0
# A notice counts the lines of an output file up to this size (counting reads it all)
COUNT_LINES_UP_TO = 64 * 1024 * 1024
# What a watch's result may be in a notice; a longer one is kept in a file
WATCH_RESULT_BYTES = 4096
# Job folders of earlier sessions are removed after this long (when their Circle has ended)
STALE_FOLDER_S = 24 * 3600
NOTICE_MARKER = "circle_job_notice"
FOLDER = "background_jobs"

RUNNING = ("running", "waiting")
_FOLDER_NAME = re.compile(r"^(\d+)-(\d+)$")


def output_limit_bytes() -> int:
    """Largest output file a job may write before it is stopped (``CIRCLE_JOB_OUTPUT_LIMIT_MB``)."""
    try:
        mb = float(os.environ.get("CIRCLE_JOB_OUTPUT_LIMIT_MB", "1024"))
    except ValueError:
        mb = 1024.0
    return max(1, int(mb * 1024 * 1024))


@dataclass
class Job:
    """What a job is and how it is doing. Listeners and callers get copies."""

    id: str
    kind: str  # "shell" | "adopted" | "agent" | "watch"
    title: str
    thread_id: str = ""
    started_by: str = "model"  # "model" | "user"
    status: str = "running"  # "running" | "waiting" | "done" | "failed" | "stopped"
    reason: str = ""
    exit_code: int | None = None
    output_path: str | None = None
    virtual_path: str | None = None
    parent: str | None = None
    source: str = ""
    summary: str = ""
    detail: str = ""
    started_at: float = field(default_factory=time.time)
    started_mono: float = field(default_factory=time.monotonic)
    ended_at: float | None = None
    ended_mono: float | None = None

    @property
    def running(self) -> bool:
        return self.status in RUNNING

    def elapsed(self, now: float | None = None) -> float:
        end = self.ended_mono if self.ended_mono is not None else (
            time.monotonic() if now is None else now)
        return max(0.0, end - self.started_mono)


@dataclass
class Notice:
    """A finished job waiting to be told to the model."""

    job: Job
    text: str
    wake: bool
    at: float = field(default_factory=time.monotonic)


@dataclass
class Owner:
    """Who a job belongs to: its conversation, who started it, the agent job it runs in."""

    thread_id: str = ""
    started_by: str = "model"
    parent: str | None = None
    # a subagent called the tool: it gets no notice (wait_jobs is its way to wait)
    subagent: bool = False


def job_owner(owner: Owner | dict[str, Any] | None = None) -> Owner:
    """The owner given, or the one of the tool call running now (from the run's config)."""
    if isinstance(owner, Owner):
        return owner
    if isinstance(owner, dict):
        return Owner(thread_id=str(owner.get("thread_id") or ""),
                     started_by=str(owner.get("started_by") or "model"),
                     parent=owner.get("parent"))
    try:
        from langgraph.config import get_config

        configurable = get_config().get("configurable") or {}
    except (RuntimeError, ImportError):
        return Owner()
    thread = configurable.get("circle_rules_thread") or configurable.get("thread_id") or ""
    return Owner(thread_id=str(thread), started_by="model",
                 parent=configurable.get("circle_job"),
                 subagent=configurable.get("ls_agent_type") == "subagent")


# ── processes ───────────────────────────────────────────────────────────────

def spawn_shell(command: str, *, env: dict[str, str] | None, cwd: str,
                output_path: str | Path) -> subprocess.Popen:
    """Run ``command`` in a shell of its own process group, stdout and stderr appended to
    ``output_path``. A file rather than a pipe: the call can return when the shell ends even
    if something it started with ``&`` still writes."""
    out = open(output_path, "ab")  # noqa: SIM115 - the child keeps its own copy
    try:
        kwargs: dict[str, Any] = {"shell": True, "stdin": subprocess.DEVNULL, "stdout": out,
                                  "stderr": subprocess.STDOUT, "env": env, "cwd": cwd}
        if sys.platform == "win32":
            kwargs["creationflags"] = (getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
                                       | getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            kwargs["start_new_session"] = True
        return subprocess.Popen(command, **kwargs)  # noqa: S602 - the model's command, approved first
    finally:
        out.close()


def group_alive(pgid: int | None) -> bool:
    """Whether anything is left in process group ``pgid`` (POSIX only)."""
    if pgid is None or sys.platform == "win32":
        return False
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def end_groups(pgids: list[int], grace: float = 1.0,
               procs: tuple[subprocess.Popen, ...] = ()) -> None:
    """End each process group: SIGTERM, up to ``grace`` seconds for all of them, then SIGKILL.
    ``procs`` are Circle's own children among them, reaped while waiting (a child that has
    ended but is not reaped still counts as a member of its group). On Windows each is a
    process tree ended with taskkill."""
    pgids = [p for p in pgids if p]
    if not pgids:
        return
    if sys.platform == "win32":
        taskkill = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32",
                                "taskkill.exe")
        for pid in pgids:
            try:
                subprocess.run([taskkill, "/PID", str(pid), "/T", "/F"], capture_output=True,
                               timeout=10, check=False)
            except (OSError, subprocess.SubprocessError):
                pass
        return
    for pgid in pgids:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        for proc in procs:
            proc.poll()
        if not any(group_alive(p) for p in pgids):
            break
        time.sleep(0.02)
    for pgid in pgids:
        if group_alive(pgid):
            try:
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass


def end_process(proc: subprocess.Popen, grace: float = 1.0) -> None:
    """End a shell started by ``spawn_shell`` with everything in its group, and reap it."""
    end_groups([proc.pid], grace, (proc,))
    try:
        proc.wait(timeout=max(grace, 0.5))
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=1)
        except (OSError, subprocess.SubprocessError):
            pass


def output_encoding() -> str:
    """How commands' output is decoded: UTF-8, or on Windows the system's code page (what
    console programs write), as text-mode subprocess output was decoded before."""
    if sys.platform == "win32":
        import locale

        return locale.getpreferredencoding(False) or "utf-8"
    return "utf-8"


def decode_output(data: bytes) -> str:
    try:
        return data.decode(output_encoding(), errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def read_head(path: str | Path, limit: int) -> tuple[str, bool]:
    """The first ``limit`` bytes of a file as text, and whether there was more."""
    try:
        with open(path, "rb") as handle:
            data = handle.read(limit + 1)
    except OSError:
        return "", False
    truncated = len(data) > limit
    text = decode_output(data[:limit])
    return text.replace("\r\n", "\n"), truncated


def read_head_chars(path: str | Path, chars: int) -> tuple[str, bool]:
    """The first ``chars`` characters of a file's output, and whether there was more (the
    limit counts characters, as for output read from a pipe, not bytes)."""
    text, more = read_head(path, chars * 4 + 4)
    return text[:chars], more or len(text) > chars


def read_tail(path: str | Path, lines: int = NOTICE_TAIL_LINES,
              limit: int = NOTICE_TAIL_BYTES, *, count_lines: bool = True) -> tuple[str, int]:
    """The last ``lines`` lines of a file (at most ``limit`` bytes), and its line count
    (0 when ``count_lines`` is off: counting reads the whole file)."""
    try:
        size = os.path.getsize(path)
        count = 0
        with open(path, "rb") as handle:
            if count_lines:
                while chunk := handle.read(1 << 20):
                    count += chunk.count(b"\n")
                if size and count == 0:
                    count = 1
            handle.seek(max(0, size - limit))
            data = handle.read(limit)
    except OSError:
        return "", 0
    text = decode_output(data).replace("\r\n", "\n")
    if size > limit:
        text = text.split("\n", 1)[-1]
    tail = text.rstrip("\n").split("\n")[-lines:]
    return "\n".join(tail), count


def format_elapsed(seconds: float) -> str:
    seconds = int(round(seconds))
    if seconds < 60:
        return f"{seconds}s"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m {seconds}s" if seconds else f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes}m" if minutes else f"{hours}h"


def _pid_alive(pid: int) -> bool:
    if sys.platform == "win32":
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True
    return True


# ── notices ─────────────────────────────────────────────────────────────────

def _outcome(job: Job) -> str:
    if job.status == "done":
        return "done" if job.exit_code is None else f"done, exit code {job.exit_code}"
    if job.status == "failed":
        if job.reason and job.reason != "exit":
            return f"failed ({job.reason})"
        return "failed" if job.exit_code is None else f"failed, exit code {job.exit_code}"
    if job.status == "stopped":
        return f"stopped ({job.reason})" if job.reason else "stopped"
    return job.status


def notice_text(job: Job) -> str:
    """What the model is told about one finished job."""
    kind = {"shell": "command", "adopted": "processes", "agent": "agent",
            "watch": "watch"}.get(job.kind, job.kind)
    lines = [f"Background {kind} {job.id} ended: {_outcome(job)}, after "
             f"{format_elapsed(job.elapsed())}."]
    label = {"shell": "Command", "adopted": "Left running by", "agent": "Task",
             "watch": "Watching"}.get(job.kind, "Job")
    lines.append(f"{label}: {job.title}")
    if job.summary:
        word = "Report" if job.kind == "agent" else "Result"
        lines.append(f"{word}:\n{job.summary}")
    if job.output_path and job.kind in ("shell", "adopted"):
        try:
            size = os.path.getsize(job.output_path)
        except OSError:
            size = 0
        small = size <= COUNT_LINES_UP_TO
        tail, count = read_tail(job.output_path, count_lines=small)
        where = job.virtual_path or job.output_path
        if tail:
            amount = (f"{count} line{'s' if count != 1 else ''}" if small
                      else f"{size // (1024 * 1024)} MB")
            shown = len(tail.split("\n"))
            lines.append(f"Output: {where} ({amount}). Last {shown} lines:\n{tail}")
        else:
            lines.append(f"Output: {where} (empty)")
    elif job.virtual_path:
        lines.append(f"Full text: {job.virtual_path}")
    return "\n".join(lines)


def notice_message(notices: list[Notice]) -> Any:
    """One HumanMessage telling the model about finished jobs; it stays in the history."""
    from langchain_core.messages import HumanMessage

    body = "\n\n".join(n.text for n in notices)
    text = (f'<system-reminder data-source="circle-jobs">\n{body}\n\n'
            "This notice comes from Circle, not from the user.\n</system-reminder>")
    payload = [{"id": n.job.id, "kind": n.job.kind, "title": n.job.title,
                "status": n.job.status, "reason": n.job.reason, "exit_code": n.job.exit_code,
                "elapsed_s": round(n.job.elapsed(), 1), "started_by": n.job.started_by,
                "output_path": n.job.virtual_path} for n in notices]
    return HumanMessage(content=text, additional_kwargs={"circle_internal": "job_notice",
                                                         NOTICE_MARKER: payload})


def is_job_notice(message: Any) -> bool:
    extra = getattr(message, "additional_kwargs", None) or {}
    return bool(extra.get(NOTICE_MARKER))


# ── the registry ────────────────────────────────────────────────────────────

@dataclass
class _Entry:
    job: Job
    proc: subprocess.Popen | None = None
    pgid: int | None = None
    deadline: float | None = None
    stop: Callable[[], None] | None = None
    finishes_itself: bool = False
    shell_code: int | None = None
    shell_done: bool = False
    stopping: bool = False
    finishing: bool = False
    stop_reason: str = ""
    seq: int = 0


class ForegroundRun:
    """A command the model (or you, with ``!``) is waiting on; ctrl+b moves it to the
    background by setting ``detach``."""

    def __init__(self, command: str, owner: Owner,
                 proc: subprocess.Popen | None = None) -> None:
        self.command = command
        self.owner = owner
        self.proc = proc
        self.detach = threading.Event()


Listener = Callable[[str, Job], None]


class JobRegistry:
    """Every background job of one session. Thread-safe; listeners are called outside the
    lock with a copy of the job (events: ``started``, ``updated``, ``ended``)."""

    def __init__(self, *, max_running: int = MAX_RUNNING) -> None:
        self._lock = threading.RLock()
        self._changed = threading.Condition(self._lock)
        self._entries: dict[str, _Entry] = {}
        self._next = 1
        self._runs = 0
        self._listeners: list[Listener] = []
        self._notices: dict[str, list[Notice]] = {}
        self._seq = 0
        self._root: Path | None = None
        self._folder: Path | None = None
        self._monitor: threading.Thread | None = None
        self._foreground: list[ForegroundRun] = []
        self._max_running = max_running
        self._stoppers: list[threading.Thread] = []  # watches' on_stop, run on their own

    # where output goes

    def bind_root(self, root: str | Path) -> None:
        """Keep job output under ``root`` (the data folder's ``background_jobs``)."""
        root = Path(root)
        with self._lock:
            if self._root == root:
                return
            self._root = root
            self._folder = None
        self._prune(root)

    def _prune(self, root: Path) -> None:
        try:
            folders = list(root.iterdir())
        except OSError:
            return
        now = time.time()
        for folder in folders:
            match = _FOLDER_NAME.match(folder.name)
            if not match or not folder.is_dir():
                continue
            pid, started = int(match.group(1)), int(match.group(2))
            if pid == os.getpid():
                continue
            age = now - started
            stale = age > STALE_FOLDER_S and not _pid_alive(pid)
            if sys.platform == "win32":
                stale = age > 7 * 24 * 3600
            if stale:
                shutil.rmtree(folder, ignore_errors=True)

    def _session_folder(self) -> Path | None:
        with self._lock:
            if self._root is None:
                return None
            if self._folder is None:
                self._folder = self._root / f"{os.getpid()}-{int(time.time())}"
            folder = self._folder
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def virtual_path(self, path: str | Path) -> str | None:
        folder = self._folder
        if folder is None:
            return None
        try:
            rel = Path(path).relative_to(folder)
        except ValueError:
            return None
        return f"/{FOLDER}/{folder.name}/{rel.as_posix()}"

    def run_output_path(self) -> Path | None:
        """A file for a foreground command's output (renamed if it becomes a job)."""
        folder = self._session_folder()
        if folder is None:
            return None
        with self._lock:
            self._runs += 1
            n = self._runs
        return folder / f"run-{n}.log"

    # starting jobs

    def _new_id(self) -> str:
        job_id = f"j{self._next}"
        self._next += 1
        return job_id

    def can_start(self) -> bool:
        with self._lock:
            live = sum(1 for e in self._entries.values()
                       if e.job.running and e.job.kind in ("shell", "watch"))
            return live < self._max_running

    def start_shell(self, command: str, *, env: dict[str, str] | None, cwd: str,
                    owner: Owner | None = None, timeout: float | None = None,
                    title: str | None = None) -> Job:
        """Start ``command`` as a background job. Raises ``RuntimeError`` when too many run or
        no output folder is bound."""
        who = owner or Owner()
        folder = self._session_folder()
        if folder is None:
            raise RuntimeError("background jobs are not available here")
        with self._lock:
            if not self.can_start():
                raise RuntimeError(f"{self._max_running} background jobs are already running")
            job_id = self._new_id()
        path = folder / f"{job_id}.log"
        proc = spawn_shell(command, env=env, cwd=cwd, output_path=path)
        job = Job(id=job_id, kind="shell", title=title or _title(command),
                  thread_id=who.thread_id, started_by=who.started_by, parent=who.parent,
                  output_path=str(path), virtual_path=self.virtual_path(path))
        entry = _Entry(job=job, proc=proc, pgid=proc.pid if sys.platform != "win32" else None,
                       deadline=(time.monotonic() + timeout) if timeout else None)
        return self._add(entry)

    def promote(self, proc: subprocess.Popen, output_path: str | Path, command: str, *,
                owner: Owner | None = None, reason: str = "") -> Job:
        """A foreground command keeps running as a background job (ctrl+b, the default
        timeout). Its output file is renamed to the job's."""
        who = owner or Owner()
        with self._lock:
            job_id = self._new_id()
        path = self._rename(output_path, job_id)
        job = Job(id=job_id, kind="shell", title=_title(command), thread_id=who.thread_id,
                  started_by=who.started_by, parent=who.parent, output_path=str(path),
                  virtual_path=self.virtual_path(path), detail=reason)
        entry = _Entry(job=job, proc=proc, pgid=proc.pid if sys.platform != "win32" else None)
        return self._add(entry)

    def adopt(self, pgid: int, output_path: str | Path, command: str, *,
              owner: Owner | None = None) -> Job:
        """Processes a finished foreground command left running (``cmd &``) become a job."""
        who = owner or Owner()
        with self._lock:
            job_id = self._new_id()
        path = self._rename(output_path, job_id)
        job = Job(id=job_id, kind="adopted", title=_title(command), thread_id=who.thread_id,
                  started_by=who.started_by, parent=who.parent, output_path=str(path),
                  virtual_path=self.virtual_path(path))
        entry = _Entry(job=job, pgid=pgid, shell_done=True)
        return self._add(entry)

    def register(self, kind: str, title: str, *, owner: Owner | None = None,
                 stop: Callable[[], None] | None = None, finishes_itself: bool = False,
                 source: str = "", output_name: str | None = None) -> Job:
        """A job Circle does not run as a process (an agent, a watch). The caller ends it
        with ``finish``; ``stop`` is called when it is stopped."""
        who = owner or Owner()
        with self._lock:
            job_id = self._new_id()
        output_path = virtual = None
        if output_name is not None:
            folder = self._session_folder()
            if folder is not None:
                path = folder / output_name.format(id=job_id)
                path.touch()
                output_path, virtual = str(path), self.virtual_path(path)
        job = Job(id=job_id, kind=kind, title=title, thread_id=who.thread_id,
                  started_by=who.started_by, parent=who.parent, source=source,
                  output_path=output_path, virtual_path=virtual)
        entry = _Entry(job=job, stop=stop, finishes_itself=finishes_itself)
        return self._add(entry)

    def start_watch(self, title: str, poll: Callable[[], Any], *, interval: float = 10.0,
                    deadline: float = 3600.0, on_stop: Callable[[], None] | None = None,
                    owner: Owner | None = None, source: str = "") -> Job:
        """Wait for something that takes a while by calling ``poll()`` every ``interval``
        seconds on a thread of its own, off the model's turns. None means not yet; any other
        value ends the job with it as the result; an exception or the deadline fails it.
        Raises ``RuntimeError`` when too many jobs run."""
        if not self.can_start():
            raise RuntimeError(f"{self._max_running} background jobs are already running")
        stop = threading.Event()

        def stopped() -> None:
            stop.set()
            if on_stop is not None:
                worker = threading.Thread(target=on_stop, name="circle-watch-stop", daemon=True)
                worker.start()
                with self._lock:
                    self._stoppers.append(worker)

        job = self.register("watch", title, owner=owner, stop=stopped, source=source)
        threading.Thread(target=self._run_watch, args=(job.id, poll, max(0.05, interval),
                                                       deadline, stop),
                         name=f"circle-watch-{job.id}", daemon=True).start()
        return job

    def _run_watch(self, job_id: str, poll: Callable[[], Any], interval: float,
                   deadline: float, stop: threading.Event) -> None:
        began = time.monotonic()
        while not stop.wait(interval):
            if time.monotonic() - began > deadline:
                self.finish(job_id, "failed", reason="deadline")
                return
            try:
                value = poll()
            except Exception as exc:  # noqa: BLE001 - the job fails, the session goes on
                self.finish(job_id, "failed", reason="error",
                            summary=f"{type(exc).__name__}: {exc}")
                return
            if value is not None:
                self.finish(job_id, "done", summary=self._watch_summary(job_id, value))
                return

    def _watch_summary(self, job_id: str, value: Any) -> str:
        import json

        text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False,
                                                                indent=1, default=str)
        if len(text.encode("utf-8")) <= WATCH_RESULT_BYTES:
            return text
        folder = self._session_folder()
        if folder is None:
            return text[:WATCH_RESULT_BYTES] + "\n… (cut)"
        path = folder / f"{job_id}.result.txt"
        path.write_text(text, encoding="utf-8")
        with self._lock:
            entry = self._entries.get(job_id)
            if entry is not None:
                entry.job.output_path, entry.job.virtual_path = str(path), self.virtual_path(path)
        cut = text.encode("utf-8")[:WATCH_RESULT_BYTES].decode("utf-8", errors="ignore")
        return f"{cut}\n… the whole result is in {self.virtual_path(path) or path}"

    def _rename(self, output_path: str | Path, job_id: str) -> Path:
        source = Path(output_path)
        target = source.with_name(f"{job_id}.log")
        try:
            os.replace(source, target)
        except OSError:
            return source
        return target

    def _add(self, entry: _Entry) -> Job:
        with self._lock:
            self._entries[entry.job.id] = entry
            snapshot = replace(entry.job)
            self._changed.notify_all()
            self._ensure_monitor()
        self._emit("started", snapshot)
        return snapshot

    # following jobs

    def _ensure_monitor(self) -> None:
        if self._monitor is not None and self._monitor.is_alive():
            return
        if not any(e.job.running and e.job.kind in ("shell", "adopted")
                   for e in self._entries.values()):
            return
        self._monitor = threading.Thread(target=self._watch, name="circle-jobs", daemon=True)
        self._monitor.start()

    def _watch(self) -> None:
        while True:
            with self._lock:
                live = [e for e in self._entries.values()
                        if e.job.running and e.job.kind in ("shell", "adopted")]
                if not live:
                    self._monitor = None
                    return
            for entry in live:
                if entry.stopping:
                    continue
                try:
                    self._check(entry)
                except Exception:  # noqa: BLE001 - one job must not stop the others
                    logger.warning("checking job %s failed", entry.job.id, exc_info=True)
            time.sleep(POLL_S)

    def _check(self, entry: _Entry) -> None:
        job = entry.job
        if entry.proc is not None and not entry.shell_done:
            code = entry.proc.poll()
            if code is not None:
                entry.shell_done, entry.shell_code = True, code
        if entry.shell_done and not group_alive(entry.pgid):
            if job.kind == "adopted":
                self.finish(job.id, "done", reason="exit")
            else:
                code = entry.shell_code
                self.finish(job.id, "done" if code == 0 else "failed", exit_code=code,
                            reason="exit")
            return
        if job.output_path:
            try:
                size = os.path.getsize(job.output_path)
            except OSError:
                size = 0
            if size > output_limit_bytes():
                self._end(entry)
                self.finish(job.id, "failed", reason="output limit", exit_code=entry.shell_code)
                return
        if entry.deadline is not None and time.monotonic() >= entry.deadline:
            self._end(entry)
            self.finish(job.id, "failed", reason="timeout")

    def _end(self, entry: _Entry, grace: float = 1.0) -> None:
        if entry.proc is not None and not entry.shell_done:
            end_process(entry.proc, grace)
            entry.shell_done = True
            entry.shell_code = entry.proc.returncode
        elif entry.pgid is not None:
            end_groups([entry.pgid], grace)
        elif entry.proc is not None and sys.platform == "win32":
            end_groups([entry.proc.pid], grace)

    def finish(self, job_id: str, status: str, *, exit_code: int | None = None,
               reason: str = "", summary: str = "") -> Job | None:
        """End a job and queue its notice (if the model should hear about it). A job that
        has already ended, or is being ended, is left alone. The notice reads the end of
        the output file, so it is written before the job counts as ended and outside the
        lock: nobody waits on that read, and nobody sees the job ended without its notice."""
        with self._lock:
            entry = self._entries.get(job_id)
            if entry is None or not entry.job.running or entry.finishing:
                return None
            entry.finishing = True
            if status == "stopped" and not reason:
                reason = entry.stop_reason
            ended = replace(entry.job, status=status, reason=reason, exit_code=exit_code,
                            summary=summary or entry.job.summary, ended_at=time.time(),
                            ended_mono=time.monotonic())
        notify = (ended.started_by == "model"
                  and reason not in ("stopped by model", "circle exited"))
        text = notice_text(ended) if notify else ""
        with self._lock:
            job = entry.job
            job.status, job.reason, job.exit_code = status, reason, exit_code
            job.summary, job.ended_at, job.ended_mono = ended.summary, ended.ended_at, ended.ended_mono
            self._seq += 1
            entry.seq = self._seq
            entry.stop = None  # an agent's runner (its graph, its checkpoints) can go
            snapshot = replace(job)
            if notify:
                self._notices.setdefault(job.thread_id, []).append(
                    Notice(job=snapshot, text=text, wake=status in ("done", "failed")))
            self._changed.notify_all()
        self._emit("ended", snapshot)
        return snapshot

    def update(self, job_id: str, **fields: Any) -> None:
        """Change what a job shows (``status="waiting"``, ``detail``) while it runs."""
        with self._lock:
            entry = self._entries.get(job_id)
            if entry is None or not entry.job.running:
                return
            for key, value in fields.items():
                setattr(entry.job, key, value)
            snapshot = replace(entry.job)
            self._changed.notify_all()
        self._emit("updated", snapshot)

    # stopping

    def stop(self, job_id: str, *, by: str = "model") -> Job | None:
        """Stop a running job with everything it started. Returns the job, or None when it
        is unknown or has ended."""
        with self._lock:
            entry = self._entries.get(job_id)
            if entry is None or not entry.job.running or entry.stopping:
                return None
            entry.stopping = True
            entry.stop_reason = f"stopped by {by}"
        children = self._children(job_id)
        if entry.stop is not None:
            try:
                entry.stop()
            except Exception:  # noqa: BLE001 - stopping goes on
                pass
        else:
            self._end(entry)
        for child in children:
            self.stop(child, by=by)
        if entry.finishes_itself:
            with self._lock:
                job = replace(entry.job)
            return job
        return self.finish(job_id, "stopped", reason=f"stopped by {by}",
                           exit_code=entry.shell_code)

    def _children(self, job_id: str) -> list[str]:
        with self._lock:
            return [e.job.id for e in self._entries.values()
                    if e.job.parent == job_id and e.job.running]

    def stop_children(self, job_id: str, *, by: str = "model") -> int:
        """Stop the jobs an agent job started (when that agent ends)."""
        children = self._children(job_id)
        for child in children:
            self.stop(child, by=by)
        return len(children)

    def stop_all(self, reason: str = "circle exited", grace: float = 1.0) -> int:
        """Stop every running job (Circle is leaving). Returns how many were running."""
        with self._lock:
            live = [e for e in self._entries.values() if e.job.running]
            for entry in live:
                entry.stopping = True
            # commands being waited on end too: their waiting thread may not outlive Circle
            waited = [r.proc for r in self._foreground if r.proc is not None]
        groups = [proc.pid for proc in waited]
        procs = list(waited)
        for entry in live:
            if entry.stop is not None:
                try:
                    entry.stop()
                except Exception:  # noqa: BLE001
                    pass
            elif entry.proc is not None and not entry.shell_done:
                groups.append(entry.proc.pid)
                procs.append(entry.proc)
            elif entry.pgid is not None:
                groups.append(entry.pgid)
        end_groups(groups, grace, tuple(procs))
        with self._lock:
            stoppers, self._stoppers = list(self._stoppers), []
        deadline = time.monotonic() + 2.0
        for worker in stoppers:
            worker.join(max(0.0, deadline - time.monotonic()))
        for entry in live:
            if entry.proc is not None:
                try:
                    entry.proc.wait(timeout=0.5)
                except (subprocess.TimeoutExpired, OSError):
                    pass
            self.finish(entry.job.id, "stopped", reason=reason)
        return len(live)

    # looking

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            entry = self._entries.get(job_id)
            return replace(entry.job) if entry is not None else None

    def list(self, thread_id: str | None = None) -> list[Job]:
        with self._lock:
            jobs = [replace(e.job) for e in self._entries.values()]
        if thread_id is not None:
            jobs = [j for j in jobs if j.thread_id == thread_id]
        return jobs

    def live(self, kind: str | None = None) -> list[Job]:
        return [j for j in self.list() if j.running and (kind is None or j.kind == kind)]

    def forget(self, job_id: str) -> bool:
        """Drop a finished job from the list."""
        with self._lock:
            entry = self._entries.get(job_id)
            if entry is None or entry.job.running:
                return False
            del self._entries[job_id]
        return True

    # notices

    def has_notices(self, thread_id: str) -> bool:
        with self._lock:
            return bool(self._notices.get(thread_id))

    def pending_notices(self, thread_id: str) -> list[Notice]:
        with self._lock:
            return list(self._notices.get(thread_id, []))

    def notice_ready(self, thread_id: str, now: float | None = None) -> bool:
        """A notice that may wake the model is waiting, and none has arrived in the last
        moment (or the oldest has waited long enough)."""
        now = time.monotonic() if now is None else now
        with self._lock:
            queue = self._notices.get(thread_id) or []
            waking = [n for n in queue if n.wake]
            if not waking:
                return False
            newest = max(n.at for n in queue)
            oldest = min(n.at for n in waking)
        return now - newest >= DEBOUNCE_S or now - oldest >= DEBOUNCE_MAX_S

    def take_notices(self, thread_id: str, job_ids: list[str] | None = None) -> list[Notice]:
        with self._lock:
            queue = self._notices.get(thread_id) or []
            if job_ids is None:
                taken, kept = queue, []
            else:
                taken = [n for n in queue if n.job.id in job_ids]
                kept = [n for n in queue if n.job.id not in job_ids]
            if kept:
                self._notices[thread_id] = kept
            else:
                self._notices.pop(thread_id, None)
            return list(taken)

    def notice_threads(self) -> list[str]:
        with self._lock:
            return [t for t, q in self._notices.items() if q]

    def end_seq(self) -> int:
        with self._lock:
            return self._seq

    def ended_since(self, thread_id: str, seq: int) -> list[Job]:
        """Jobs of ``thread_id`` the model will be told about that ended after ``seq``."""
        with self._lock:
            return [replace(e.job) for e in self._entries.values()
                    if e.seq > seq and e.job.thread_id == thread_id
                    and e.job.started_by == "model"
                    and e.job.reason not in ("stopped by model", "circle exited")]

    def wait_for_change(self, timeout: float) -> None:
        with self._lock:
            self._changed.wait(timeout)

    # foreground commands (for ctrl+b)

    @contextmanager
    def foreground(self, command: str, owner: Owner,
                   proc: subprocess.Popen | None = None) -> Iterator[ForegroundRun]:
        run = ForegroundRun(command, owner, proc)
        with self._lock:
            self._foreground.append(run)
        try:
            yield run
        finally:
            with self._lock:
                if run in self._foreground:
                    self._foreground.remove(run)

    def foreground_runs(self) -> list[ForegroundRun]:
        with self._lock:
            return list(self._foreground)

    def detach_foreground(self, thread_id: str | None = None) -> int:
        """Move every command being waited on to the background (ctrl+b). Not the commands
        of background agents: they wait for those themselves. Returns how many."""
        with self._lock:
            runs = [r for r in self._foreground
                    if not r.detach.is_set() and r.owner.parent is None
                    and (thread_id is None or r.owner.thread_id == thread_id)]
            for run in runs:
                run.detach.set()
        return len(runs)

    # listeners

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        with self._lock:
            self._listeners.append(listener)

        def unsubscribe() -> None:
            with self._lock:
                if listener in self._listeners:
                    self._listeners.remove(listener)

        return unsubscribe

    def _emit(self, event: str, job: Job) -> None:
        with self._lock:
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(event, job)
            except Exception:  # noqa: BLE001 - a listener must not break the registry
                logger.warning("a job listener failed on %s %s", event, job.id, exc_info=True)


def _title(command: str) -> str:
    first = (command or "").strip().splitlines()[0] if (command or "").strip() else ""
    return first[:200]


def install_exit_guard(registry: JobRegistry) -> Callable[[], None]:
    """Stop every job when Circle ends: at interpreter exit, and on SIGTERM or SIGHUP (closing
    the terminal) when those still have their default action. Returns an uninstall."""

    def at_exit() -> None:
        registry.stop_all(grace=0.5)

    atexit.register(at_exit)
    installed: dict[int, Any] = {}
    if sys.platform != "win32" and threading.current_thread() is threading.main_thread():
        def handler(signum: int, _frame: Any) -> None:
            registry.stop_all(grace=0.5)
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)

        for name in ("SIGTERM", "SIGHUP"):
            sig = getattr(signal, name, None)
            if sig is None:
                continue
            try:
                if signal.getsignal(sig) == signal.SIG_DFL:
                    signal.signal(sig, handler)
                    installed[sig] = handler
            except (ValueError, OSError):
                continue

    def uninstall() -> None:
        atexit.unregister(at_exit)
        for sig, handler in installed.items():
            try:
                if signal.getsignal(sig) is handler:
                    signal.signal(sig, signal.SIG_DFL)
            except (ValueError, OSError):
                continue

    return uninstall
