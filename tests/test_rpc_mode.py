"""``circle --mode rpc``: JSON commands in, a response for each and the turn's events out."""

from __future__ import annotations

import io
import json
import threading
import time

from langchain_core.messages import AIMessage

from circle.harness import create_harness
from circle.headless import HeadlessRun
from circle.rpc import RpcServer
from circle.testing import ScriptedModel


class Gated(ScriptedModel):
    """Answers in order; the first call waits until ``gate`` is opened."""

    seen: list = []
    gate: threading.Event = threading.Event()

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        Gated.seen.append([str(m.content) for m in messages])
        if len(Gated.seen) == 1:
            Gated.gate.wait(10)
        return super()._generate(messages, stop, run_manager, **kwargs)


class _Out(io.StringIO):
    def records(self):
        return [json.loads(line) for line in self.getvalue().splitlines() if line.strip()]


def _server(tmp_path, responses, gated=False):
    ws = tmp_path / "ws"
    ws.mkdir(exist_ok=True)
    Gated.seen, Gated.gate = [], threading.Event()
    if not gated:
        Gated.gate.set()
    model = Gated(responses=[AIMessage(content=r) if isinstance(r, str) else r for r in responses])
    agent = create_harness(model, root_dir=ws, home=tmp_path / "home")
    out = _Out()
    server = RpcServer(lambda thread: HeadlessRun(agent, thread_id=thread), out=out,
                       home=tmp_path / "home", model_name=lambda: "scripted")
    return server, out


def _send(server, **command):
    server.handle_line(json.dumps(command))


def _wait(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline
        time.sleep(0.02)


def test_a_prompt_is_answered_and_settles(tmp_path):
    server, out = _server(tmp_path, ["hello there"])
    _send(server, id="1", type="prompt", message="hi")
    assert server.wait_idle(10)
    records = out.records()
    assert records[0] == {"type": "response", "command": "prompt", "success": True,
                          "id": "1", "data": {"disposition": "started"}}
    kinds = [r["type"] for r in records[1:]]
    assert kinds == ["turn_start", "assistant", "turn_end", "agent_settled"]
    assert records[-2]["answer"] == "hello there"
    _send(server, id="2", type="get_last_assistant_text")
    assert out.records()[-1]["data"] == {"text": "hello there"}
    _send(server, id="3", type="get_state")
    state = out.records()[-1]["data"]
    assert state["isStreaming"] is False and state["messageCount"] == 2 and state["model"] == "scripted"


def test_steering_reaches_the_running_turn(tmp_path):
    ls = AIMessage(content="", tool_calls=[{"name": "ls", "args": {"path": "/"}, "id": "l1"}])
    server, out = _server(tmp_path, [ls, "done"], gated=True)
    _send(server, id="1", type="prompt", message="look around")
    _wait(lambda: Gated.seen)
    _send(server, id="2", type="prompt", message="also check src")
    assert out.records()[-1]["success"] is False, "a running turn needs streamingBehavior"
    _send(server, id="3", type="prompt", message="also check src", streamingBehavior="steer")
    assert out.records()[-1]["data"] == {"disposition": "queued"}
    Gated.gate.set()
    assert server.wait_idle(10)
    assert "also check src" in Gated.seen[1]
    assert any(r["type"] == "steer" for r in out.records())


def test_follow_ups_run_after_and_abort_stops(tmp_path):
    server, out = _server(tmp_path, ["one", "two"], gated=True)
    _send(server, id="1", type="prompt", message="first")
    _wait(lambda: Gated.seen)
    _send(server, id="2", type="follow_up", message="second")
    _send(server, id="3", type="clear_queue")
    assert out.records()[-1]["data"] == {"steering": [], "followUp": ["second"]}
    threading.Timer(0.3, Gated.gate.set).start()
    _send(server, id="4", type="abort")
    assert out.records()[-1] == {"type": "response", "command": "abort", "success": True, "id": "4"}
    assert not server.streaming


def test_bad_lines_and_unknown_commands_get_an_error(tmp_path):
    server, out = _server(tmp_path, ["x"])
    server.handle_line("{not json")
    server.handle_line(json.dumps({"id": "9", "type": "fly"}))
    first, second = out.records()
    assert first["command"] == "parse" and first["success"] is False
    assert second == {"type": "response", "command": "fly", "success": False, "id": "9",
                      "error": "Unknown command: fly"}
    _send(server, id="n", type="new_session")
    assert out.records()[-1]["data"]["sessionId"] == server.run.thread_id
