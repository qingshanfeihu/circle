"""The CTX meter never carries an old request across context changes."""

from __future__ import annotations

import time

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from circle.context_middleware import thread_config
from circle.testing import ScriptedModel
from tests.test_slash_behaviors import _app


def _show_old_context(app):
    app._footer.update(tokens_budget=200_000)
    app._apply_usage({"input_tokens": 180_000, "context_input_tokens": 180_000,
                      "output_tokens": 10})
    assert "ctx 180.0k/200.0k (90%)" in app._footer._session_summary()


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

    assert "ctx 180.0k" not in app._footer._session_summary()
    assert app._footer.context_input_tokens is None
    app._apply_usage({"input_tokens": 4_000, "context_input_tokens": 3_000,
                      "output_tokens": 10})
    assert "ctx 3.0k/200.0k" in app._footer._session_summary()


def _compact_with(app, *replies):
    """Run /compact with the agent answering as given: the tool's result, then the model."""
    app._agent.update_state(thread_config(app._thread_id), {
        "messages": [HumanMessage(content="a"), AIMessage(content="b")],
    })
    app._agent.invoke = lambda *_a, **_k: {"messages": [HumanMessage(content="compact"), *replies]}
    app._cmd_compact("")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and app._is_loading:
        time.sleep(0.01)
    assert not app._is_loading
    return "\n".join(app._transcript.snapshot())


def test_compact_clears_old_context_until_next_model_usage(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app.model_override = ScriptedModel(responses=[AIMessage(content="COMPACT_OK")])
    app._rebuild_agent(model=app.model_override)
    _show_old_context(app)
    shown = _compact_with(app, ToolMessage(
        content="Conversation compacted. Summarized 12 messages into a concise summary.",
        name="compact_conversation", tool_call_id="c1"), AIMessage(content="COMPACT_OK"))
    assert "— compacted · summarized 12 messages into a concise summary —" in shown
    assert app._footer.context_input_tokens is None
    assert "ctx 180.0k" not in app._footer._session_summary()


def test_compact_says_plainly_when_nothing_was_compacted(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    shown = _compact_with(app, ToolMessage(
        content="Nothing to compact yet — conversation is within the token budget.",
        name="compact_conversation", tool_call_id="c1"), AIMessage(content="Nothing to do."))
    assert "compacted" not in shown
    assert app._footer._toast_text == "Nothing to compact yet · the conversation fits in the context"
    shown = _compact_with(app, AIMessage(content="I would rather not."))
    assert "Not compacted: the model did not run the compaction · it said: I would rather not." in shown
