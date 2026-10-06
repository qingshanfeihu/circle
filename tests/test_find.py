"""ctrl+f finds text in the conversation, as pi's transcript search: the match is shown in
reverse video and scrolled into view; enter and shift+enter step through; esc closes."""

from __future__ import annotations

from circle.ink.parse_keypress import KeyPress
from circle.ink.theme import palette
from tests.test_plan_and_turns import _fake_session
from tests.test_tui_contract import plain


def _app(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 80, 20  # noqa: SLF001
    for i in range(30):
        app._transcript.append_message(f" ⏺ line {i}" + (" the Needle here" if i in (5, 20) else ""))  # noqa: SLF001
    return app


def _type(app, text):
    for ch in text:
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001


def test_find_marks_and_steps_through_matches(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    before = app._transcript.snapshot()  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+f", ctrl=True, char="f"))  # noqa: SLF001
    _type(app, "needle")
    state = app._find  # noqa: SLF001
    assert [before[i] for i in state["matches"]] == [before[5], before[20]]
    lit = app._transcript.message_at(state["matches"][state["at"]])  # noqa: SLF001
    assert f"{palette().reverse}Needle{palette().reset}" in lit
    assert "find: needle" in app._footer._hold_status and "/2" in app._footer._hold_status  # noqa: SLF001
    first = state["at"]
    app._handle_key(KeyPress(key="enter"))  # noqa: SLF001
    assert state["at"] == (first + 1) % 2
    assert app._transcript.message_at(state["matches"][first]) == before[state["matches"][first]]  # noqa: SLF001
    app._handle_key(KeyPress(key="escape"))  # noqa: SLF001
    assert app._find is None and app._transcript.snapshot() == before  # noqa: SLF001
    assert not app._footer._hold_status  # noqa: SLF001
    assert app._prompt.value == "", "nothing typed while finding reached the input box"  # noqa: SLF001


def test_find_says_when_nothing_matches(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._handle_key(KeyPress(key="ctrl+f", ctrl=True, char="f"))  # noqa: SLF001
    _type(app, "zebra")
    assert "no matches" in plain(app._footer._hold_status)  # noqa: SLF001
