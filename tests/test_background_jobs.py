"""The model's side of background jobs: execute with background, list_jobs, stop_job,
wait_jobs, and notices of finished jobs reaching the model."""

from __future__ import annotations

import sys
import time

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from pydantic import Field

from circle.approvals import default_policy
from circle.harness import create_harness
from circle.jobs import JobRegistry, Owner, is_job_notice
from circle.middleware.job_notice import DELIVER_KEY, JobNoticeMiddleware
from circle.system_prompt import load_tool_prompt
from circle.testing import ScriptedModel

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")


class Recording(ScriptedModel):
    seen: list = Field(default_factory=list)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return super()._generate(messages, stop, run_manager, **kwargs)


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _tools(graph) -> dict:
    graph = getattr(graph, "bound", graph)
    return graph.nodes["tools"].bound.tools_by_name


def _subagent_graphs(agent) -> dict:
    task = _tools(agent)["task"]
    cells = dict(zip(task.func.__code__.co_freevars,
                     (cell.cell_contents for cell in task.func.__closure__), strict=True))
    return cells["subagent_graphs"]


def _config(deliver: bool = True) -> dict:
    configurable = {"thread_id": "t", "circle_visible_turn": True}
    if deliver:
        configurable[DELIVER_KEY] = True
    return {"configurable": configurable}


def _harness(tmp_path, model, *, thread="t", yolo=True, jobs=None):
    home = tmp_path / "home"
    policy = default_policy(home)
    policy.set_yolo(thread, yolo)
    jobs = jobs or JobRegistry()
    agent = create_harness(model, root_dir=tmp_path / "ws", home=home, approvals=policy,
                           jobs=jobs)
    return agent, jobs


@pytest.fixture(autouse=True)
def _workspace(tmp_path):
    (tmp_path / "ws").mkdir()


def test_execute_schema_and_description_in_main_and_general_purpose(tmp_path):
    agent, jobs = _harness(tmp_path, ScriptedModel(responses=[AIMessage(content="hi")]))
    main = _tools(agent)
    assert "background" in main["execute"].args
    assert main["execute"].description == load_tool_prompt("execute")
    assert {"list_jobs", "stop_job"} <= set(main) and "wait_jobs" not in main
    graphs = _subagent_graphs(agent)
    general = _tools(graphs["general-purpose"])
    assert "background" in general["execute"].args
    assert {"list_jobs", "stop_job", "wait_jobs"} <= set(general)
    explore = _tools(graphs["explore"])
    assert "execute" not in explore and "list_jobs" in explore
    assert agent._circle_jobs is jobs and agent._circle_backend.jobs is jobs


@posix_only
def test_a_background_command_still_asks_for_approval(tmp_path):
    model = ScriptedModel(responses=[
        _call("execute", {"command": "sleep 30", "background": True}, "e1"),
        AIMessage(content="done")])
    agent, jobs = _harness(tmp_path, model, yolo=False)
    config = _config()
    agent.invoke({"messages": [HumanMessage(content="start it")]}, config=config)
    interrupts = agent.get_state(config).interrupts
    assert interrupts, "the call waits for approval"
    assert jobs.list() == []


@posix_only
def test_a_finished_job_reaches_the_model_in_the_running_turn(tmp_path):
    model = Recording(responses=[
        # it ends a second later, while the sleep after it waits (even on a busy machine)
        _call("execute", {"command": "sleep 1; echo hello", "background": True}, "e1"),
        _call("execute", {"command": "sleep 20"}, "e2"),
        AIMessage(content="it said hello")])
    agent, jobs = _harness(tmp_path, model)
    began = time.monotonic()
    result = agent.invoke({"messages": [HumanMessage(content="run it")]},
                          config=_config())
    assert time.monotonic() - began < 10, "the bare sleep ended when the job did"
    started = next(m for m in result["messages"]
                   if isinstance(m, ToolMessage) and m.tool_call_id == "e1")
    assert started.additional_kwargs["circle_job"]["how"] == "started"
    job_id = started.additional_kwargs["circle_job"]["id"]
    notices = [m for m in result["messages"] if is_job_notice(m)]
    assert len(notices) == 1 and job_id in notices[0].content and "hello" in notices[0].content
    assert any(is_job_notice(m) for m in model.seen[-1]), "the model read it"
    assert jobs.pending_notices("t") == []


@posix_only
def test_a_run_that_does_not_deliver_leaves_the_notices_waiting(tmp_path):
    model = ScriptedModel(responses=[
        _call("execute", {"command": "true", "background": True}, "e1"),
        _call("execute", {"command": "sleep 20"}, "e2"),
        AIMessage(content="ok")])
    agent, jobs = _harness(tmp_path, model)
    result = agent.invoke({"messages": [HumanMessage(content="run it")]},
                          config=_config(deliver=False))
    assert not any(is_job_notice(m) for m in result["messages"])
    assert len(jobs.pending_notices("t")) == 1


@posix_only
def test_the_model_lists_and_stops_its_jobs(tmp_path):
    model = ScriptedModel(responses=[
        _call("execute", {"command": "sleep 30", "background": True}, "e1"),
        _call("list_jobs", {}, "l1"),
        _call("stop_job", {"job_id": "j1"}, "s1"),
        AIMessage(content="stopped")])
    agent, jobs = _harness(tmp_path, model)
    result = agent.invoke({"messages": [HumanMessage(content="go")]}, config=_config())
    by_id = {m.tool_call_id: m.content for m in result["messages"] if isinstance(m, ToolMessage)}
    assert "j1 · shell · running" in by_id["l1"] and "sleep 30" in by_id["l1"]
    assert by_id["s1"] == "Stopped j1."
    job = jobs.get("j1")
    assert (job.status, job.reason) == ("stopped", "stopped by model")
    assert jobs.pending_notices("t") == []


@posix_only
def test_wait_jobs_returns_when_a_job_ends_and_takes_its_notice(tmp_path):
    agent, jobs = _harness(tmp_path, ScriptedModel(responses=[AIMessage(content="hi")]))
    backend = agent._circle_backend
    job = backend.start_background("sleep 0.3; echo finished", owner=Owner("t")).job
    wait = _tools(_subagent_graphs(agent)["general-purpose"])["wait_jobs"]
    began = time.monotonic()
    text = wait.invoke({"job_ids": [job.id], "timeout_s": 30})
    assert time.monotonic() - began < 10
    assert "finished" in text and job.id in text
    assert jobs.pending_notices("t") == [], "the main agent is not told twice"


def test_after_a_summary_running_jobs_are_named_once(tmp_path):
    jobs = JobRegistry()
    job = jobs.register("watch", "cex run 7", owner=Owner("t"))
    middleware = JobNoticeMiddleware(jobs)
    summary = HumanMessage(content="Summary of earlier work")
    state = {"messages": [HumanMessage(content=f"started {job.id}"), AIMessage(content="ok")],
             "_summarization_event": {"cutoff_index": 1, "summary_message": summary}}
    reminder = middleware._running_reminder(state, "t")
    assert reminder is not None and job.id in reminder.content and "cex run 7" in reminder.content
    state["messages"].append(reminder)
    assert middleware._running_reminder(state, "t") is None
    jobs.stop_all()
