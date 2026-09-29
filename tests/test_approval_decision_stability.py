"""Decisions must stay attached to the calls that originally interrupted."""

from __future__ import annotations

import time

import pytest
from langchain_core.messages import AIMessage

from circle.ink.parse_keypress import KeyPress
from tests.test_slash_behaviors import _app


def _calls(*items):
    return AIMessage(content="", tool_calls=[
        {"name": name, "args": args, "id": f"call-{i}", "type": "tool_call"}
        for i, (name, args) in enumerate(items)
    ])


def _wait_for(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    pytest.fail("session did not reach expected approval or final state")


def test_always_rule_does_not_reclassify_rejected_call_on_resume(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, responses=[
        _calls(("write_file", {"file_path": "/first.txt", "content": "first"}),
               ("write_file", {"file_path": "/rejected.txt", "content": "rejected"})),
        AIMessage(content="done"),
    ])
    app._on_submit("write two files")
    _wait_for(lambda: app._exec_approval is not None and len(app._approval_queue) == 2)
    app._finish_exec_approval({"decision": "always"})
    app._finish_exec_approval({"decision": "reject"})
    _wait_for(lambda: app._last_assistant_plain == "done" and not app._bridge.is_running)
    assert (tmp_path / "ws" / "first.txt").read_text() == "first"
    assert not (tmp_path / "ws" / "rejected.txt").exists()
    assert app._approvals.store.matches(app._thread_id, "write_file", "workspace")


def test_always_rule_keeps_mixed_batch_decision_count(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, responses=[
        _calls(("write_file", {"file_path": "/note.txt", "content": "note"}),
               ("execute", {"command": "touch approved.done"})),
        AIMessage(content="done"),
    ])
    app._on_submit("write and execute")
    _wait_for(lambda: app._exec_approval is not None and len(app._approval_queue) == 2)
    app._finish_exec_approval({"decision": "always"})
    app._finish_exec_approval({"decision": "approve"})
    _wait_for(lambda: app._last_assistant_plain == "done" and not app._bridge.is_running)
    assert (tmp_path / "ws" / "note.txt").read_text() == "note"
    assert (tmp_path / "ws" / "approved.done").exists()


def test_yolo_change_does_not_reclassify_pending_call(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, responses=[
        _calls(("execute", {"command": "touch rejected.done"})),
        AIMessage(content="done"),
    ])
    app._on_submit("execute")
    _wait_for(lambda: app._exec_approval is not None and not app._bridge.is_running)
    app._on_submit("/yolo")
    app._finish_exec_approval({"decision": "reject"})
    _wait_for(lambda: app._last_assistant_plain == "done" and not app._bridge.is_running)
    assert not (tmp_path / "ws" / "rejected.done").exists()
    assert app._approvals.yolo_enabled(app._thread_id)


def test_always_rule_applies_to_new_call_in_same_turn(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, responses=[
        _calls(("write_file", {"file_path": "/first.txt", "content": "first"})),
        # A compatible endpoint may reuse call-0 in a later AI message.
        _calls(("write_file", {"file_path": "/later.txt", "content": "later"})),
        AIMessage(content="done"),
    ])
    app._on_submit("write files one after another")
    _wait_for(lambda: app._exec_approval is not None and not app._bridge.is_running)
    app._finish_exec_approval({"decision": "always"})
    _wait_for(lambda: app._last_assistant_plain == "done" and not app._bridge.is_running)
    assert (tmp_path / "ws" / "first.txt").read_text() == "first"
    assert (tmp_path / "ws" / "later.txt").read_text() == "later"
    assert app._exec_approval is None
    assert app._thread_id not in app._approvals._visible_turns


def test_yolo_applies_to_later_call_in_same_turn(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, responses=[
        _calls(("execute", {"command": "touch rejected.done"})),
        _calls(("execute", {"command": "touch later.done"})),
        AIMessage(content="done"),
    ])
    app._on_submit("run sequential commands")
    _wait_for(lambda: app._exec_approval is not None and not app._bridge.is_running)
    app._on_submit("/yolo")
    app._finish_exec_approval({"decision": "reject"})
    _wait_for(lambda: app._last_assistant_plain == "done" and not app._bridge.is_running)
    assert not (tmp_path / "ws" / "rejected.done").exists()
    assert (tmp_path / "ws" / "later.done").exists()
    assert app._exec_approval is None
    assert app._thread_id not in app._approvals._visible_turns


def test_reused_call_id_is_distinguished_by_tool_and_args(tmp_path):
    from types import SimpleNamespace

    from circle.approvals import default_policy

    policy = default_policy(tmp_path)
    policy.begin_visible_turn("same-thread")

    def request(name, args):
        return SimpleNamespace(
            tool_call={"id": "reused", "name": name, "args": args},
            runtime=SimpleNamespace(config={"configurable": {
                "thread_id": "same-thread", "circle_visible_turn": True,
            }}),
        )

    write_when = policy.interrupt_on(["write_file"])["write_file"]["when"]
    execute_when = policy.interrupt_on(["execute"])["execute"]["when"]
    args = {"command": "echo first"}
    assert execute_when(request("execute", args))
    policy.set_yolo("same-thread", True)
    assert not execute_when(request("execute", {"command": "echo second"}))
    assert not write_when(request("write_file", args))
    assert execute_when(request("execute", args)), "the original call keeps its result"
    policy.end_visible_turn("same-thread")
    assert not execute_when(request("execute", args)), "the memory ends with the turn"


def test_cancel_clears_call_decision_memory(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, responses=[
        _calls(("execute", {"command": "touch never.done"})),
    ])
    app._on_submit("run")
    _wait_for(lambda: app._exec_approval is not None and not app._bridge.is_running)
    assert app._approvals._visible_turns[app._thread_id]
    app._handle_key(KeyPress(key="ctrl+c", char="c", ctrl=True))
    assert app._thread_id not in app._approvals._visible_turns
