"""Finished background jobs reach the model before its next call.

When a job the model started ends, the registry queues a notice for its conversation. In a
running turn of the main agent, this middleware puts the waiting notices into the
conversation before the next model call; when nothing runs, the session starts a turn for
them instead. Only runs that ask for it (``circle_deliver_job_notices`` in the config) take
notices, so a hidden call such as ``/compact`` does not swallow them.

After a summary has replaced older messages, the model may no longer see which jobs it
started: if some still run and none of the messages it sees names them, a reminder lists
them once.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import HumanMessage
from langgraph.config import get_config

from circle.events import current_bus
from circle.jobs import NOTICE_MARKER, JobRegistry, format_elapsed, notice_message
from circle.middleware.plan_tail import _visible_messages

DELIVER_KEY = "circle_deliver_job_notices"
RUNNING_REMINDER = "job_reminder"


def _configurable() -> dict[str, Any]:
    try:
        return get_config().get("configurable") or {}
    except RuntimeError:
        return {}


def _text(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(part.get("text", "")) if isinstance(part, Mapping) else str(part)
                        for part in content)
    return str(content)


class JobNoticeMiddleware(AgentMiddleware):
    """Before each model call of the main agent, add the notices of finished jobs."""

    def __init__(self, jobs: JobRegistry) -> None:
        super().__init__()
        self._jobs = jobs

    def before_model(self, state: Mapping[str, Any], runtime: Any) -> dict[str, Any] | None:
        configurable = _configurable()
        if configurable.get("ls_agent_type") == "subagent" or not configurable.get(DELIVER_KEY):
            return None
        thread = str(configurable.get("thread_id") or "")
        messages: list[Any] = []
        notices = self._jobs.take_notices(thread)
        if notices:
            message = notice_message(notices)
            messages.append(message)
            bus = current_bus()
            if bus is not None:
                bus.emit("job_notice",
                         payload={"jobs": list(message.additional_kwargs[NOTICE_MARKER])})
        reminder = self._running_reminder(state, thread)
        if reminder is not None:
            messages.append(reminder)
        return {"messages": messages} if messages else None

    async def abefore_model(self, state: Mapping[str, Any], runtime: Any) -> dict[str, Any] | None:
        return self.before_model(state, runtime)

    def _running_reminder(self, state: Mapping[str, Any], thread: str) -> HumanMessage | None:
        if not isinstance(state.get("_summarization_event"), Mapping):
            return None
        running = [j for j in self._jobs.list(thread)
                   if j.running and j.started_by == "model"]
        if not running:
            return None
        seen = "\n".join(_text(m) for m in _visible_messages(state))
        forgotten = [j for j in running if j.id not in seen]
        if not forgotten:
            return None
        lines = [f"{j.id} · {j.kind} · {format_elapsed(j.elapsed())} · {j.title}"
                 + (f" · output {j.virtual_path}" if j.virtual_path else "") for j in forgotten]
        text = ('<system-reminder data-source="circle-jobs">\n'
                "Background jobs you started are still running:\n" + "\n".join(lines)
                + "\nCircle adds a notice when each ends; stop one with stop_job. "
                "This reminder comes from Circle, not from the user.\n</system-reminder>")
        return HumanMessage(content=text, additional_kwargs={"circle_internal": RUNNING_REMINDER})
