"""Yolo is decided before HITL interrupts, including in parallel subagents."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from circle.approvals import default_policy
from circle.harness import create_harness, sandbox_backend
from tests.test_approvals import _session
from tests.test_parallel_interrupts import ParallelSubagentModel


def _request(thread_id: str, command: str) -> SimpleNamespace:
    return SimpleNamespace(
        tool_call={"args": {"command": command}},
        runtime=SimpleNamespace(config={"configurable": {"thread_id": thread_id}}),
    )


def test_yolo_predicate_changes_live_and_remains_thread_scoped(tmp_path: Path):
    policy = default_policy(tmp_path)
    when = policy.interrupt_on(["execute"])["execute"]["when"]
    ask = _request("one", "echo hello")
    forced = _request("one", "rm victim.txt")
    assert when(ask) and when(forced)
    policy.set_yolo("one", True)
    assert not when(ask) and not when(forced)
    assert when(_request("two", "echo hello"))
    policy.set_yolo("one", False)
    assert when(ask) and when(forced)


def test_yolo_command_updates_the_shared_policy_and_new_thread_starts_off(
        tmp_path: Path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._on_submit("/yolo")
    old_thread = app._thread_id
    assert app._approvals.yolo_enabled(old_thread) and app._bridge.auto_approve
    app._on_submit("/yolo off")
    assert not app._approvals.yolo_enabled(old_thread)
    assert not app._bridge.auto_approve
    app._on_submit("/yolo")
    app._on_submit("/new")
    assert app._thread_id != old_thread
    assert not app._approvals.yolo_enabled(app._thread_id)
    assert not app._bridge.auto_approve and not app._footer._yolo_enabled


def test_yolo_still_approves_an_already_pending_interrupt(tmp_path: Path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._on_submit("/yolo")
    resumed = []
    monkeypatch.setattr(app._bridge, "resume", resumed.append)
    app._on_interrupt([SimpleNamespace(id="pending", value={"action_requests": [
        {"name": "execute", "args": {"command": "echo pending"}},
    ]})])
    assert resumed == [{"decisions": [{"type": "approve"}]}]
    assert app._exec_approval is None


def test_yolo_parallel_subagents_execute_without_interrupt(tmp_path: Path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    policy = default_policy(home)
    policy.set_yolo("parallel", True)
    agent = create_harness(
        ParallelSubagentModel(), root_dir=ws, home=home, approvals=policy,
    )
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "MAIN"}]},
        config={"configurable": {"thread_id": "parallel"}},
    )
    assert not result.get("__interrupt__")
    assert all((ws / f"SUB{index}.done").exists() for index in range(2))


def test_yolo_does_not_bypass_backend_denial(tmp_path: Path):
    policy = default_policy(tmp_path / "home")
    policy.set_yolo("one", True)
    assert not policy.needs_approval("execute", {"command": "sudo touch denied"}, "one")
    backend = sandbox_backend(tmp_path)
    backend.command_guard = policy.deny_message
    result = backend.execute("sudo touch denied")
    assert result.exit_code == 126
    assert not (tmp_path / "denied").exists()


def test_yolo_off_parallel_subagents_still_interrupt(tmp_path: Path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    policy = default_policy(home)
    agent = create_harness(
        ParallelSubagentModel(), root_dir=ws, home=home, approvals=policy,
    )
    paused = agent.invoke(
        {"messages": [{"role": "user", "content": "MAIN"}]},
        config={"configurable": {"thread_id": "parallel"}},
    )
    assert len(paused.get("__interrupt__") or ()) == 2
    assert not any(ws.iterdir())
