"""Subagents in the background: ``task(background=true)`` returns a job id at once, the
subagent runs with a checkpointer of its own, stops for approval until the session answers
(by interrupt id), and its report reaches the model as a notice."""

from __future__ import annotations

import sys
import threading
import time

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from circle.approvals import default_policy
from circle.harness import create_harness
from circle.job_agents import MAX_BACKGROUND_AGENTS, task_internals
from circle.jobs import JobRegistry
from circle.middleware.job_notice import DELIVER_KEY
from circle.testing import RoutedModel

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _task(description: str, call_id: str = "t1", kind: str = "general-purpose") -> AIMessage:
    return _call("task", {"description": description, "subagent_type": kind,
                          "background": True}, call_id)


class Host:
    """Answers like the session would, when the test says so."""

    def __init__(self) -> None:
        self.asked: list = []
        self.withdrawn: list = []
        self.event = threading.Event()

    def ask(self, job, interrupts, answer) -> None:
        self.asked.append((job, interrupts, answer))
        self.event.set()

    def withdraw(self, job) -> None:
        self.withdrawn.append(job.id)


def _harness(tmp_path, model, *, yolo=False):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir(exist_ok=True)
    policy = default_policy(home)
    policy.set_yolo("t", yolo)
    jobs = JobRegistry()
    agent = create_harness(model, root_dir=ws, home=home, approvals=policy, jobs=jobs)
    host = Host()
    agent._circle_background_tasks.host = host
    return agent, jobs, host, ws


def _config() -> dict:
    return {"configurable": {"thread_id": "t", "circle_visible_turn": True, DELIVER_KEY: True}}


def _wait(predicate, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


def test_task_internals_still_find_the_subagents(tmp_path):
    agent, _jobs, _host, _ws = _harness(tmp_path, RoutedModel(default=[AIMessage(content="x")]))
    prepare, graphs = task_internals(agent.nodes["tools"].bound.tools_by_name["task"])
    assert callable(prepare) and {"general-purpose", "explore"} <= set(graphs)
    assert agent._circle_background_tasks.available
    assert "background" in agent._circle_background_tasks._view.args


@posix_only
def test_a_background_agent_waits_for_approval_and_goes_on_by_interrupt_id(tmp_path):
    model = RoutedModel(
        routes={"BG-MAKE": [_call("execute", {"command": "touch made-by-agent"}, "e1"),
                            AIMessage(content="report: the file is made")]},
        default=[_task("BG-MAKE create the file"), AIMessage(content="launched it")])
    agent, jobs, host, ws = _harness(tmp_path, model)
    result = agent.invoke({"messages": [HumanMessage(content="make it in the background")]},
                          config=_config())
    started = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert started.additional_kwargs["circle_job"]["how"] == "started"
    assert result["messages"][-1].content == "launched it"
    assert host.event.wait(10), "the agent stopped for approval"
    job, interrupts, answer = host.asked[0]
    assert jobs.get(job.id).status == "waiting" and job.kind == "agent"
    assert getattr(interrupts[0], "id", None)
    assert not (ws / "made-by-agent").exists()
    answer({"decisions": [{"type": "approve"}]})
    _wait(lambda: not jobs.get(job.id).running)
    assert jobs.get(job.id).status == "done" and (ws / "made-by-agent").exists()
    [notice] = jobs.pending_notices("t")
    assert "report: the file is made" in notice.text
    main = agent.get_state({"configurable": {"thread_id": "t"}}).values["messages"]
    assert not any(getattr(m, "tool_call_id", "") == "e1" for m in main), \
        "the subagent's steps stay out of the conversation"


@posix_only
def test_stopping_a_waiting_agent_takes_its_question_down(tmp_path):
    model = RoutedModel(
        routes={"BG-STOP": [_call("execute", {"command": "touch never"}, "e1"),
                            AIMessage(content="unreachable")]},
        default=[_task("BG-STOP do it"), AIMessage(content="ok")])
    agent, jobs, host, ws = _harness(tmp_path, model)
    agent.invoke({"messages": [HumanMessage(content="go")]}, config=_config())
    assert host.event.wait(10)
    job = host.asked[0][0]
    jobs.stop(job.id, by="user")
    _wait(lambda: not jobs.get(job.id).running)
    ended = jobs.get(job.id)
    assert (ended.status, ended.reason) == ("stopped", "stopped by user")
    assert host.withdrawn == [job.id] and not (ws / "never").exists()


@posix_only
def test_yolo_for_the_conversation_lets_its_background_agents_run(tmp_path):
    model = RoutedModel(
        routes={"BG-YOLO": [_call("execute", {"command": "touch yolo-made"}, "e1"),
                            AIMessage(content="done")]},
        default=[_task("BG-YOLO make it"), AIMessage(content="ok")])
    agent, jobs, host, ws = _harness(tmp_path, model, yolo=True)
    agent.invoke({"messages": [HumanMessage(content="go")]}, config=_config())
    _wait(lambda: jobs.list() and not jobs.list()[0].running)
    assert host.asked == [] and (ws / "yolo-made").exists()


def test_only_so_many_background_agents_run_at_once(tmp_path):
    calls = [_task(f"BG-HOLD-{i} wait", f"t{i}") for i in range(MAX_BACKGROUND_AGENTS + 1)]
    model = RoutedModel(
        routes={f"BG-HOLD-{i}": [_call("question", {"questions": [{"question": "?",
                                                                    "options": ["a"]}]},
                                       f"q{i}")]
                for i in range(MAX_BACKGROUND_AGENTS + 1)},
        default=[AIMessage(content="", tool_calls=[c.tool_calls[0] for c in calls]),
                 AIMessage(content="ok")])
    agent, jobs, _host, _ws = _harness(tmp_path, model)
    result = agent.invoke({"messages": [HumanMessage(content="go")]}, config=_config())
    answers = [m.content for m in result["messages"] if isinstance(m, ToolMessage)]
    assert sum("Started background" in a for a in answers) == MAX_BACKGROUND_AGENTS
    assert any("background agents are already running" in a for a in answers)
    jobs.stop_all()


@posix_only
def test_jobs_a_background_agent_started_end_with_it(tmp_path):
    model = RoutedModel(
        routes={"BG-CHILD": [_call("execute", {"command": "sleep 30", "background": True}, "e1"),
                             AIMessage(content="left a server")]},
        default=[_task("BG-CHILD start a server"), AIMessage(content="ok")])
    agent, jobs, _host, _ws = _harness(tmp_path, model, yolo=True)
    agent.invoke({"messages": [HumanMessage(content="go")]}, config=_config())
    _wait(lambda: any(j.kind == "agent" and not j.running for j in jobs.list()))
    child = next(j for j in jobs.list() if j.kind == "shell")
    agent_job = next(j for j in jobs.list() if j.kind == "agent")
    assert child.parent == agent_job.id and child.thread_id == "t"
    _wait(lambda: not jobs.get(child.id).running)
    assert jobs.get(child.id).status == "stopped"


def test_background_false_as_text_runs_the_subagent_in_the_foreground(tmp_path):
    model = RoutedModel(
        routes={"FG-TEXT": [AIMessage(content="report in the turn")]},
        default=[_call("task", {"description": "FG-TEXT look", "subagent_type": "explore",
                                "background": "false"}, "t1"),
                 AIMessage(content="ok")])
    agent, jobs, _host, _ws = _harness(tmp_path, model)
    result = agent.invoke({"messages": [HumanMessage(content="go")]}, config=_config())
    answer = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert answer.content == "report in the turn" and jobs.list() == []


@posix_only
def test_an_ended_background_agent_lets_go_of_its_run(tmp_path):
    model = RoutedModel(routes={"BG-FREE": [AIMessage(content="done")]},
                        default=[_task("BG-FREE nothing"), AIMessage(content="ok")])
    agent, jobs, _host, _ws = _harness(tmp_path, model)
    agent.invoke({"messages": [HumanMessage(content="go")]}, config=_config())
    _wait(lambda: jobs.list() and not jobs.list()[0].running)
    entry = jobs._entries[jobs.list()[0].id]
    assert entry.stop is None
