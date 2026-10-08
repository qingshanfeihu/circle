"""Background jobs without the full-screen interface: print mode waits for the model's jobs
after its answer (up to CIRCLE_JOB_WAIT), line mode gives their notices to the next
message, and RPC mode starts a turn for them when nothing runs."""

from __future__ import annotations

import io
import json
import sys
import time

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import Field

from circle.harness import create_harness
from circle.headless import HeadlessRun
from circle.jobs import JobRegistry, is_job_notice
from circle.rpc import RpcServer
from circle.testing import ScriptedModel

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")


class Recording(ScriptedModel):
    seen: list = Field(default_factory=list)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return super()._generate(messages, stop, run_manager, **kwargs)


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _run(tmp_path, responses, **kwargs) -> tuple[HeadlessRun, Recording]:
    ws = tmp_path / "ws"
    ws.mkdir(exist_ok=True)
    model = Recording(responses=responses)
    agent = create_harness(model, root_dir=ws, home=tmp_path / "home", jobs=JobRegistry())
    return HeadlessRun(agent, yolo=True, **kwargs), model


def test_print_mode_waits_for_the_job_and_answers_again(tmp_path):
    events = []
    run, model = _run(tmp_path, [
        _call("execute", {"command": "sleep 0.3; echo bg-out", "background": True}, "e1"),
        AIMessage(content="started"),
        AIMessage(content="the job printed bg-out")], events=events.append)
    assert run.turn("go") == "started"
    began = time.monotonic()
    assert run.settle_jobs(30) == "the job printed bg-out"
    assert time.monotonic() - began < 10
    assert any(is_job_notice(m) for m in model.seen[-1])
    assert {"type": "turn_start", "jobNotice": ["j1"]} in events


def test_print_mode_stops_jobs_still_running_at_the_limit(tmp_path):
    run, _model = _run(tmp_path, [
        _call("execute", {"command": "sleep 30", "background": True}, "e1"),
        AIMessage(content="started")])
    run.turn("go")
    began = time.monotonic()
    assert run.settle_jobs(0.5) is None
    assert time.monotonic() - began < 5
    assert run.stopped_at_deadline == 1 and run.jobs.get("j1").status == "stopped"


def test_print_mode_does_not_wait_for_processes_left_running(tmp_path):
    run, _model = _run(tmp_path, [
        _call("execute", {"command": "sleep 30 & echo up"}, "e1"),
        AIMessage(content="server up")])
    assert run.turn("go") == "server up"
    assert run.jobs.get("j1").kind == "adopted"
    began = time.monotonic()
    assert run.settle_jobs(30) is None
    assert time.monotonic() - began < 5
    assert run.jobs.get("j1").status == "stopped"


def test_line_mode_gives_the_notice_to_the_next_message(tmp_path):
    run, model = _run(tmp_path, [
        _call("execute", {"command": "echo from-job", "background": True}, "e1"),
        AIMessage(content="started"),
        AIMessage(content="seen it")])
    run.turn("start")
    deadline = time.monotonic() + 10
    while not run.jobs.has_notices(run.thread_id):
        assert time.monotonic() < deadline
        time.sleep(0.05)
    assert run.turn("anything new?") == "seen it"
    last = model.seen[-1]
    asked = next(i for i, m in enumerate(last)
                 if isinstance(m, HumanMessage) and m.content == "anything new?")
    notice = next(i for i, m in enumerate(last) if is_job_notice(m))
    assert notice > asked and "from-job" in last[notice].content


class _Out(io.StringIO):
    def records(self):
        return [json.loads(line) for line in self.getvalue().splitlines() if line.strip()]


def _server(tmp_path, responses):
    run, model = _run(tmp_path, responses)
    out = _Out()
    server = RpcServer(lambda thread: HeadlessRun(run.agent, thread_id=thread, yolo=True),
                       out=out, home=tmp_path / "home", model_name=lambda: "scripted",
                       jobs=run.jobs)
    return server, out, model


def _send(server, **command):
    server.handle_line(json.dumps(command))


def _wait(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline
        time.sleep(0.02)


def test_rpc_starts_a_turn_when_a_job_ends_while_idle(tmp_path):
    server, out, _model = _server(tmp_path, [
        _call("execute", {"command": "sleep 0.3; echo rpc-job", "background": True}, "e1"),
        AIMessage(content="started"),
        AIMessage(content="rpc-job is done")])
    _send(server, id="1", type="prompt", message="go")
    _wait(lambda: any(r.get("answer") == "rpc-job is done" for r in out.records()))
    assert server.wait_idle(10)
    kinds = [(r["type"], r.get("event")) for r in out.records()]
    assert ("job", "started") in kinds and ("job", "ended") in kinds
    assert {"type": "turn_start", "jobNotice": ["j1"]} in out.records()
    assert kinds[-1] == ("agent_settled", None)
    server.close()


def test_rpc_lists_and_stops_jobs_and_stops_the_rest_at_eof(tmp_path, monkeypatch):
    monkeypatch.setenv("CIRCLE_JOB_WAIT", "0")
    server, out, _model = _server(tmp_path, [
        _call("execute", {"command": "sleep 30", "background": True}, "e1"),
        _call("execute", {"command": "sleep 30", "background": True}, "e2"),
        AIMessage(content="two started")])
    _send(server, id="1", type="prompt", message="go")
    assert server.wait_idle(10)
    _send(server, id="2", type="list_jobs")
    listed = out.records()[-1]["data"]["jobs"]
    assert [j["id"] for j in listed] == ["j1", "j2"] and listed[0]["status"] == "running"
    _send(server, id="3", type="stop_job", jobId="j1")
    assert out.records()[-1]["data"]["job"]["status"] == "stopped"
    assert server.serve(io.StringIO("")) == 0
    assert {"type": "jobs_stopped", "count": 1} in out.records()
