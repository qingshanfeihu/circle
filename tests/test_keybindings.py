"""keybindings.json gives Circle's actions other keys, as pi's does."""

from __future__ import annotations

import json

from circle.ink.parse_keypress import KeyPress
from circle.keybindings import load_remap
from tests.test_plan_and_turns import _fake_session


def test_the_file_maps_keys_to_actions(tmp_path):
    (tmp_path / "keybindings.json").write_text(json.dumps(
        {"model.select": "ctrl+k", "find": ["ctrl+f", "alt+/"], "warp": "f9", "copy": 3}),
        encoding="utf-8")
    remap, problems = load_remap(tmp_path)
    assert remap == {"ctrl+k": "ctrl+l", "alt+/": "ctrl+f"}
    assert problems == ["unknown action 'warp' in keybindings.json",
                        "unknown action 'copy' in keybindings.json"]
    assert load_remap(tmp_path / "missing") == ({}, [])


def test_a_bound_key_does_the_action(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 80, 24  # noqa: SLF001
    app._key_remap = {"f2": "ctrl+f"}  # noqa: SLF001
    app._handle_input(KeyPress(key="f2"))  # noqa: SLF001
    assert app._find is not None, "f2 opened find"  # noqa: SLF001
    app._handle_input(KeyPress(key="escape"))  # noqa: SLF001
    assert app._find is None, "escape still closes it"  # noqa: SLF001


def test_function_keys_have_names():
    from circle.ink.parse_keypress import InputParser

    assert [e.key for e in InputParser().feed("\x1bOQ\x1b[15~\x1b[24~")] == ["f2", "f5", "f12"]


def test_a_key_handler_that_raises_does_not_stop_the_input(tmp_path):
    import threading
    from types import SimpleNamespace

    from circle.ink.app import InkApp

    app = InkApp(alt_screen=False)
    chunks = ["ab", ""]  # two keys, then the input closes
    app._terminal = SimpleNamespace(read_input=lambda _stop: chunks.pop(0))  # noqa: SLF001
    app._input_stop = threading.Event()  # noqa: SLF001
    app._running = True  # noqa: SLF001
    seen: list[str] = []

    def handler(event):
        seen.append(event.key)
        if event.key == "a":
            raise RuntimeError("bad key")

    app.on_input = handler
    app._read_input()  # noqa: SLF001 - returns when the input closes
    assert seen == ["a", "b"]
