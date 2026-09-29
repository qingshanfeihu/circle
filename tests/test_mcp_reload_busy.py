"""MCP reload cannot orphan a running Bridge or overlap graph runs."""

from __future__ import annotations

import threading
import time

import pytest

from circle.ink.parse_keypress import KeyPress
from tests.test_slash_behaviors import _app
from tests.test_stream_cancel_usage import PausedParallelModel


def _wait_for(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    pytest.fail("session did not reach expected state")


def test_mcp_reload_during_parallel_workers_keeps_original_bridge(tmp_path, monkeypatch):
    PausedParallelModel.gate = threading.Event()
    PausedParallelModel.entered = []
    PausedParallelModel.calls = []
    app = _app(tmp_path, monkeypatch)
    app.model_override = PausedParallelModel()
    app._rebuild_agent(model=app.model_override)
    original_bridge = app._bridge

    app._on_submit("MAIN")
    _wait_for(lambda: len(PausedParallelModel.entered) == 2)
    app._on_submit("/mcp reload")
    assert app._bridge is original_bridge
    assert "reload MCP after the current turn" in (app._footer._toast_text or "")  # noqa: SLF001

    app._start_user_turn("NEXT")
    assert app._msg_queue == [("steering", "NEXT")]
    assert "NEXT" not in PausedParallelModel.calls

    app._handle_key(KeyPress(key="ctrl+c", char="c", ctrl=True))
    PausedParallelModel.gate.set()
    _wait_for(lambda: not original_bridge.is_running)
    assert not list(app.workspace.glob("SUB*.done"))
    assert app._bridge is original_bridge
