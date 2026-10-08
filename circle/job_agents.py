"""Subagents in the background: ``task`` with ``background: true`` starts the subagent as a
job and returns at once; its report reaches the model as a notice when it ends.

deepagents builds the ``task`` tool and compiles the subagents inside it, so this module
reads them from the built tool (``task_internals``; if that ever fails, ``background`` is
simply not offered). A background run uses the same compiled graph with a checkpointer of
its own, so it can stop for an approval and go on after the answer: the runner asks the
session's host (cards in the full-screen interface, the print-mode rule elsewhere) and
resumes with the reply, by interrupt id.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from collections.abc import Callable
from typing import Any, Protocol

from langchain.agents.middleware.types import AgentMiddleware
from langchain.tools import ToolRuntime
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command
from pydantic import Field

from deepagents.middleware.subagents import TaskToolSchema

from circle.jobs import Job, JobRegistry, Owner, job_owner
from circle.middleware.cancellation import CancellationToken

try:
    from langgraph._internal._constants import CONFIG_KEY_CHECKPOINTER, CONFIG_KEY_DURABILITY
except ImportError:  # pragma: no cover - the keys have had these values since langgraph 0.6
    CONFIG_KEY_CHECKPOINTER = "__pregel_checkpointer"
    CONFIG_KEY_DURABILITY = "__pregel_durability"

logger = logging.getLogger(__name__)

# Background agents running (or waiting for you) at once
MAX_BACKGROUND_AGENTS = 4
# The longest report a notice carries; the whole of it is in the job's file
REPORT_CHARS = 20_000

BACKGROUND_NOTE = (
    "\n\nWith background: true the subagent runs as a background job: the call returns at "
    "once with its job id, you keep working, and Circle adds its report to the conversation "
    "when it ends. Do not wait, poll or sleep for it. A background subagent cannot start "
    "another background subagent.")


class BackgroundUnavailable(RuntimeError):
    """The built ``task`` tool does not have the shape this module reads."""


class TaskWithBackground(TaskToolSchema):
    background: bool = Field(
        default=False,
        description=("Run the subagent in the background and return at once with a job id; "
                     "Circle adds its report when it ends. For independent work you do not "
                     "need before your next step."))


def task_internals(tool: Any) -> tuple[Callable[..., Any], dict[str, Any]]:
    """``(prepare, graphs)`` from deepagents' built ``task`` tool: the function that turns a
    task into a subagent's input state, and the compiled subagents by name."""
    func = getattr(tool, "func", None)
    code = getattr(func, "__code__", None)
    closure = getattr(func, "__closure__", None)
    if code is None or not closure:
        raise BackgroundUnavailable("task has no closure")
    try:
        cells = dict(zip(code.co_freevars, (cell.cell_contents for cell in closure), strict=True))
    except ValueError as exc:
        raise BackgroundUnavailable(str(exc)) from None
    prepare = cells.get("_validate_and_prepare_state")
    graphs = cells.get("subagent_graphs")
    if not callable(prepare) or not isinstance(graphs, dict):
        raise BackgroundUnavailable("task no longer holds its subagents")
    return prepare, graphs


class ApprovalHost(Protocol):
    """Who answers a background agent that stopped for approval or a question."""

    def ask(self, job: Job, interrupts: list[Any], answer: Callable[[Any], None]) -> None:
        """Present ``interrupts`` and call ``answer(resume value)`` once (from any thread)."""

    def withdraw(self, job: Job) -> None:
        """The job was stopped while it waited: take its question down."""


def _report(state: Any) -> str:
    values = getattr(state, "values", None) or {}
    structured = values.get("structured_response") if isinstance(values, dict) else None
    if structured is not None:
        dump = getattr(structured, "model_dump_json", None)
        return dump() if callable(dump) else str(structured)
    for message in reversed((values.get("messages") if isinstance(values, dict) else None) or []):
        if isinstance(message, AIMessage):
            text = (message.text or "").strip() if hasattr(message, "text") else ""
            if text:
                return text
    return ""


class _Progress(BaseCallbackHandler):
    """What a background agent does, one line per tool call in its output file, and its
    current step on the job's row."""

    raise_error = False

    def __init__(self, runner: AgentJobRunner) -> None:
        self._runner = runner
        self._names: dict[str, str] = {}

    def on_tool_start(self, serialized: dict[str, Any] | None, input_str: str, *,
                      run_id: Any = None, inputs: dict[str, Any] | None = None,
                      **kwargs: Any) -> None:
        from circle.display_lexicon import tool_arg_summary, tool_short_name

        name = str((serialized or {}).get("name") or kwargs.get("name") or "tool")
        self._names[str(run_id)] = name
        summary = tool_arg_summary(name, inputs or {})
        self._runner.step(f"{tool_short_name(name)}({summary})")

    def on_tool_end(self, output: Any, *, run_id: Any = None, **kwargs: Any) -> None:
        text = getattr(output, "content", output)
        first = str(text or "").strip().splitlines()
        self._runner.log(f"  ⎿ {first[0][:200] if first else '(no output)'}")

    def on_tool_error(self, error: BaseException, *, run_id: Any = None, **kwargs: Any) -> None:
        self._runner.log(f"  ⎿ error: {str(error).splitlines()[0][:200] if str(error) else type(error).__name__}")

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        from circle.pricing import price_call, response_model_name
        from circle.tui.progress_handler import extract_llm_usage

        usage = extract_llm_usage(response)
        if usage:
            self._runner.add_usage(usage, price_call(response_model_name(response), usage))


_STOP = object()


class AgentJobRunner:
    """One background subagent: runs its graph on a thread of its own, stops for approvals
    and questions until the host answers, and ends the job with the report."""

    def __init__(self, *, jobs: JobRegistry, graph: Any, state: dict[str, Any],
                 subagent_type: str, owner: Owner, host: ApprovalHost | None,
                 policy: Any = None, recursion_limit: int | None = None,
                 on_usage: Callable[[dict[str, Any], dict[str, Any]], None] | None = None
                 ) -> None:
        self.jobs = jobs
        self.graph = graph
        self.state = state
        self.subagent_type = subagent_type
        self.owner = owner
        self.host = host
        self.policy = policy
        self.recursion_limit = recursion_limit
        self.on_usage = on_usage
        self.token = CancellationToken()
        self.job: Job | None = None
        self._answers: queue.Queue[Any] = queue.Queue()
        self._waiting = False
        self._lock = threading.Lock()
        self.tokens_in = 0
        self.tokens_out = 0

    # the job's file and row

    def log(self, line: str) -> None:
        job = self.job
        if job is None or not job.output_path:
            return
        try:
            with open(job.output_path, "a", encoding="utf-8") as handle:
                handle.write(line.rstrip("\n") + "\n")
        except OSError:
            pass

    def step(self, what: str) -> None:
        self.log(f"● {what}")
        if self.job is not None:
            self.jobs.update(self.job.id, detail=what)

    def add_usage(self, usage: dict[str, Any], cost: dict[str, Any]) -> None:
        self.tokens_in += int(usage.get("input_tokens") or 0)
        self.tokens_out += int(usage.get("output_tokens") or 0)
        if self.on_usage is not None:
            try:
                self.on_usage(usage, cost)
            except Exception:  # noqa: BLE001 - the meter is not worth the run
                logger.debug("usage hook failed", exc_info=True)

    # running

    @property
    def thread_id(self) -> str:
        return f"{self.owner.thread_id}:job:{self.job.id if self.job else '?'}"

    def _config(self) -> dict[str, Any]:
        from circle.tui.progress_handler import CancellationHandler

        configurable: dict[str, Any] = {
            "thread_id": self.thread_id,
            "circle_rules_thread": self.owner.thread_id,
            "circle_cancel_token": self.token,
            "circle_job": self.job.id if self.job else None,
            "ls_agent_type": "subagent",
            CONFIG_KEY_CHECKPOINTER: self._saver,
            CONFIG_KEY_DURABILITY: "sync",
        }
        if self.host is not None:
            # Approvals follow /yolo as in the visible turn (a card answers the rest)
            configurable["circle_visible_turn"] = True
        config: dict[str, Any] = {"configurable": configurable,
                                  "callbacks": [CancellationHandler(self.token), _Progress(self)],
                                  "metadata": {"lc_agent_name": self.subagent_type}}
        if self.recursion_limit:
            config["recursion_limit"] = self.recursion_limit
        return config

    def start(self, job: Job) -> None:
        self.job = job
        self._saver = MemorySaver()
        self.log(f"Background {self.subagent_type} agent {job.id}: {job.title}")
        threading.Thread(target=self._run, name=f"circle-agent-{job.id}", daemon=True).start()

    def stop(self) -> None:
        """Stop the run: the current tool's command ends, the next step does not start, and
        a question it waits on is taken down."""
        self.token.cancel()
        with self._lock:
            waiting = self._waiting
        if waiting:
            if self.host is not None and self.job is not None:
                try:
                    self.host.withdraw(self.job)
                except Exception:  # noqa: BLE001
                    logger.debug("withdraw failed", exc_info=True)
            self._answers.put(_STOP)

    def answer(self, value: Any) -> None:
        self._answers.put(value)

    def _run(self) -> None:
        assert self.job is not None
        job_id = self.job.id
        if self.policy is not None:
            self.policy.begin_visible_turn(self.thread_id)
        payload: Any = self.state
        try:
            while True:
                if self.token.cancelled:
                    self._finish_stopped()
                    return
                config = self._config()
                for _update in self.graph.stream(payload, config=config, stream_mode="updates"):
                    if self.token.cancelled:
                        break
                if self.token.cancelled:
                    self._finish_stopped()
                    return
                state = getattr(self.graph, "bound", self.graph).get_state(config)
                interrupts = list(getattr(state, "interrupts", None) or ())
                if not interrupts:
                    report = _report(state)
                    self.log("")
                    self.log(report or "(no report)")
                    summary = report[:REPORT_CHARS] + ("\n… (cut; the whole report is in the "
                                                       "job's file)" if len(report) > REPORT_CHARS
                                                       else "")
                    self.jobs.finish(job_id, "done", summary=summary or "(no report)")
                    return
                value = self._ask(interrupts)
                if value is _STOP or self.token.cancelled:
                    self._finish_stopped()
                    return
                payload = Command(resume=value)
        except Exception as exc:  # noqa: BLE001 - the job fails, the session goes on
            if self.token.cancelled:
                self._finish_stopped()
                return
            logger.warning("background agent %s failed", job_id, exc_info=True)
            self.log(f"failed: {type(exc).__name__}: {exc}")
            self.jobs.finish(job_id, "failed", reason="error", summary=f"{type(exc).__name__}: {exc}")
        finally:
            if self.policy is not None:
                self.policy.end_visible_turn(self.thread_id)
            self.jobs.stop_children(job_id, by="circle")
            # the run is over: its graph, state and checkpoints can be freed
            self._saver = None
            self.graph = None
            self.state = {}

    def _ask(self, interrupts: list[Any]) -> Any:
        assert self.job is not None
        if self.host is None:
            return _STOP
        with self._lock:
            self._waiting = True
        self.jobs.update(self.job.id, status="waiting", detail="waiting for you")
        try:
            self.host.ask(self.jobs.get(self.job.id) or self.job, interrupts, self.answer)
            while True:
                try:
                    value = self._answers.get(timeout=0.25)
                except queue.Empty:
                    if self.token.cancelled:
                        return _STOP
                    continue
                return value
        finally:
            with self._lock:
                self._waiting = False
            self.jobs.update(self.job.id, status="running", detail="")

    def _finish_stopped(self) -> None:
        assert self.job is not None
        self.log("stopped")
        self.jobs.finish(self.job.id, "stopped")


def _name(tool: Any) -> str:
    if isinstance(tool, dict):
        return str(tool.get("name") or (tool.get("function") or {}).get("name") or "")
    return str(getattr(tool, "name", "") or "")


class BackgroundTaskMiddleware(AgentMiddleware):
    """The main agent's ``task`` gains ``background``: the model sees the extended schema,
    and a call with ``background: true`` goes to a launcher instead of the blocking run."""

    def __init__(self, jobs: JobRegistry, *, max_agents: int = MAX_BACKGROUND_AGENTS) -> None:
        super().__init__()
        self.jobs = jobs
        self.max_agents = max_agents
        self.host: ApprovalHost | None = None
        self.policy: Any = None
        self.on_usage: Callable[[dict[str, Any], dict[str, Any]], None] | None = None
        self._task: BaseTool | None = None
        self._view: BaseTool | None = None
        self._launcher: BaseTool | None = None
        self._prepare: Callable[..., Any] | None = None
        self._graphs: dict[str, Any] = {}
        self._recursion_limit: int | None = None
        # parallel task calls run at once: counting and registering is one step
        self._launching = threading.Lock()

    @property
    def available(self) -> bool:
        return self._launcher is not None

    def bind(self, agent: Any, *, policy: Any = None) -> list[BaseTool]:
        """Read the built ``task`` tool. Returns the tools as the model should see them
        (for the compatibility layer), or [] when background is not offered."""
        try:
            tools_by_name = agent.nodes["tools"].bound.tools_by_name
        except Exception:  # noqa: BLE001
            return []
        task = tools_by_name.get("task")
        if task is None:
            return []
        try:
            self._prepare, self._graphs = task_internals(task)
        except BackgroundUnavailable:
            logger.warning("task has an unexpected shape; background subagents are off",
                           exc_info=True)
            return []
        self._task = task
        self.policy = policy
        description = (task.description or "") + BACKGROUND_NOTE
        self._view = StructuredTool.from_function(
            name="task", description=description, func=_never, args_schema=TaskWithBackground,
            infer_schema=False)
        self._launcher = StructuredTool.from_function(
            name="task", description=description, func=self._launch,
            args_schema=TaskWithBackground, infer_schema=False)
        limit, layer = None, agent
        while layer is not None and limit is None:
            limit = (getattr(layer, "config", None) or {}).get("recursion_limit")
            layer = getattr(layer, "bound", None)
        self._recursion_limit = limit
        return [self._view if name == "task" else tool for name, tool in tools_by_name.items()]

    # what the model sees

    def _with_view(self, request: Any) -> Any:
        if self._view is None or not request.tools:
            return request
        return request.override(tools=[self._view if _name(t) == "task" else t
                                       for t in request.tools])

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return handler(self._with_view(request))

    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return await handler(self._with_view(request))

    # what a call runs

    def _route(self, request: Any) -> Any:
        call = request.tool_call
        if self._task is None or call.get("name") != "task":
            return request
        args = dict(call.get("args") or {})
        background = is_true(args.pop("background", False))
        if background:
            return request.override(tool=self._launcher, tool_call={**call, "args": {
                **args, "background": True}})
        return request.override(tool=self._task, tool_call={**call, "args": args})

    def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return handler(self._route(request))

    async def awrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        return await handler(self._route(request))

    # the launcher

    def _launch(self, description: str, subagent_type: str, runtime: ToolRuntime,
                background: bool = True) -> ToolMessage | str:
        call_id = runtime.tool_call_id
        if subagent_type not in self._graphs:
            allowed = ", ".join(f"`{name}`" for name in self._graphs)
            return (f"We cannot invoke subagent {subagent_type} because it does not exist, the "
                    f"only allowed types are {allowed}")
        try:
            graph, state = self._prepare(subagent_type, description, runtime)
        except Exception as exc:  # noqa: BLE001 - told to the model
            return f"Error: could not start {subagent_type}: {type(exc).__name__}: {exc}"
        if not callable(getattr(getattr(graph, "bound", graph), "get_state", None)):
            return (f"Error: {subagent_type} cannot run in the background here; call task "
                    "without background.")
        owner = job_owner()
        runner = AgentJobRunner(jobs=self.jobs, graph=graph, state=state,
                                subagent_type=subagent_type, owner=owner, host=self.host,
                                policy=self.policy, recursion_limit=self._recursion_limit,
                                on_usage=self.on_usage)
        first = " ".join(str(description or "").split())
        with self._launching:
            live = self.jobs.live("agent")
            if len(live) >= self.max_agents:
                return (f"Error: {len(live)} background agents are already running "
                        f"({', '.join(j.id for j in live)}). Wait for a notice or stop one "
                        "with stop_job.")
            job = self.jobs.register("agent", f"{subagent_type} · {first[:80]}", owner=owner,
                                     stop=runner.stop, finishes_itself=True,
                                     output_name="{id}.log")
        runner.start(job)
        text = (f"Started background {subagent_type} agent {job.id}. It reports to you when it "
                f"ends; its progress goes to {job.virtual_path}. Do not wait, poll or sleep for "
                "it; carry on with other work, or end your turn. Stop it with stop_job.")
        return ToolMessage(content=text, name="task", tool_call_id=call_id,
                           additional_kwargs={"circle_job": {"id": job.id, "how": "started",
                                                             "path": job.virtual_path}})


def is_true(value: Any) -> bool:
    """A flag as a model may send it: ``true``, or the text ``"true"`` (not ``"false"``)."""
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return value is True or value == 1


def _never(**_kwargs: Any) -> str:  # pragma: no cover - the view is never run
    raise RuntimeError("the task view is not runnable")


class UnattendedHost:
    """Nobody can answer here (print, JSON and RPC modes): approvals follow the print-mode
    rule, questions are not answered."""

    def __init__(self, decide: Callable[[Job, Any], Any], say: Callable[[str], None] | None = None
                 ) -> None:
        self._decide = decide
        self._say = say or (lambda _line: None)

    def ask(self, job: Job, interrupts: list[Any], answer: Callable[[Any], None]) -> None:
        replies: dict[str, Any] = {}
        for item in interrupts:
            value = getattr(item, "value", item)
            iid = getattr(item, "id", None)
            if isinstance(value, dict) and "action_requests" in value:
                replies[str(iid)] = self._decide(job, value)
            else:
                replies[str(iid)] = {"cancelled": True}
        answer(next(iter(replies.values())) if len(replies) == 1 else replies)

    def withdraw(self, job: Job) -> None:
        return None


def wait_for(predicate: Callable[[], bool], timeout: float) -> bool:
    """For tests and shutdown: poll ``predicate`` until it holds."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()
