"""/settings as pi's: a list where enter changes the marked setting and saves it."""

from __future__ import annotations

from circle.ink.parse_keypress import KeyPress
from circle.settings import load_settings
from tests.test_slash_behaviors import _app


def _keys(app, *keys):
    for key in keys:
        app._handle_key(KeyPress(key=key, char=key if len(key) == 1 else ""))  # noqa: SLF001


def _search(app, text):
    for ch in text:
        _keys(app, ch)


def test_enter_changes_a_setting_and_saves_it(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/settings")  # noqa: SLF001
    assert app._picker.title == "Settings"  # noqa: SLF001
    _search(app, "esc")
    _keys(app, "enter")
    assert app.settings.double_escape == "fork"
    assert load_settings(app.home).double_escape == "fork"
    _keys(app, "escape", "escape")  # clear the search, close the list
    app._on_submit("/settings")  # noqa: SLF001
    _search(app, "show")
    _keys(app, "enter")
    assert app._show_thinking is False and load_settings(app.home).hide_thinking  # noqa: SLF001


def test_esc_twice_does_what_the_setting_says(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    opened: list[str] = []
    monkeypatch.setattr(app, "_open_tree", lambda *a: opened.append("tree"))
    monkeypatch.setattr(app, "_open_fork_picker", lambda *a: opened.append("fork"))
    for action in ("fork", "none", "tree"):
        app.settings.double_escape = action
        _keys(app, "escape", "escape")
        app._last_esc_at = 0.0  # noqa: SLF001
    assert opened == ["fork", "tree"]


def test_ctrl_x_copies_the_last_answer(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    copied: list[str] = []
    app._clipboard_set = lambda text: copied.append(text) or True  # noqa: SLF001
    app._last_assistant_plain = "the answer"  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+x", ctrl=True, char="x"))  # noqa: SLF001
    assert copied and "the answer" in copied[-1]
