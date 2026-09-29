"""Yolo belongs to visible Bridge turns, not internal graph invocations."""

from __future__ import annotations

import time

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from circle.approvals import default_policy
from circle.context_middleware import thread_config
from circle.harness import create_harness
from circle.testing import ScriptedModel
from tests.test_approval_decision_stability import _calls
from tests.test_slash_behaviors import _app


def test_nonvisible_invoke_still_interrupts_with_yolo_enabled(tmp_path):
    policy = default_policy(tmp_path / "home")
    policy.set_yolo("internal", True)
    agent = create_harness(ScriptedModel(responses=[
        _calls(("execute", {"command": "rm victim.txt"})),
    ]), root_dir=tmp_path, home=tmp_path / "home", approvals=policy)
    (tmp_path / "victim.txt").write_text("keep")
    paused = agent.invoke({"messages": [{"role": "user", "content": "internal"}]},
                          config=thread_config("internal"))
    assert paused.get("__interrupt__")
    assert (tmp_path / "victim.txt").read_text() == "keep"


def test_compact_reports_approval_interrupt_without_running_tool(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, responses=[
        _calls(("execute", {"command": "rm victim.txt"})),
        AIMessage(content="COMPACT_OK"),
    ])
    (app.workspace / "victim.txt").write_text("keep")
    app._agent.update_state(thread_config(app._thread_id), {
        "messages": [HumanMessage(content="a"), AIMessage(content="b")],
    })
    app._on_submit("/yolo")
    app._on_submit("/compact")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and app._is_loading:
        time.sleep(0.01)
    if app._is_loading:
        pytest.fail("compact worker did not finish")
    transcript = "\n".join(app._transcript.snapshot())
    assert "遇到需要审批" in transcript
    assert "— compacted" not in transcript
    assert (app.workspace / "victim.txt").read_text() == "keep"
