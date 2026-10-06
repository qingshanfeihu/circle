"""Models and thinking depth, as in pi: pickers, cycling, and changes that last for the
session unless saved with ctrl+s."""

from __future__ import annotations

import json

from langchain_core.messages import AIMessage

from circle.ink.parse_keypress import KeyPress
from circle.testing import ScriptedModel
from tests.test_slash_behaviors import _app


def _ready(tmp_path, monkeypatch, models=("model-a", "model-b", "model-c")):
    app = _app(tmp_path, monkeypatch)
    app._list_models = lambda: list(models)  # noqa: SLF001
    monkeypatch.setattr("circle.tui.session_app.build_chat_model",
                        lambda *a, **k: ScriptedModel(responses=[AIMessage(content="ok")]))
    monkeypatch.delenv("CIRCLE_REASONING_EFFORT", raising=False)
    return app


def _saved_model(app) -> str:
    return json.loads((app.home / "settings.json").read_text())["auth"]["model"]


def _key(app, key, **kw):
    app._handle_key(KeyPress(key=key, **kw))  # noqa: SLF001


def test_the_model_picker_switches_for_the_session_and_saves_with_ctrl_s(tmp_path, monkeypatch):
    app = _ready(tmp_path, monkeypatch)
    before = _saved_model(app)
    _key(app, "ctrl+l", ctrl=True, char="l")
    assert app._picker is not None and app._picker.title == "Model"  # noqa: SLF001
    for ch in "b":
        _key(app, ch, char=ch)
    _key(app, "enter")
    assert app.settings.auth.model == "model-b" and _saved_model(app) == before
    app._on_submit("/models")  # noqa: SLF001
    for ch in "model-c":
        _key(app, ch, char=ch)
    _key(app, "ctrl+s", ctrl=True, char="s")
    assert app.settings.auth.model == "model-c" and _saved_model(app) == "model-c"


def test_ctrl_p_cycles_through_the_scope(tmp_path, monkeypatch):
    app = _ready(tmp_path, monkeypatch)
    app.settings.enabled_models = ["model-c", "model-a"]
    app.settings.auth.model = "model-c"
    _key(app, "ctrl+p", ctrl=True, char="p")
    assert app.settings.auth.model == "model-a"
    _key(app, "ctrl+p", ctrl=True, char="p")
    assert app.settings.auth.model == "model-c"
    app.settings.enabled_models = ["model-*"]
    _key(app, "ctrl+p", ctrl=True, char="p")
    assert app.settings.auth.model == "model-a", "a glob matches the listed models in order"


def test_thinking_depth_cycles_and_shows_in_the_header(tmp_path, monkeypatch):
    import os

    app = _ready(tmp_path, monkeypatch)
    # What a real model reports: the depth it was built with
    monkeypatch.setattr("circle.tui.session_app.reasoning_effort_of",
                        lambda _model: os.environ.get("CIRCLE_REASONING_EFFORT", ""))
    app._on_submit("/thinking high")  # noqa: SLF001
    assert os.environ["CIRCLE_REASONING_EFFORT"] == "high"
    _key(app, "shift+tab", shift=True)
    assert os.environ["CIRCLE_REASONING_EFFORT"] == "xhigh"
    app._sync_header(100)  # noqa: SLF001
    assert f"{app.settings.auth.model} • xhigh" in app._header_text.value  # noqa: SLF001
    app._on_submit("/thinking")  # noqa: SLF001 — bare /thinking still hides the rows
    assert app._show_thinking is False  # noqa: SLF001


def test_the_thinking_picker_saves_a_default(tmp_path, monkeypatch):
    app = _ready(tmp_path, monkeypatch)
    app._on_submit("/effort")  # noqa: SLF001
    assert app._picker.title == "Thinking depth"  # noqa: SLF001
    for ch in "medium":
        _key(app, ch, char=ch)
    _key(app, "ctrl+s", ctrl=True, char="s")
    saved = json.loads((app.home / "settings.json").read_text())
    assert saved["default_thinking"] == "medium" and app._picker is None  # noqa: SLF001


def test_tab_in_the_model_picker_chooses_what_ctrl_p_goes_through(tmp_path, monkeypatch):
    app = _ready(tmp_path, monkeypatch)
    app._on_submit("/models")  # noqa: SLF001
    for ch in "model-b":
        _key(app, ch, char=ch)
    _key(app, "tab")
    assert app.settings.enabled_models == ["model-b"]
    saved = json.loads((app.home / "settings.json").read_text())
    assert saved["enabled_models"] == ["model-b"]
    assert "in ctrl+p" in app._picker.focused().meta  # noqa: SLF001
    _key(app, "tab")
    assert app.settings.enabled_models == []


def test_a_run_only_list_stays_run_only_when_emptied(tmp_path, monkeypatch):
    from circle.run_options import RunOptions

    app = _ready(tmp_path, monkeypatch)
    app._run_options = RunOptions(models=["model-b"])  # noqa: SLF001
    app.settings.enabled_models = ["model-c"]
    app._on_submit("/models")  # noqa: SLF001
    for ch in "model-b":
        _key(app, ch, char=ch)
    _key(app, "tab")
    assert app._run_options.models == [] and app.settings.enabled_models == ["model-c"]  # noqa: SLF001
    assert app._model_scope() == app._known_models(), "every listed model"  # noqa: SLF001
    for _ in "model-b":
        _key(app, "backspace")
    for ch in "model-a":
        _key(app, ch, char=ch)
    _key(app, "tab")
    assert app._run_options.models == ["model-a"]  # noqa: SLF001
    saved = json.loads((app.home / "settings.json").read_text())
    assert saved.get("enabled_models", []) != ["model-a"], "never written to settings.json"
