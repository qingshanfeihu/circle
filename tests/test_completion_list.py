"""Typing ``/`` or ``@`` lists what it can become above the input box, as pi does: ↑ ↓ move,
tab takes the marked entry, enter takes a command and runs it, esc closes the list."""

from __future__ import annotations

from circle.ink.parse_keypress import KeyPress
from tests.test_plan_and_turns import _fake_session
from tests.test_tui_contract import plain


def _app(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 30  # noqa: SLF001
    return app


def _type(app, text):
    for ch in text:
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001


def _key(app, key):
    app._handle_key(KeyPress(key=key, char="\t" if key == "tab" else ""))  # noqa: SLF001


def _listed(app):
    return [value for value, _label, _meta in (app._completion or {}).get("items", [])]  # noqa: SLF001


def _panel(app):
    return "\n".join(plain(node.value) for node in app._ask_panel.node.children  # noqa: SLF001
                     if hasattr(node, "value"))


def test_slash_lists_commands_and_tab_takes_the_marked_one(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _type(app, "/")
    assert "/help" in _listed(app) and "commands" in _panel(app)
    _type(app, "mo")
    assert _listed(app) == ["/models"]
    assert "Choose a model" in _panel(app)
    _key(app, "tab")
    assert app._prompt.value == "/models " and app._completion is None  # noqa: SLF001
    assert _panel(app) == ""


def test_enter_on_a_command_runs_it(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    ran: list[str] = []
    monkeypatch.setattr(app, "_dispatch_slash", lambda name, args: ran.append(name))
    _type(app, "/hotk")
    assert _listed(app) == ["/hotkeys"]
    _key(app, "enter")
    assert ran == ["hotkeys"] and app._prompt.value == ""  # noqa: SLF001


def test_esc_closes_the_list_and_keeps_the_text(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _type(app, "/he")
    _key(app, "escape")
    assert app._completion is None and app._prompt.value == "/he"  # noqa: SLF001
    _type(app, "l")
    assert _listed(app) == ["/help"], "typing again opens it again"


def test_arrows_move_in_the_list_not_through_history(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._input_history.add("an older message")  # noqa: SLF001
    _type(app, "/")
    _key(app, "up")
    assert app._prompt.value == "/"  # noqa: SLF001
    assert app._completion["focus"] == len(_listed(app)) - 1, "it wraps around"  # noqa: SLF001


def test_at_lists_files_and_a_folder_opens_its_entries(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    (app.workspace / "src").mkdir()
    (app.workspace / "src" / "main.py").write_text("x", encoding="utf-8")
    (app.workspace / "setup.cfg").write_text("x", encoding="utf-8")
    _type(app, "read @s")
    assert _listed(app) == ["@setup.cfg", "@src/"] and "files" in _panel(app)
    _key(app, "down")
    _key(app, "tab")
    assert app._prompt.value == "read @src/"  # noqa: SLF001
    assert _listed(app) == ["@src/main.py"]
    _key(app, "enter")
    assert app._prompt.value == "read @src/main.py "  # noqa: SLF001
    assert app._completion is None, "enter takes a file and does not send"  # noqa: SLF001


def test_editing_keys_from_pi(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _type(app, "first line\\")
    _key(app, "enter")
    _type(app, "second")
    assert app._prompt.value == "first line↵second", "backslash then enter is a line break"  # noqa: SLF001
    app._app._running = True  # noqa: SLF001
    app._prompt.set_value("abc", cursor=1)  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+d", ctrl=True, char="d"))  # noqa: SLF001
    assert app._prompt.value == "ac" and app._app._running, "with text, ctrl+d deletes"  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+c", ctrl=True, char="c"))  # noqa: SLF001
    assert app._prompt.value == "" and app._app._running, "the first ctrl+c clears the text"  # noqa: SLF001
    assert app._input_history.up("") == "ac", "and keeps it in the history"  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+d", ctrl=True, char="d"))  # noqa: SLF001
    assert not app._app._running, "from an empty box ctrl+d exits"  # noqa: SLF001


def test_a_paste_updates_the_list(tmp_path, monkeypatch):
    from circle.ink.parse_keypress import PasteEvent

    app = _app(tmp_path, monkeypatch)
    ran: list[str] = []
    monkeypatch.setattr(app, "_dispatch_slash", lambda name, args: ran.append(f"{name} {args}"))
    _type(app, "/mo")
    app._handle_input(PasteEvent(text="dels step-3"))  # noqa: SLF001
    assert app._completion is None  # noqa: SLF001
    _key(app, "enter")
    assert ran == ["models step-3"], "the pasted words are kept and sent"
    app._prompt.set_value("look at @")  # noqa: SLF001 - as a draft put back would
    app._completion = {"kind": "file", "start": 8, "token": "@",  # noqa: SLF001
                       "items": [("@README.md", "README.md", "")], "focus": 0,
                       "focused": "@README.md", "value": "look at @", "cursor": 9}
    app._prompt.set_value("look at @src/app.py")  # noqa: SLF001
    _key(app, "tab")
    assert app._prompt.value == "look at @src/app.py", "a list made for older text is not used"  # noqa: SLF001
