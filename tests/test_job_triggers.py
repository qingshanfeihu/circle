"""Long tasks wake the model instead of it sleeping: an extension tool hands Circle a Watch
that is polled off the model's turns, and the loop guard names polling while a job runs."""

from __future__ import annotations

import sys
import textwrap
import time
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from circle.extensions import ExtensionHost
from circle.harness import BUILTIN_TOOL_NAMES, create_harness
from circle.jobs import JobRegistry, Owner
from circle.middleware.job_notice import DELIVER_KEY
from circle.middleware.loop_guard import LoopGuardMiddleware, analyze
from circle.testing import ScriptedModel

WATCHER = '''
import threading

STATE = {"polls": 0, "stopped": 0}

def register(api):
    def submit(args):
        def poll():
            STATE["polls"] += 1
            if args.get("fail"):
                raise RuntimeError("the gateway said no")
            return {"verdict": "pass", "case": args.get("case")} if STATE["polls"] >= 2 else None

        def stopped():
            STATE["stopped"] += 1

        return api.Watch(f"run {args.get('case')}", poll, interval_s=0.05,
                         deadline_s=float(args.get("deadline", 30)),
                         result={"task": "t-1", "status": "pending"}, on_stop=stopped)

    schema = {"type": "object", "properties": {"case": {"type": "string"},
              "fail": {"type": "boolean"}, "deadline": {"type": "number"}}}
    api.register_tool("run_case", "Submit a case to the lab.", schema, submit, read_only=True)
'''


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _harness(tmp_path, responses):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    path = home / "extensions" / "lab" / "extension.py"
    path.parent.mkdir(parents=True)
    path.write_text(textwrap.dedent(WATCHER), encoding="utf-8")
    host = ExtensionHost(home=home, workspace=ws, trusted=True,
                         reserved_tools=set(BUILTIN_TOOL_NAMES)).load()
    jobs = JobRegistry()
    agent = create_harness(ScriptedModel(responses=responses), root_dir=ws, home=home,
                           extensions=host, jobs=jobs)
    return agent, jobs


def _config() -> dict:
    return {"configurable": {"thread_id": "t", "circle_visible_turn": True, DELIVER_KEY: True}}


def _wait(predicate, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline
        time.sleep(0.02)


def test_a_watch_returns_at_once_and_its_result_comes_as_a_notice(tmp_path):
    agent, jobs = _harness(tmp_path, [_call("run_case", {"case": "c7"}, "r1"),
                                      AIMessage(content="submitted")])
    result = agent.invoke({"messages": [HumanMessage(content="run c7")]}, config=_config())
    returned = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert '"status": "pending"' in returned.content
    assert "background job j1" in returned.content and "Do not call run_case again" in returned.content
    _wait(lambda: not jobs.get("j1").running)
    job = jobs.get("j1")
    assert (job.kind, job.status, job.source, job.title) == ("watch", "done", "lab", "run c7")
    [notice] = jobs.pending_notices("t")
    assert '"verdict": "pass"' in notice.text and notice.wake


def test_a_watch_that_fails_or_runs_out_of_time_says_so(tmp_path):
    agent, jobs = _harness(tmp_path, [_call("run_case", {"case": "a", "fail": True}, "r1"),
                                      _call("run_case", {"case": "b", "deadline": 0.01}, "r2"),
                                      AIMessage(content="ok")])
    agent.invoke({"messages": [HumanMessage(content="go")]}, config=_config())
    _wait(lambda: not jobs.get("j1").running and not jobs.get("j2").running)
    failed = jobs.get("j1")
    assert (failed.status, failed.reason) == ("failed", "error")
    assert "the gateway said no" in failed.summary
    assert (jobs.get("j2").status, jobs.get("j2").reason) == ("failed", "deadline")


def test_stopping_a_watch_runs_its_on_stop_once(tmp_path):
    jobs = JobRegistry()
    stops = []
    job = jobs.start_watch("never", lambda: None, interval=0.05,
                           on_stop=lambda: stops.append(1), owner=Owner("t"))
    jobs.stop(job.id, by="user")
    assert jobs.stop_all() == 0
    assert stops == [1] and jobs.get(job.id).status == "stopped"


def test_a_long_watch_result_is_kept_in_a_file(tmp_path):
    jobs = JobRegistry()
    jobs.bind_root(tmp_path / "background_jobs")
    big = "x" * 10_000
    job = jobs.start_watch("big", lambda: big, interval=0.01, owner=Owner("t"))
    _wait(lambda: not jobs.get(job.id).running)
    ended = jobs.get(job.id)
    assert len(ended.summary) < 5000 and "the whole result is in /background_jobs/" in ended.summary
    assert Path(ended.output_path).read_text() == big


def _polls(*calls) -> list:
    messages: list = [HumanMessage(content="go")]
    for index, (name, args) in enumerate(calls):
        messages.append(_call(name, args, f"c{index}"))
        messages.append(ToolMessage(content="ok", tool_call_id=f"c{index}", name=name))
    return messages


def test_the_loop_guard_counts_calls_that_only_wait():
    stats = analyze(_polls(("execute", {"command": "sleep 30"}),
                           ("execute", {"command": "sleep 5 && cat log.txt"}),
                           ("read_file", {"file_path": "/background_jobs/1-2/j1.log"}),
                           ("list_jobs", {}),
                           ("execute", {"command": "sleep 60", "background": True}),
                           ("execute", {"command": "pytest"})), window=8)
    assert stats["poll_count"] == 4


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")
def test_polling_while_a_job_runs_gets_named_instead_of_sleeping(tmp_path):
    jobs = JobRegistry()
    job = jobs.register("watch", "cex run 7", owner=Owner("t"))
    guard = LoopGuardMiddleware(jobs=jobs)
    messages = _polls(("execute", {"command": "sleep 30"}), ("list_jobs", {}))
    from langchain_core.runnables.config import var_child_runnable_config

    token = var_child_runnable_config.set({"configurable": {"thread_id": "t"}})
    try:
        update = guard.before_model({"messages": messages}, None)
    finally:
        var_child_runnable_config.reset(token)
    [reminder] = update["messages"]
    assert job.id in reminder.content and "cex run 7" in reminder.content
    assert "End your turn instead of polling" in reminder.content
    jobs.stop_all()
