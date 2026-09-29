"""A stored plan reminder stays out of the live and restored transcript."""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage

from circle.middleware.plan_tail import REMINDER_MARKER, is_plan_reminder
from circle.settings import CircleSettings, ModelAuth, save_settings
from circle.testing import ScriptedModel
from circle.tui.harness_bridge import HarnessBridge
from circle.tui.session_app import CircleSessionApp


def _wait(predicate, *, seconds: float = 8) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("session did not finish")


def test_live_bridge_discards_marked_reminder():
    reminder = HumanMessage(content="private plan reminder",
                            additional_kwargs={REMINDER_MARKER: True})

    class FakeAgent:
        def stream(self, *args, **kwargs):
            yield (reminder, {})
            yield (AIMessage(content="answer"), {})

        def get_state(self, _config):
            return SimpleNamespace(interrupts=(), values={"messages": [
                HumanMessage(content="go"), reminder, AIMessage(content="answer"),
            ]})

    updates = []
    done = []
    errors = []
    bridge = HarnessBridge(
        agent=FakeAgent(), thread_id="tui-test", on_update=updates.append,
        on_interrupt=lambda _value: None, on_done=done.append, on_error=errors.append,
    )
    bridge.start("go")
    _wait(lambda: bool(done or errors))
    assert errors == [] and done == ["answer"]
    assert not any("private plan reminder" in update.text for update in updates)


def test_resume_export_and_undo_never_show_reminder(tmp_path: Path, monkeypatch):
    home, workspace = tmp_path / "home", tmp_path / "workspace"
    workspace.mkdir()
    for i in range(10):
        (workspace / f"part-{i}.txt").write_text(f"part {i}\n", encoding="utf-8")
    settings = CircleSettings(
        initialized=True, trusted_folders=[str(workspace)],
        auth=ModelAuth(mode="api_key", protocol="openai",
                       base_url="http://127.0.0.1:9", model="test-model"),
    )
    save_settings(settings, home=home)
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    todos = [{"content": "compile", "status": "in_progress"}]
    responses = [
        AIMessage(content="", tool_calls=[{
            "name": "write_todos", "args": {"todos": todos}, "id": "plan", "type": "tool_call",
        }]),
    ]
    responses += [AIMessage(content="", tool_calls=[{
        "name": "read_file", "args": {"file_path": f"/part-{i}.txt"},
        "id": f"read-{i}", "type": "tool_call",
    }]) for i in range(10)]
    responses.append(AIMessage(content="Finished."))
    model = ScriptedModel(responses=responses)
    app = CircleSessionApp(settings, workspace, home=home, model_override=model)
    app._on_submit("compile")
    _wait(lambda: not app._bridge.is_running and model.i >= 12)
    state = app._agent.get_state({"configurable": {"thread_id": app._thread_id}})
    assert any(is_plan_reminder(msg) for msg in state.values["messages"])
    assert "automatically added reminder" not in "\n".join(app._transcript.snapshot())
    assert [node.text for node in app._session_tree.path_to() if node.role == "user"] == [
        "compile",
    ]
    assert len(app._undo_stack) == 1

    export = tmp_path / "session.md"
    app._on_submit(f"/export {export}")
    assert "automatically added reminder" not in export.read_text(encoding="utf-8")
    old_id = app._thread_id
    app._on_submit("/new")
    app._on_submit(f"/resume {old_id}")
    assert app._thread_id == old_id
    assert "automatically added reminder" not in "\n".join(app._transcript.snapshot())
    app._on_submit("/undo")
    assert "automatically added reminder" not in "\n".join(app._transcript.snapshot())
