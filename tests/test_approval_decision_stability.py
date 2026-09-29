"""Decisions must stay attached to the calls that originally interrupted."""

from __future__ import annotations

import time

import pytest
from langchain_core.messages import AIMessage

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


def test_yolo_change_during_approval_applies_after_current_turn(tmp_path, monkeypatch):
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
