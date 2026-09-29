"""The CTX meter never carries an old request across context changes."""

from __future__ import annotations

import time

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from circle.context_middleware import thread_config
from circle.testing import ScriptedModel
from tests.test_slash_behaviors import _app


def _show_old_context(app):
    app._footer.update(tokens_budget=200_000)
    app._apply_usage({"input_tokens": 180_000, "context_input_tokens": 180_000,
                      "output_tokens": 10})
    assert "CTX 180.0k/200.0k (90%)" in app._footer._session_summary()


@pytest.mark.parametrize("operation", ["new", "resume", "undo", "import"])
def test_session_changes_clear_stale_context(tmp_path, monkeypatch, operation):
    app = _app(tmp_path, monkeypatch)
    if operation == "resume":
        for i in range(4):
            app._transcript.append_message(f"saved turn {i}")
        app._cmd_new("")
    elif operation == "undo":
        app._push_undo_checkpoint()
    elif operation == "import":
        (app.workspace / "history.md").write_text("# prior chat\n")
    _show_old_context(app)

    if operation == "new":
        app._cmd_new("")
    elif operation == "resume":
        app._cmd_resume("1")
    elif operation == "undo":
        app._cmd_undo("")
    else:
        app._cmd_import("history.md")

    assert "CTX 180.0k" not in app._footer._session_summary()
    assert app._footer.context_input_tokens is None
    app._apply_usage({"input_tokens": 4_000, "context_input_tokens": 3_000,
                      "output_tokens": 10})
    assert "CTX 3.0k/200.0k" in app._footer._session_summary()


def test_compact_clears_old_context_until_next_model_usage(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app.model_override = ScriptedModel(responses=[AIMessage(content="COMPACT_OK")])
    app._rebuild_agent(model=app.model_override)
    app._agent.update_state(thread_config(app._thread_id), {
        "messages": [HumanMessage(content="a"), AIMessage(content="b")],
    })
    _show_old_context(app)
    app._cmd_compact("")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and app._is_loading:
        time.sleep(0.01)
    assert not app._is_loading
    assert "— compacted" in "\n".join(app._transcript.snapshot())
    assert app._footer.context_input_tokens is None
    assert "CTX 180.0k" not in app._footer._session_summary()
