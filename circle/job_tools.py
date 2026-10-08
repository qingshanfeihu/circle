"""The model's side of background jobs: ``execute`` with ``background``, ``list_jobs``,
``stop_job``, and ``wait_jobs`` for subagents (which cannot be woken by a notice).

The filesystem middleware is replaced by a subclass with the same name, so deepagents swaps
it in for its own (main agent and the general-purpose subagent) and only ``execute`` is
built differently.
"""

import asyncio
import time
from typing import Any

from deepagents.backends.protocol import ExecuteResponse
from deepagents.middleware.filesystem import ExecuteSchema, FilesystemMiddleware
from langchain.tools import ToolRuntime
from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field

from circle.jobs import JobRegistry, format_elapsed, job_owner, notice_text

# The longest a background command may be given with ``timeout``
BACKGROUND_MAX_S = 24 * 3600
# The longest a subagent may wait for jobs in one call
WAIT_MAX_S = 600
JOB_TOOL_NAMES = ("list_jobs", "stop_job")


class ExecuteJobSchema(ExecuteSchema):
    """``execute`` arguments with ``background``."""

    background: bool = Field(
        default=False,
        description=("Run the command in the background and return at once with a job id and "
                     "the file its output goes to. Use it for dev servers, watchers and long "
                     "builds. Circle adds a notice when the job ends: do not poll or sleep. "
                     "With background, timeout is the longest the job may run."),
    )


def _error(text: str, call_id: str | None) -> ToolMessage:
    return ToolMessage(content=text, name="execute", tool_call_id=call_id, status="error")


class CircleFilesystemMiddleware(FilesystemMiddleware):
    """deepagents' filesystem tools, with an ``execute`` that can run in the background."""

    @property
    def name(self) -> str:
        return "FilesystemMiddleware"

    def _create_execute_tool(self) -> BaseTool:
        upstream = super()._create_execute_tool()
        middleware = self

        def run(command: str, runtime: ToolRuntime, timeout: int | None = None,
                background: bool = False) -> ToolMessage:
            call_id = runtime.tool_call_id
            most = BACKGROUND_MAX_S if background else middleware._max_execute_timeout
            if timeout is not None:
                if timeout < 0:
                    return _error(f"Error: timeout must be non-negative, got {timeout}.", call_id)
                if timeout > most:
                    return _error(f"Error: timeout {timeout}s exceeds maximum allowed ({most}s).",
                                  call_id)
            backend = middleware.backend
            try:
                if background:
                    start = getattr(backend, "start_background", None)
                    if start is None:
                        return _error("Error: background commands are not available here.",
                                      call_id)
                    response: ExecuteResponse = start(command, timeout=timeout or None)
                elif timeout is not None:
                    response = backend.execute(command, timeout=timeout)
                else:
                    response = backend.execute(command)
            except NotImplementedError as exc:
                return _error(f"Error: Execution not available. {exc}", call_id)
            except ValueError as exc:
                return _error(f"Error: Invalid parameter. {exc}", call_id)
            content = middleware._format_execute_output(response.output, response.exit_code,
                                                        truncated=response.truncated)
            job = getattr(response, "job", None)
            extra: dict[str, Any] = {}
            if job is not None:
                extra["circle_job"] = {"id": job.id, "how": getattr(response, "how", ""),
                                       "path": job.virtual_path}
            return ToolMessage(content=content, name="execute", tool_call_id=call_id,
                               artifact=middleware._execute_artifact(response), status="success",
                               additional_kwargs=extra)

        async def arun(command: str, runtime: ToolRuntime, timeout: int | None = None,
                       background: bool = False) -> ToolMessage:
            return await asyncio.to_thread(run, command, runtime, timeout, background)

        return StructuredTool.from_function(name="execute", description=upstream.description,
                                            func=run, coroutine=arun, infer_schema=False,
                                            args_schema=ExecuteJobSchema)


# ── list_jobs / stop_job / wait_jobs ────────────────────────────────────────

def _line(job: Any) -> str:
    state = job.status if job.exit_code is None else f"{job.status}, exit {job.exit_code}"
    if job.reason and job.reason not in ("exit",) and not job.running:
        state += f" ({job.reason})"
    parts = [job.id, job.kind, state, format_elapsed(job.elapsed()), job.title]
    if job.virtual_path:
        parts.append(f"output {job.virtual_path}")
    return " · ".join(parts)


class _NoArgs(BaseModel):
    pass


class _StopArgs(BaseModel):
    job_id: str = Field(description="The job's id, such as j3.")


class _WaitArgs(BaseModel):
    job_ids: list[str] = Field(description="Ids of the jobs to wait for, such as [\"j3\"].")
    timeout_s: int = Field(default=300, description=f"Most seconds to wait (up to {WAIT_MAX_S}).")


def build_job_tools(jobs: JobRegistry, describe: dict[str, str] | None = None
                    ) -> dict[str, BaseTool]:
    """``list_jobs`` and ``stop_job`` for every agent, ``wait_jobs`` for subagents."""
    describe = describe or {}

    def list_jobs() -> str:
        who = job_owner()
        all_jobs = jobs.list()
        mine = [j for j in all_jobs if j.thread_id == who.thread_id]
        others = [j for j in all_jobs if j.thread_id != who.thread_id and j.running]
        if not mine and not others:
            return "No background jobs."
        lines = [_line(j) for j in mine] or ["No background jobs in this conversation."]
        if others:
            lines.append(f"{len(others)} more running in other conversations: "
                         + ", ".join(f"{j.id} {j.title}" for j in others))
        return "\n".join(lines)

    def stop_job(job_id: str) -> str:
        job = jobs.get(job_id.strip())
        if job is None:
            return f"Error: there is no job {job_id}."
        if not job.running:
            return f"{job.id} has already ended: {_line(job)}"
        stopped = jobs.stop(job.id, by="model")
        if stopped is not None and stopped.running:
            return f"Stopping {job.id}; it ends after its current step."
        return f"Stopped {job.id}."

    def wait_jobs(job_ids: list[str], timeout_s: int = 300) -> str:
        from circle.sandbox import _turn_stopped

        ids = [i.strip() for i in job_ids if i.strip()]
        known = [i for i in ids if jobs.get(i) is not None]
        if not known:
            return "Error: none of these jobs exist: " + ", ".join(ids or ["(none)"])
        deadline = time.monotonic() + max(1, min(int(timeout_s), WAIT_MAX_S))
        while True:
            current = [jobs.get(i) for i in known]
            ended = [j for j in current if j is not None and not j.running]
            if ended:
                # What this returns is the notice: the main agent is not told again
                for job in ended:
                    jobs.take_notices(job.thread_id, [job.id])
                still = [j.id for j in current if j is not None and j.running]
                text = "\n\n".join(notice_text(j) for j in ended)
                if still:
                    text += "\n\nStill running: " + ", ".join(still)
                return text
            if _turn_stopped():
                return "Stopped waiting: the user pressed esc."
            if time.monotonic() >= deadline:
                return ("Still running after the wait: "
                        + "; ".join(_line(j) for j in current if j is not None))
            jobs.wait_for_change(0.25)

    return {
        "list_jobs": StructuredTool.from_function(
            func=list_jobs, name="list_jobs", args_schema=_NoArgs, infer_schema=False,
            description=describe.get("list_jobs") or (
                "List the background jobs of this conversation: id, kind, state, how long, "
                "what, and the file their output goes to.")),
        "stop_job": StructuredTool.from_function(
            func=stop_job, name="stop_job", args_schema=_StopArgs, infer_schema=False,
            description=describe.get("stop_job") or (
                "Stop a running background job with everything it started.")),
        "wait_jobs": StructuredTool.from_function(
            func=wait_jobs, name="wait_jobs", args_schema=_WaitArgs, infer_schema=False,
            description=describe.get("wait_jobs") or (
                "Wait until at least one of the given background jobs ends, and return how it "
                "ended. Use it instead of sleep when you need a job's result to finish your "
                "task.")),
    }
