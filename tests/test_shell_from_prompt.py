"""``!command`` runs a command yourself and shows the model its output with your next
message; ``!!command`` keeps it to you; esc stops it."""

from __future__ import annotations

import os
import sys
import time

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from circle.harness import create_harness
from circle.ink.parse_keypress import KeyPress
from circle.testing import ScriptedModel
from circle.tui.replay import saved_turns
from circle.tui.transcript_view import ViewOptions, render_turn
from tests.test_tui_contract import _fake_session, plain


def _app(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 30  # noqa: SLF001
    app._agent = create_harness(  # noqa: SLF001
        ScriptedModel(responses=[AIMessage(content="ok")]), root_dir=app.workspace,
        home=app.home, checkpointer=app._checkpointer)  # noqa: SLF001
    return app


def _type(app, text: str) -> None:
    for ch in text:
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._handle_key(KeyPress(key="enter"))  # noqa: SLF001


def _idle(app, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while app._is_loading and time.monotonic() < deadline:  # noqa: SLF001
        time.sleep(0.02)
    assert not app._is_loading  # noqa: SLF001


def _history(app) -> list:
    state = app._agent.get_state({"configurable": {"thread_id": app._thread_id}})  # noqa: SLF001
    return list(state.values.get("messages", []))


def test_bang_runs_the_command_and_shares_the_output(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    (app.workspace / "notes.txt").write_text("alpha-line\n")
    command = "type notes.txt" if os.name == "nt" else "cat notes.txt"  # runs in the workspace
    _type(app, f"!{command}")
    _idle(app)
    shown = "\n".join(plain(row) for row in app._transcript.snapshot())  # noqa: SLF001
    assert f" › !{command}" in shown and f"Bash({command})" in shown
    assert "alpha-line" in shown
    [message] = _history(app)
    assert isinstance(message, HumanMessage) and "alpha-line" in message.content
    assert message.additional_kwargs["circle_shell"]["command"] == command


def test_double_bang_keeps_the_output_to_you(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _type(app, "!!echo private")
    _idle(app)
    assert "private" in "\n".join(plain(r) for r in app._transcript.snapshot())  # noqa: SLF001
    assert _history(app) == []


# esc ends a running command only where commands run in their own process group
_POSIX_STOP = pytest.mark.skipif(sys.platform == "win32",
                                 reason="commands cannot be stopped on Windows yet")


@_POSIX_STOP
@pytest.mark.parametrize("key", [KeyPress(key="escape"), KeyPress(key="ctrl+c", ctrl=True, char="c")])
def test_esc_and_ctrl_c_stop_a_bang_command(tmp_path, monkeypatch, key):
    app = _app(tmp_path, monkeypatch)
    _type(app, "!sleep 30; touch late")
    assert app._is_loading  # noqa: SLF001
    time.sleep(0.3)
    started = time.monotonic()
    app._handle_key(key)  # noqa: SLF001
    assert not app._is_loading and time.monotonic() - started < 1  # noqa: SLF001
    time.sleep(1.5)
    assert not (app.workspace / "late").exists()
    assert _history(app) == [], "a stopped command shares nothing"


def test_a_bang_while_busy_comes_back(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._is_loading = True  # noqa: SLF001
    _type(app, "!ls")
    assert app._prompt.value == "!ls"  # noqa: SLF001
    assert app._footer._toast_text.startswith("Busy")  # noqa: SLF001


def test_a_shared_command_is_drawn_again_when_the_session_reopens():
    message = HumanMessage(content="I ran this command myself:\n$ ls\na.py", additional_kwargs={
        "circle_shell": {"command": "ls", "output": "a.py", "exit_code": 0}})
    [(text, snap)] = saved_turns([message])
    assert text == "!ls"
    assert "Bash(ls)" in plain("\n".join(render_turn(snap, ViewOptions(width=80))))


def test_a_session_that_starts_with_a_command_is_named_after_it(tmp_path, monkeypatch):
    from circle import session_index

    app = _app(tmp_path, monkeypatch)
    _type(app, "!echo hi")
    _idle(app)
    assert app._session_title == "!echo hi"  # noqa: SLF001
    assert session_index.latest(app.home, app.workspace).title == "!echo hi"


@_POSIX_STOP
def test_a_turn_opened_after_esc_keeps_its_place_when_the_command_row_grows(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _type(app, "!sleep 30")
    time.sleep(0.3)
    app._handle_key(KeyPress(key="escape"))  # noqa: SLF001
    # A turn starts right away, below the command's single running row.
    app._transcript.append_message(" › next")  # noqa: SLF001
    app._open_turn_region()  # noqa: SLF001
    region = app._turn_base  # noqa: SLF001
    marker = app._transcript.snapshot()[region - 1]  # noqa: SLF001
    deadline = time.monotonic() + 5
    while not any("Stopped" in plain(r) for r in app._transcript.snapshot()):  # noqa: SLF001
        assert time.monotonic() < deadline
        time.sleep(0.02)
    time.sleep(0.1)
    assert app._turn_base == region  # noqa: SLF001 — the command's row is one entry either way
    assert app._transcript.snapshot()[region - 1] == marker  # noqa: SLF001
