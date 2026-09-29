"""A cancelled Bridge turn cannot show a late panel or resume a stale token."""

from __future__ import annotations

from langchain_core.messages import AIMessage

from circle.ink.parse_keypress import KeyPress
from circle.middleware.cancellation import CancellationToken
from tests.test_approval_decision_stability import _calls
from tests.test_bridge_approval_cancel_regressions import (
    SequentialSubagentModel,
    _bridge,
    _wait_for,
)
from tests.test_slash_behaviors import _app


def test_cancel_between_stream_and_interrupt_skips_panel(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, responses=[
        _calls(("execute", {"command": "touch should-not-run"})),
        AIMessage(content="never"),
    ])
    original = app._bridge._on_interrupt

    def cancel_before_panel(interrupts):
        app._handle_key(KeyPress(key="escape"))
        original(interrupts)

    app._bridge._on_interrupt = cancel_before_panel
    app._on_submit("run")
    _wait_for(lambda: not app._bridge.is_running)
    assert app._bridge._cancelled
    assert app._exec_approval is None and not app._ask_panel.is_visible
    assert not (app.workspace / "should-not-run").exists()
    assert app._last_assistant_plain == ""

    app._bridge.resume({"decision": "approve"})
    assert not app._bridge.is_running
    assert not (app.workspace / "should-not-run").exists()


def test_resume_recreates_missing_turn_token_on_real_bridge(tmp_path):
    bridge, interrupts, done, errors = _bridge(SequentialSubagentModel(), tmp_path)
    bridge.start("MAIN")
    _wait_for(lambda: len(interrupts) == 1 and not bridge.is_running)
    bridge._cancel_token = None
    seen_tokens = []
    original = bridge._run_with

    def capture(payload, config, bus):
        seen_tokens.append(config["configurable"]["circle_cancel_token"])
        return original(payload, config, bus)

    bridge._run_with = capture
    bridge.resume({"decision": "reject"})
    _wait_for(lambda: len(interrupts) == 2 and not bridge.is_running)
    assert len(seen_tokens) == 1 and isinstance(seen_tokens[0], CancellationToken)
    assert seen_tokens[0] is bridge._cancel_token
    bridge.cancel()
    assert not done and not errors
