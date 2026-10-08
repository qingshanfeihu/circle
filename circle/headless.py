"""Run turns without the full-screen interface: ``circle -p`` and line mode.

Nobody can answer an approval card here, so every call that would ask is decided by a
fixed rule. Without ``--yolo`` it is not run and the model is told why. With ``--yolo``
it runs, except the calls Circle always asks about (deleting, ``rm -rf``, force-push),
which are still not run. Commands the policy refuses are refused by the backend as in a
session. The answer goes to stdout; tool activity goes to stderr when asked for.
"""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TextIO

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from circle.display_lexicon import tool_arg_summary, tool_short_name
from circle.jobs import Job, Notice, format_elapsed, is_job_notice, notice_message
from circle.middleware.job_notice import DELIVER_KEY
from circle.middleware.loop_guard import is_loop_reminder
from circle.middleware.plan_tail import is_plan_reminder
from circle.middleware.steering import is_steering
from circle.tui.content_blocks import message_text

NOT_ASKED = (
    "Not run: Circle is running without a terminal, so nobody can approve shell commands "
    "or file changes, and retrying them will not help. The ls, read_file, glob and grep "
    "tools need no approval: use them to look at files. Finish with what you can do that "
    "way, and say what you would have run or changed."
)
ALWAYS_ASKED = (
    "Not run: Circle always asks a person before this kind of call, and nobody can "
    "answer here. Do not try it again in another form; say what you would have done."
)


def job_wait_seconds() -> float:
    """How long print mode waits, after its answer, for background jobs the model started
    (``CIRCLE_JOB_WAIT``, 1800 by default; 0 does not wait)."""
    try:
        return max(0.0, float(os.environ.get("CIRCLE_JOB_WAIT", "1800")))
    except ValueError:
        return 1800.0


def job_record(job: Job) -> dict[str, Any]:
    """A job as a JSON event or an RPC answer shows it."""
    return {"id": job.id, "kind": job.kind, "title": job.title, "status": job.status,
            "reason": job.reason, "exitCode": job.exit_code, "startedBy": job.started_by,
            "elapsed": round(job.elapsed(), 1), "output": job.virtual_path or job.output_path,
            "sessionId": job.thread_id}


class HeadlessStop(RuntimeError):
    """The turn paused for something only a person can give."""


def new_thread_id() -> str:
    return f"circle-{uuid.uuid4().hex[:8]}"


@dataclass
class HeadlessRun:
    """One conversation thread driven turn by turn."""

    agent: Any
    thread_id: str = field(default_factory=new_thread_id)
    yolo: bool = False
    progress: TextIO | None = None
    # --no-session: kept in memory, not added to the folder's list
    no_session: bool = False
    # --mode json: each step as a dict, for a program reading standard output
    events: Callable[[dict[str, Any]], None] | None = None
    # --mode rpc: messages to read before the next model call, and a way to stop the turn
    inbox: Any = None
    cancel: Any = None
    # The checkpoint /tree took the conversation back to: the next turn branches from it
    start_from: str | None = None
    not_run: int = 0
    stopped_at_deadline: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    _calls: dict[str, str] = field(default_factory=dict)
    _seen: set[str] = field(default_factory=set)

    @property
    def config(self) -> dict[str, Any]:
        return {"configurable": {"thread_id": self.thread_id}}

    @property
    def jobs(self) -> Any:
        return getattr(self.agent, "_circle_jobs", None)

    def _run_config(self) -> dict[str, Any]:
        # Finished background jobs reach the model before its next call in this run
        config: dict[str, Any] = {"configurable": {"thread_id": self.thread_id,
                                                   DELIVER_KEY: True}}
        start, self.start_from = self.start_from, None
        if start:
            config["configurable"]["checkpoint_id"] = start
        if self.inbox is not None:
            config["configurable"]["circle_inbox"] = self.inbox
        if self.cancel is not None:
            from circle.tui.progress_handler import CancellationHandler

            config["configurable"]["circle_cancel_token"] = self.cancel
            config["callbacks"] = [CancellationHandler(self.cancel)]
        return config

    def turn(self, text: str) -> str:
        """Run one user message to the end and return the final answer text."""
        self._emit({"type": "turn_start", "message": text})
        return self._turn({"messages": [{"role": "user", "content": text}]})

    def notice_turn(self, notices: list[Notice]) -> str:
        """A turn for Circle's notice that background jobs ended."""
        ids = [n.job.id for n in notices]
        self._emit({"type": "turn_start", "jobNotice": ids})
        for notice in notices:
            job = notice.job
            self._say(f"◆ {job.id} {job.status} · {job.title} · {format_elapsed(job.elapsed())}")
        return self._turn({"messages": [notice_message(notices)]})

    def _model_jobs(self) -> list[Job]:
        """Jobs the model started in this conversation that are expected to end."""
        jobs = self.jobs
        if jobs is None:
            return []
        return [j for j in jobs.list(self.thread_id)
                if j.running and j.started_by == "model" and j.kind != "adopted"]

    def settle_jobs(self, limit: float) -> str | None:
        """Print mode, after the answer: while background jobs the model started run (up
        to ``limit`` seconds), turn their notices into turns. Processes left running by a
        command (``cmd &``, usually a server) are stopped at once. Returns the last answer
        of such a turn, or None when none ran."""
        jobs = self.jobs
        if jobs is None:
            return None
        for job in jobs.list(self.thread_id):
            if job.running and job.kind == "adopted":
                jobs.stop(job.id, by="circle")
        deadline = time.monotonic() + limit
        answer = None
        while True:
            waiting = self._model_jobs()
            if jobs.notice_ready(self.thread_id) or (jobs.has_notices(self.thread_id)
                                                    and not waiting):
                notices = jobs.take_notices(self.thread_id)
                if any(n.wake for n in notices):
                    answer = self.notice_turn(notices)
                    continue
            if not waiting:
                return answer
            if time.monotonic() >= deadline:
                count = jobs.stop_all()
                self._emit({"type": "jobs_stopped", "count": count, "reason": "CIRCLE_JOB_WAIT"})
                self.stopped_at_deadline = count
                return answer
            jobs.wait_for_change(0.25)

    def _turn(self, payload: Any) -> str:
        while True:
            for update in self.agent.stream(payload, config=self._run_config(),
                                            stream_mode="updates"):
                self._report(update)
            state = self.agent.get_state(self.config)
            interrupts = tuple(getattr(state, "interrupts", None) or ())
            if not interrupts:
                answer = self._answer(state)
                self._emit({"type": "turn_end", "answer": answer,
                            "usage": {"input_tokens": self.tokens_in,
                                      "output_tokens": self.tokens_out}})
                return answer
            payload = Command(resume={item.id: self._decide(item.value) for item in interrupts})

    def _emit(self, event: dict[str, Any]) -> None:
        if self.events is not None:
            self.events(event)

    def decide_for_job(self, job: Any, value: Any) -> dict[str, Any]:
        """A background agent's approvals, by the same rule as the turn's."""
        return self._decide(value, who=f"{job.id} · ")

    def _decide(self, value: Any, who: str = "") -> dict[str, Any]:
        requests = value.get("action_requests") if isinstance(value, dict) else None
        if not isinstance(requests, list) or not requests:
            raise HeadlessStop("the task asked for input that only the full-screen "
                               "interface can give; run circle without -p")
        policy = getattr(self.agent, "_circle_approvals", None)
        decisions = []
        for request in requests:
            name = str(request.get("name") or "")
            args = request.get("args")
            forced = policy is not None and policy.review(name, args).verdict == "ASK_FORCED"
            if self.yolo and not forced:
                decisions.append({"type": "approve"})
                continue
            self.not_run += 1
            call = f"{tool_short_name(name)}({tool_arg_summary(name, args)})"
            self._say(f"  ⎿ {who}{call} not run · {'always asks' if forced else 'needs --yolo'}")
            event = {"type": "not_run", "name": name, "args": args,
                     "reason": "always asks" if forced else "needs --yolo"}
            if who:
                event["job"] = who.split(" ", 1)[0]
            self._emit(event)
            decisions.append({"type": "reject", "message": ALWAYS_ASKED if forced else NOT_ASKED})
        return {"decisions": decisions}

    def _report(self, update: Any) -> None:
        if not isinstance(update, dict):
            return
        for node, node_update in update.items():
            messages = node_update.get("messages") if isinstance(node_update, dict) else None
            for msg in messages or ():
                if is_plan_reminder(msg) or is_loop_reminder(msg):
                    continue
                if is_job_notice(msg):
                    if node != "__start__":
                        jobs = (msg.additional_kwargs or {}).get("circle_job_notice") or []
                        self._emit({"type": "job_notice", "jobs": jobs})
                        for job in jobs:
                            self._say(f"◆ {job.get('id')} {job.get('status')} · {job.get('title')}")
                    continue
                if isinstance(msg, HumanMessage) and (msg.additional_kwargs or {}).get(
                        "circle_internal"):
                    continue
                if isinstance(msg, AIMessage):
                    if msg.id and msg.id in self._seen:
                        continue  # the approval step sends the same message again
                    if msg.id:
                        self._seen.add(msg.id)
                    usage = msg.usage_metadata or {}
                    self.tokens_in += int(usage.get("input_tokens") or 0)
                    self.tokens_out += int(usage.get("output_tokens") or 0)
                    if self.events is not None:
                        self._emit({
                            "type": "assistant", "id": msg.id or "",
                            "text": message_text(msg.content).strip(),
                            "tool_calls": [{"id": str(c.get("id") or ""), "name": c.get("name"),
                                            "args": c.get("args")} for c in msg.tool_calls or ()],
                            "usage": {"input_tokens": int(usage.get("input_tokens") or 0),
                                      "output_tokens": int(usage.get("output_tokens") or 0)},
                        })
                    for call in msg.tool_calls or ():
                        call_id = str(call.get("id") or "")
                        if call_id and call_id in self._calls:
                            continue  # the approval step sends the same call again
                        name = str(call.get("name") or "")
                        summary = tool_arg_summary(name, call.get("args"))
                        self._calls[call_id] = name
                        self._say(f"● {tool_short_name(name)}({summary})")
                elif isinstance(msg, HumanMessage) and is_steering(msg) and self.events is not None:
                    self._emit({"type": "steer", "message": message_text(msg.content)})
                elif isinstance(msg, ToolMessage) and self.events is not None:
                    self._emit({"type": "tool_result", "id": msg.tool_call_id,
                                "name": msg.name or "", "status": msg.status or "success",
                                "output": message_text(msg.content)})
                if isinstance(msg, ToolMessage) and getattr(msg, "status", "") == "error":
                    text = (message_text(msg.content) or "").strip()
                    if NOT_ASKED in text or ALWAYS_ASKED in text:
                        continue  # already shown as "not run"
                    first = text.splitlines()
                    self._say(f"  ⎿ {first[0][:100] if first else 'failed'}")

    def _answer(self, state: Any) -> str:
        values = getattr(state, "values", None) or {}
        for msg in reversed(values.get("messages") or []):
            if isinstance(msg, AIMessage):
                return message_text(msg.content).strip()
        return ""

    def _say(self, line: str) -> None:
        if self.progress is not None:
            print(line, file=self.progress, flush=True)

    def summary(self) -> str:
        parts = [f"↑ {_short(self.tokens_in)} · ↓ {_short(self.tokens_out)}"]
        if self.not_run:
            calls = "call" if self.not_run == 1 else "calls"
            hint = "" if self.yolo else " (use --yolo to allow commands and edits)"
            parts.append(f"{self.not_run} {calls} not run{hint}")
        return " · ".join(parts)


def _short(n: int) -> str:
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)
