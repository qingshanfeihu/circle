"""``circle --mode rpc``: Circle as a long-lived child process, driven by JSON lines.

Each line on standard input is a command such as ``{"id": "1", "type": "prompt",
"message": "…"}``. Each gets one ``response`` line on standard output with the same
``id``; the work a prompt starts is reported as event lines (the ones ``--mode json``
writes) and ends with ``{"type": "agent_settled"}``. The commands follow pi's RPC mode
where Circle has the same thing; see docs/cli.md#rpc-mode.

Turns run one at a time on a worker thread, so ``steer``, ``abort`` and ``get_state``
answer while a turn runs. Nobody can approve a call here, so calls that would ask are
decided as in print mode (``--yolo`` runs them, except the ones Circle always asks about).

Background jobs are reported as ``{"type": "job", ...}`` events. When one the model started
ends while nothing runs, a turn starts for its notice (not after ``abort``, until the next
prompt); when standard input closes, Circle waits for such jobs as print mode does.
"""

from __future__ import annotations

import json
import logging
import queue
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, TextIO

from langchain_core.messages import AIMessage, ToolMessage, message_to_dict

from circle import session_index
from circle.headless import HeadlessRun, job_record, job_wait_seconds, new_thread_id
from circle.jobs import Job, JobRegistry
from circle.middleware.cancellation import CancellationToken
from circle.middleware.steering import SteeringInbox
from circle.model import EFFORT_LEVELS
from circle.tui.content_blocks import message_text
from circle.tui.replay import is_user_message

logger = logging.getLogger(__name__)

# A marker on the work queue: start a turn for the notices of finished background jobs
_NOTICES = object()


class RpcServer:
    """Reads commands, answers each, and runs prompts in order on a worker thread.

    ``make_run(thread_id)`` builds a ``HeadlessRun`` for a conversation (it is called
    again after ``set_model`` or ``set_thinking_level``, which rebuild the model)."""

    def __init__(self, make_run: Callable[[str], HeadlessRun], *, out: TextIO | None = None,
                 thread_id: str | None = None, title: str = "", home: Path | None = None,
                 remember: Callable[[HeadlessRun, str], None] | None = None,
                 list_models: Callable[[], list[str]] | None = None,
                 model_name: Callable[[], str] | None = None,
                 set_model: Callable[[str], None] | None = None,
                 jobs: JobRegistry | None = None) -> None:
        self._make_run = make_run
        self._home = home
        self._out = out or sys.stdout
        self._lock = threading.Lock()
        self._remember = remember
        self._list_models = list_models
        self._model_name = model_name or (lambda: "")
        self._set_model = set_model
        self._title = title
        self._inbox = SteeringInbox()
        self._follow_ups: list[str] = []
        self._work: queue.Queue[Any] = queue.Queue()
        self._busy = threading.Event()
        self._idle = threading.Condition()
        self._cancel: CancellationToken | None = None
        self._last_answer = ""
        # after abort, a finished job starts no turn until the next prompt
        self._jobs_hold = False
        self.run = self._new_run(thread_id or new_thread_id())
        self._jobs = jobs if jobs is not None else self.run.jobs
        if self._jobs is not None:
            self._jobs.subscribe(self._on_job)
        self._worker = threading.Thread(target=self._loop, name="circle-rpc", daemon=True)
        self._worker.start()

    # ── output ──────────────────────────────────────────────────────────────

    def emit(self, record: dict[str, Any]) -> None:
        with self._lock:
            self._out.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
            self._out.flush()

    def _respond(self, command: dict[str, Any], *, data: Any = None, error: str = "") -> None:
        record: dict[str, Any] = {"type": "response", "command": command.get("type", ""),
                                  "success": not error}
        if command.get("id") is not None:
            record["id"] = command["id"]
        if error:
            record["error"] = error
        elif data is not None:
            record["data"] = data
        self.emit(record)

    # ── the run ─────────────────────────────────────────────────────────────

    def _new_run(self, thread_id: str) -> HeadlessRun:
        run = self._make_run(thread_id)
        run.events = self.emit
        run.inbox = self._inbox
        return run

    def _on_job(self, event: str, job: Job) -> None:
        self.emit({"type": "job", "event": event, "job": job_record(job)})
        if event == "ended":
            self._wake()

    def _wake(self) -> None:
        """Start a turn for finished jobs' notices when nothing runs."""
        jobs = self._jobs
        if jobs is None or self._jobs_hold:
            return
        with self._idle:
            if self.streaming or not jobs.has_notices(self.run.thread_id):
                return
            if not any(n.wake for n in jobs.pending_notices(self.run.thread_id)):
                return
            self._busy.set()
            self._work.put(_NOTICES)

    def _notice_turn(self) -> str | None:
        jobs = self._jobs
        thread = self.run.thread_id
        deadline = time.monotonic() + 5
        # notices that arrive close together go in one turn
        while (jobs is not None and not jobs.notice_ready(thread)
               and time.monotonic() < deadline and jobs.has_notices(thread)):
            time.sleep(0.05)
        notices = jobs.take_notices(thread) if jobs is not None else []
        if not notices:
            return None
        return self.run.notice_turn(notices)

    def _loop(self) -> None:
        while True:
            text = self._work.get()
            if text is None:
                return
            self._busy.set()
            self._cancel = CancellationToken()
            self.run.cancel = self._cancel
            try:
                if text is _NOTICES:
                    answer = self._notice_turn()
                    if answer is not None:
                        self._last_answer = answer
                else:
                    self._last_answer = self.run.turn(text)
                    if self._remember is not None:
                        self._remember(self.run, self._title or text.strip().split("\n")[0])
                        self._title = ""
            except Exception as exc:  # noqa: BLE001 - reported as an event, the loop goes on
                if self._cancel.cancelled:
                    self.emit({"type": "turn_end", "aborted": True})
                else:
                    logger.warning("rpc turn failed", exc_info=True)
                    self.emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
            # What the model did not get to read is the next turn, then the follow-ups
            leftovers = [full for full, _shown in self._inbox.take()]
            if self._cancel.cancelled:
                leftovers = []  # abort drops what was waiting (clear_queue returns it first)
            with self._idle:
                for message in leftovers:
                    self._work.put(message)
                if self._work.empty() and self._follow_ups:
                    self._work.put(self._follow_ups.pop(0))
                if self._work.empty():
                    self._busy.clear()
                    self.emit({"type": "agent_settled"})
                    self._idle.notify_all()
            if not self._cancel.cancelled:
                self._wake()

    @property
    def streaming(self) -> bool:
        return self._busy.is_set()

    def _start(self, text: str) -> None:
        self._jobs_hold = False
        self._busy.set()
        self._work.put(text)

    def wait_idle(self, timeout: float | None = None) -> bool:
        with self._idle:
            return self._idle.wait_for(lambda: not self._busy.is_set(), timeout=timeout)

    def close(self) -> None:
        self._work.put(None)

    # ── commands ────────────────────────────────────────────────────────────

    def handle_line(self, line: str) -> None:
        line = line.rstrip("\r\n")
        if not line.strip():
            return
        try:
            command = json.loads(line)
            if not isinstance(command, dict):
                raise ValueError("a command is a JSON object")
        except ValueError as exc:
            self.emit({"type": "response", "command": "parse", "success": False,
                       "error": f"Failed to parse command: {exc}"})
            return
        kind = str(command.get("type") or "")
        handler = getattr(self, f"_cmd_{kind}", None)
        if handler is None:
            self._respond(command, error=f"Unknown command: {kind or '(none)'}")
            return
        try:
            handler(command)
        except Exception as exc:  # noqa: BLE001 - one bad command does not end the process
            logger.warning("rpc command %s failed", kind, exc_info=True)
            self._respond(command, error=f"{type(exc).__name__}: {exc}")

    def _message(self, command: dict[str, Any]) -> str | None:
        text = command.get("message")
        if not isinstance(text, str) or not text.strip():
            self._respond(command, error="message is required")
            return None
        return text

    def _cmd_prompt(self, command: dict[str, Any]) -> None:
        text = self._message(command)
        if text is None:
            return
        if self.streaming:
            behavior = command.get("streamingBehavior")
            if behavior == "steer":
                self._inbox.put(text)
            elif behavior == "followUp":
                self._follow_ups.append(text)
            else:
                self._respond(command, error="A turn is running; send streamingBehavior "
                                             "\"steer\" or \"followUp\" to queue the message")
                return
            self._respond(command, data={"disposition": "queued"})
            return
        self._start(text)
        self._respond(command, data={"disposition": "started"})

    def _cmd_steer(self, command: dict[str, Any]) -> None:
        text = self._message(command)
        if text is None:
            return
        if self.streaming:
            self._inbox.put(text)
            self._respond(command, data={"disposition": "queued"})
        else:
            self._start(text)
            self._respond(command, data={"disposition": "started"})

    def _cmd_follow_up(self, command: dict[str, Any]) -> None:
        text = self._message(command)
        if text is None:
            return
        if self.streaming:
            self._follow_ups.append(text)
            self._respond(command, data={"disposition": "queued"})
        else:
            self._start(text)
            self._respond(command, data={"disposition": "started"})

    def _cmd_abort(self, command: dict[str, Any]) -> None:
        if self._cancel is not None and self.streaming:
            self._jobs_hold = True
            self._cancel.cancel()
            self._follow_ups.clear()
            self.wait_idle(timeout=30)
        self._respond(command)

    def _cmd_list_jobs(self, command: dict[str, Any]) -> None:
        jobs = self._jobs.list() if self._jobs is not None else []
        self._respond(command, data={"jobs": [job_record(job) for job in jobs]})

    def _cmd_stop_job(self, command: dict[str, Any]) -> None:
        job_id = str(command.get("jobId") or "").strip()
        if not job_id or self._jobs is None:
            self._respond(command, error="jobId is required")
            return
        job = self._jobs.stop(job_id, by="user")
        if job is None:
            self._respond(command, error=f"No running job {job_id}")
            return
        self._respond(command, data={"job": job_record(job)})

    def _cmd_clear_queue(self, command: dict[str, Any]) -> None:
        steering = [full for full, _shown in self._inbox.take()]
        follow, self._follow_ups = self._follow_ups, []
        self._respond(command, data={"steering": steering, "followUp": follow})

    def _idle_only(self, command: dict[str, Any]) -> bool:
        if self.streaming:
            self._respond(command, error="A turn is running; wait for agent_settled or abort")
            return False
        return True

    def _cmd_new_session(self, command: dict[str, Any]) -> None:
        if not self._idle_only(command):
            return
        self.run = self._new_run(new_thread_id())
        self._last_answer = ""
        self._respond(command, data={"cancelled": False, "sessionId": self.run.thread_id})

    def _messages(self) -> list[Any]:
        state = self.run.agent.get_state(self.run.config)
        return list((getattr(state, "values", None) or {}).get("messages") or [])

    def _cmd_get_state(self, command: dict[str, Any]) -> None:
        self._respond(command, data={
            "model": self._model_name(),
            "thinkingLevel": _thinking(),
            "isStreaming": self.streaming,
            "sessionId": self.run.thread_id,
            "sessionName": self._session_name(),
            "messageCount": len(self._messages()),
            "pendingMessageCount": len(self._inbox) + len(self._follow_ups),
        })

    def _session_name(self) -> str:
        found = None
        try:
            found = session_index.find(self._home, self.run.thread_id)
        except Exception:  # noqa: BLE001
            logger.debug("session index unavailable", exc_info=True)
        return found.title if found is not None and found.thread_id == self.run.thread_id else ""

    def _cmd_get_messages(self, command: dict[str, Any]) -> None:
        self._respond(command, data={"messages": [message_to_dict(m) for m in self._messages()]})

    def _cmd_get_last_assistant_text(self, command: dict[str, Any]) -> None:
        text = self._last_answer
        if not text:
            for msg in reversed(self._messages()):
                if isinstance(msg, AIMessage) and message_text(msg.content).strip():
                    text = message_text(msg.content).strip()
                    break
        self._respond(command, data={"text": text})

    def _cmd_get_session_stats(self, command: dict[str, Any]) -> None:
        messages = self._messages()
        answers = [m for m in messages if isinstance(m, AIMessage)]
        self._respond(command, data={
            "sessionId": self.run.thread_id,
            "userMessages": sum(1 for m in messages if is_user_message(m)),
            "assistantMessages": len(answers),
            "toolCalls": sum(len(m.tool_calls or []) for m in answers),
            "toolResults": sum(1 for m in messages if isinstance(m, ToolMessage)),
            "totalMessages": len(messages),
            "tokens": {"input": self.run.tokens_in, "output": self.run.tokens_out,
                       "total": self.run.tokens_in + self.run.tokens_out},
        })

    def _cmd_set_session_name(self, command: dict[str, Any]) -> None:
        name = " ".join(str(command.get("name") or "").split())
        if not name:
            self._respond(command, error="name is required")
            return
        self._title = name
        if self._remember is not None:
            self._remember(self.run, name)
            self._title = ""
        self._respond(command)

    def _cmd_get_available_models(self, command: dict[str, Any]) -> None:
        models = self._list_models() if self._list_models is not None else []
        self._respond(command, data={"models": models})

    def _cmd_set_model(self, command: dict[str, Any]) -> None:
        if not self._idle_only(command):
            return
        name = str(command.get("modelId") or command.get("model") or "").strip()
        if not name or self._set_model is None:
            self._respond(command, error="modelId is required")
            return
        self._set_model(name)
        self.run = self._rebuilt()
        self._respond(command, data={"model": self._model_name()})

    def _cmd_set_thinking_level(self, command: dict[str, Any]) -> None:
        if not self._idle_only(command):
            return
        import os

        level = str(command.get("level") or "").strip().lower()
        if level not in EFFORT_LEVELS:
            self._respond(command, error=f"level is one of {', '.join(EFFORT_LEVELS)}")
            return
        os.environ["CIRCLE_REASONING_EFFORT"] = level
        self.run = self._rebuilt()
        self._respond(command, data={"thinkingLevel": level})

    def _rebuilt(self) -> HeadlessRun:
        tokens = (self.run.tokens_in, self.run.tokens_out)
        run = self._new_run(self.run.thread_id)
        run.tokens_in, run.tokens_out = tokens
        return run

    def _cmd_export_html(self, command: dict[str, Any]) -> None:
        from circle.session_export import SessionMeta, to_html

        target = Path(str(command.get("outputPath") or f"{self.run.thread_id}.html")).expanduser()
        target.write_text(to_html(self._messages(), SessionMeta(
            thread_id=self.run.thread_id, title=self._session_name(), model=self._model_name())),
            encoding="utf-8")
        self._respond(command, data={"path": str(target)})

    # ── the process ─────────────────────────────────────────────────────────

    def serve(self, stdin: TextIO) -> int:
        """Until standard input closes: the current turn is finished, background jobs the
        model started get up to ``CIRCLE_JOB_WAIT`` seconds (their notices become turns),
        then the rest are stopped and Circle exits."""
        for line in stdin:
            self.handle_line(line)
        self.wait_idle()
        # After abort nothing more is wanted from finished jobs: stop them at once
        self._settle_jobs(0.0 if self._jobs_hold else job_wait_seconds())
        self.close()
        return 0

    def _settle_jobs(self, limit: float) -> None:
        jobs = self._jobs
        if jobs is None:
            return
        deadline = time.monotonic() + limit
        while time.monotonic() < deadline:
            self.wait_idle()
            waiting = [j for j in jobs.list(self.run.thread_id)
                       if j.running and j.started_by == "model" and j.kind != "adopted"]
            if not waiting and not any(n.wake for n in jobs.pending_notices(self.run.thread_id)):
                break
            jobs.wait_for_change(0.25)
        self.wait_idle()
        count = jobs.stop_all()
        self.emit({"type": "jobs_stopped", "count": count})


def _thinking() -> str:
    import os

    return (os.environ.get("CIRCLE_REASONING_EFFORT") or "").strip()
