"""Parallel subagent approvals resume every interrupt through the Circle session."""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from circle.oauth import start_oauth_login
from circle.tui.controllers import InitController, TrustController
from circle.tui.harness_bridge import HarnessBridge
from circle.tui.session_app import CircleSessionApp


class ParallelSubagentModel(BaseChatModel):
    mixed: bool = False
    extra_action: bool = False

    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        first = next(message.content for message in messages if message.type == "human")
        last = messages[-1]
        if "MAIN" in str(first):
            if last.type == "human":
                calls = [
                    {"name": "task", "args": {
                        "subagent_type": "general-purpose",
                        "description": f"SUB{index}: perform the requested action",
                    }, "id": f"task-{index}", "type": "tool_call"}
                    for index in range(2)
                ]
                answer = AIMessage(content="", tool_calls=calls)
            else:
                answer = AIMessage(content="final")
        else:
            tag = str(first).split(":", 1)[0]
            if last.type == "human":
                if self.mixed and tag == "SUB1":
                    calls = [{"name": "question", "args": {
                        "questions": [{"question": "Proceed?", "options": ["Yes", "No"]}],
                    }, "id": f"question-{tag}", "type": "tool_call"}]
                else:
                    suffixes = ("a", "b") if self.extra_action and tag == "SUB0" else ("",)
                    calls = [{"name": "execute", "args": {
                        "command": f"touch {tag}{suffix}.done",
                    }, "id": f"execute-{tag}{suffix}", "type": "tool_call"}
                        for suffix in suffixes]
                answer = AIMessage(content="", tool_calls=calls)
            else:
                answer = AIMessage(content=f"{tag} complete")
        return ChatResult(generations=[ChatGeneration(message=answer)])

    @property
    def _llm_type(self):
        return "parallel-subagent-test"


def _session(tmp_path: Path, monkeypatch, *, mixed: bool = False,
             extra_action: bool = False) -> CircleSessionApp:
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    TrustController(init.settings, ws, home=home).confirm()
    return CircleSessionApp(
        init.settings, ws, home=home,
        model_override=ParallelSubagentModel(mixed=mixed, extra_action=extra_action),
    )


def _wait_until(predicate, *, timeout: float = 15.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    pytest.fail("Circle did not reach the expected interrupt or final state")


def _wait_for_approval(app: CircleSessionApp) -> None:
    _wait_until(lambda: app._exec_approval is not None)


def _wait_for_done(app: CircleSessionApp) -> None:
    _wait_until(lambda: app._last_assistant_plain == "final"
                and not app._bridge.is_running and not app._is_loading)


def test_parallel_subagents_all_approved(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._on_submit("MAIN")
    _wait_for_approval(app)
    assert len(app._approval_queue) == 2
    assert len(app._pending_calls) == 2
    app._finish_exec_approval({"decision": "approve"})
    assert app._exec_approval is not None
    app._finish_exec_approval({"decision": "approve"})
    _wait_for_done(app)
    assert all((tmp_path / "ws" / f"SUB{index}.done").exists() for index in range(2))


def test_parallel_subagents_can_be_partly_rejected(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._on_submit("MAIN")
    _wait_for_approval(app)
    commands = [request["args"]["command"] for _iid, request in app._approval_queue]
    assert len(commands) == 2
    app._finish_exec_approval({"decision": "approve"})
    app._finish_exec_approval({"decision": "reject"})
    _wait_for_done(app)
    assert (tmp_path / "ws" / commands[0].split()[-1]).exists()
    assert not (tmp_path / "ws" / commands[1].split()[-1]).exists()


def test_parallel_interrupts_keep_each_group_action_count(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch, extra_action=True)
    app._on_submit("MAIN")
    _wait_for_approval(app)
    assert sorted(count for _iid, count in app._bridge._pending_action_groups) == [1, 2]
    assert len(app._approval_queue) == 3
    for _ in range(3):
        app._finish_exec_approval({"decision": "approve"})
    _wait_for_done(app)
    assert all((tmp_path / "ws" / name).exists()
               for name in ("SUB0a.done", "SUB0b.done", "SUB1.done"))


def test_yolo_approves_each_parallel_subagent_interrupt(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._on_submit("/yolo")
    app._on_submit("MAIN")
    _wait_for_done(app)
    assert app._exec_approval is None
    assert all((tmp_path / "ws" / f"SUB{index}.done").exists() for index in range(2))


def test_mixed_approval_and_question_resume_together(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch, mixed=True)
    app._on_submit("MAIN")
    _wait_for_approval(app)
    assert len(app._approval_queue) == 1 and len(app._ask_queue) == 1
    app._finish_exec_approval({"decision": "approve"})
    _wait_until(lambda: app._ask_session is not None)
    app._ask_session.handle_key("1", "1")
    _wait_for_done(app)
    assert (tmp_path / "ws" / "SUB0.done").exists()


def test_yolo_still_asks_questions_in_a_mixed_interrupt_batch(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch, mixed=True)
    app._on_submit("/yolo")
    app._on_submit("MAIN")
    _wait_until(lambda: app._ask_session is not None)
    assert app._exec_approval is None
    app._ask_session.handle_key("1", "1")
    _wait_for_done(app)
    assert (tmp_path / "ws" / "SUB0.done").exists()


def test_each_interrupt_gets_its_own_decision_count(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    resumed = []
    monkeypatch.setattr(app._bridge, "resume", resumed.append)
    app._on_interrupt([
        SimpleNamespace(id="first", value={"action_requests": [
            {"name": "execute", "args": {"command": "echo one"}},
            {"name": "execute", "args": {"command": "echo two"}},
        ]}),
        SimpleNamespace(id="second", value={"action_requests": [
            {"name": "execute", "args": {"command": "echo three"}},
        ]}),
    ])
    assert len(app._pending_calls) == 3
    app._finish_exec_approval({"decision": "approve"})
    app._finish_exec_approval({"decision": "reject"})
    assert resumed == []
    app._finish_exec_approval({"decision": "approve"})
    assert resumed == [{
        "first": {"decisions": [
            {"type": "approve"},
            {"type": "reject", "message": "The user rejected this tool call."},
        ]},
        "second": {"decisions": [{"type": "approve"}]},
    }]


def test_bridge_shortcut_groups_parallel_actions_by_interrupt_id(monkeypatch):
    bridge = HarnessBridge.__new__(HarnessBridge)
    bridge._worker = None
    bridge._cancelled = False
    captured = []
    monkeypatch.setattr(bridge, "_spawn", captured.append)
    pending = [
        SimpleNamespace(id="first", value={"action_requests": [{}, {}]}),
        SimpleNamespace(id="second", value={"action_requests": [{}]}),
    ]
    bridge._remember_interrupts(pending)
    assert bridge._count_action_requests(pending) == 3
    bridge.resume({"decision": "approve"})
    assert captured[0].resume == {
        "first": {"decisions": [{"type": "approve"}, {"type": "approve"}]},
        "second": {"decisions": [{"type": "approve"}]},
    }


def test_bridge_partitions_legacy_flat_decisions_by_interrupt_id(monkeypatch):
    bridge = HarnessBridge.__new__(HarnessBridge)
    bridge._worker = None
    bridge._cancelled = False
    captured = []
    monkeypatch.setattr(bridge, "_spawn", captured.append)
    bridge._remember_interrupts([
        SimpleNamespace(id="first", value={"action_requests": [{}, {}]}),
        SimpleNamespace(id="second", value={"action_requests": [{}]}),
    ])
    bridge.resume({"decisions": [
        {"type": "approve"}, {"type": "reject", "message": "no"}, {"type": "approve"},
    ]})
    assert captured[0].resume == {
        "first": {"decisions": [{"type": "approve"}, {"type": "reject", "message": "no"}]},
        "second": {"decisions": [{"type": "approve"}]},
    }


def test_bridge_shortcut_cannot_answer_mixed_approval_and_question(monkeypatch):
    bridge = HarnessBridge.__new__(HarnessBridge)
    bridge._worker = None
    bridge._cancelled = False
    captured = []
    monkeypatch.setattr(bridge, "_spawn", captured.append)
    bridge._remember_interrupts([
        SimpleNamespace(id="approval", value={"action_requests": [{}]}),
        SimpleNamespace(id="question", value={"kind": "ask_user", "questions": []}),
    ])
    with pytest.raises(ValueError, match="non-approval"):
        bridge.resume({"decision": "approve"})
    assert captured == []
