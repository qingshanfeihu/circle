"""/login in a session: a list of the ways to sign in, then setup's questions (URL, key,
model) asked in pickers, and the session switched to what was chosen. No live endpoint."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from langchain_core.messages import AIMessage

from circle.ink.components.picker import Picker, PickerItem
from circle.ink.parse_keypress import KeyPress, PasteEvent
from circle.probe import ProbeResult
from circle.settings import (
    CircleSettings,
    ModelAuth,
    load_credentials,
    load_settings,
    save_credentials,
    save_settings,
)
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, InitStep, TrustController
from circle.tui.session_app import CircleSessionApp

OLD_URL = "https://old.example/claude"


def _app(tmp_path: Path, monkeypatch, *, probe=None) -> CircleSessionApp:
    """A session signed in with an API key, as after setup."""
    monkeypatch.delenv("CIRCLE_OAUTH_MOCK", raising=False)
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    settings = CircleSettings(initialized=True, auth=ModelAuth(
        mode="api_key", protocol="anthropic", base_url=OLD_URL, model="old-model"),
        enabled_models=["old-*"])
    save_settings(settings, home)
    save_credentials({"api_key": "old-key"}, home)
    TrustController(settings, ws, home=home).confirm()
    built: list[ModelAuth] = []

    def build(settings, **_kw):
        built.append(settings.auth)
        return ScriptedModel(responses=[AIMessage(content="ok")])

    monkeypatch.setattr("circle.tui.session_app.build_chat_model", build)
    app = CircleSessionApp(load_settings(home), ws, home=home,
                           model_override=ScriptedModel(responses=[AIMessage(content="r")]))
    app.built = built  # type: ignore[attr-defined]
    app.probed = []  # type: ignore[attr-defined]

    def fake_probe(url: str, key: str):
        app.probed.append((url, key))  # type: ignore[attr-defined]
        if probe is not None:
            return probe(url, key)
        return ProbeResult("anthropic", ["model-a", "model-b"], base_url=url)

    app._probe_endpoint = fake_probe  # noqa: SLF001
    return app


def _key(app: CircleSessionApp, key: str, **kw) -> None:
    app._handle_key(KeyPress(key=key, **kw))  # noqa: SLF001


def _type(app: CircleSessionApp, text: str) -> None:
    for ch in text:
        _key(app, ch, char=ch)


def _picker_text(app: CircleSessionApp) -> str:
    assert app._picker is not None  # noqa: SLF001
    return "\n".join(app._picker.render_lines(120))  # noqa: SLF001


def _wait(condition, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return
        time.sleep(0.02)
    raise AssertionError("timed out")


def _models_listed(app: CircleSessionApp) -> bool:
    picker = app._picker  # noqa: SLF001
    return picker is not None and bool(picker.matches()) and picker.matches()[0].key != "api_key"


def _snap(app: CircleSessionApp) -> str:
    return "\n".join(app._transcript.snapshot())  # noqa: SLF001


def test_bare_login_lists_the_ways_to_sign_in(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/login")  # noqa: SLF001
    picker = app._picker  # noqa: SLF001
    assert picker is not None and picker.title == "Sign in"
    assert [item.label for item in picker.matches()] == ["API URL + KEY", "OAuth sign-in"]
    assert picker.focused().key == "api_key", "the way in use is the one marked"
    shown = _picker_text(app)
    assert "now api key · old.example/claude · old-model" in shown
    assert "not available yet" in shown and "current" in shown
    assert "Usage" not in (app._footer._toast_text or "")  # noqa: SLF001


def test_oauth_is_listed_but_cannot_be_chosen_yet(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/login")  # noqa: SLF001
    _key(app, "down")
    _key(app, "enter")
    assert app._picker is not None and app._picker.focused().key == "oauth"  # noqa: SLF001
    assert "not available yet" in (app._footer._toast_text or "")  # noqa: SLF001
    assert load_settings(app.home).auth.base_url == OLD_URL


def test_login_asks_url_key_and_model_then_switches_the_session(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._model_list = ["old-model"]  # noqa: SLF001 — what the old endpoint listed
    app._on_submit("/login")  # noqa: SLF001
    _key(app, "enter")
    assert app._picker.asking  # noqa: SLF001
    assert f"base url: {OLD_URL}" in _picker_text(app), "the saved URL is there to keep or edit"
    _key(app, "ctrl+u", ctrl=True, char="u")
    _type(app, "https://new.example/v1")
    _key(app, "enter")
    assert "api key (enter keeps the saved one)" in _picker_text(app)
    app._handle_input(PasteEvent(text="sk-new-key\n"))  # noqa: SLF001
    shown = _picker_text(app)
    assert "••••••••••" in shown and "sk-new-key" not in shown
    assert app._prompt.value == "", "a pasted key never lands in the input box"  # noqa: SLF001
    _key(app, "enter")
    _wait(lambda: _models_listed(app))
    assert app.probed == [("https://new.example/v1", "sk-new-key")]
    _type(app, "model-b")
    _key(app, "enter")

    assert app._picker is None and app._login is None  # noqa: SLF001
    saved = load_settings(app.home)
    assert (saved.auth.mode, saved.auth.protocol, saved.auth.base_url, saved.auth.model) == (
        "api_key", "anthropic", "https://new.example/v1", "model-b")
    assert saved.enabled_models == [], "the old endpoint's ctrl+p models are cleared"
    assert saved.trusted_folders, "everything else is kept"
    assert load_credentials(app.home) == {"api_key": "sk-new-key"}
    assert app.settings.auth.model == "model-b" and app.model_override is None
    assert app.built[-1].base_url == "https://new.example/v1"
    assert app._model_list is None, "the new endpoint is asked again for ctrl+p"  # noqa: SLF001
    assert "Signed in to new.example/v1 · model model-b" in _snap(app)


def test_enter_keeps_the_saved_url_and_key(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/login")  # noqa: SLF001
    _key(app, "enter")
    _key(app, "enter")
    _key(app, "enter")
    _wait(lambda: _models_listed(app))
    assert app.probed == [(OLD_URL, "old-key")]
    _key(app, "enter")  # the first listed model
    assert load_credentials(app.home) == {"api_key": "old-key"}
    assert load_settings(app.home).auth.model == "model-a"
    assert load_settings(app.home).enabled_models == ["old-*"], "same endpoint: scope kept"


def test_a_bad_url_says_why_and_asks_again(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/login")  # noqa: SLF001
    _key(app, "enter")
    _key(app, "ctrl+u", ctrl=True, char="u")
    _type(app, "gateway.example")
    _key(app, "enter")
    assert app._picker.asking and "http(s)" in app._picker.title  # noqa: SLF001
    assert "base url: gateway.example" in _picker_text(app), "what was typed stays to fix"


def test_esc_leaves_login_without_changing_anything(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    before = (app.home / "settings.json").read_text()
    app._on_submit("/login")  # noqa: SLF001
    _key(app, "enter")
    _key(app, "escape")
    assert app._picker is not None and not app._picker.asking, "esc goes back to the list"  # noqa: SLF001
    _key(app, "escape")
    assert app._picker is None and app._login is None  # noqa: SLF001
    assert (app.home / "settings.json").read_text() == before
    assert load_credentials(app.home) == {"api_key": "old-key"}


def test_esc_while_the_endpoint_is_asked_drops_its_answer(tmp_path, monkeypatch):
    release = threading.Event()

    def slow(url, key):
        release.wait(5)
        return ProbeResult("openai", ["late-model"], base_url=url)

    app = _app(tmp_path, monkeypatch, probe=slow)
    before = (app.home / "settings.json").read_text()
    app._on_submit("/login")  # noqa: SLF001
    for _ in range(3):
        _key(app, "enter")
    assert "asking old.example/claude for its models" in _picker_text(app)
    _key(app, "escape")
    release.set()
    time.sleep(0.2)
    assert app._picker is None, "the late answer opens nothing"  # noqa: SLF001
    assert (app.home / "settings.json").read_text() == before


def test_a_failed_probe_asks_which_api_and_takes_a_typed_model(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, probe=lambda url, key: None)
    app._on_submit("/login")  # noqa: SLF001
    for _ in range(3):
        _key(app, "enter")
    _wait(lambda: app._picker is not None and "which kind of API" in _picker_text(app))  # noqa: SLF001
    assert "model discovery failed" in _picker_text(app)
    _key(app, "down")
    _key(app, "enter")  # Anthropic-style
    assert "Type the model id your endpoint uses" in _picker_text(app)
    _type(app, "42")
    _key(app, "enter")
    saved = load_settings(app.home).auth
    assert (saved.protocol, saved.model) == ("anthropic", "42"), "a bare number is an id here"


def test_oauth_sign_in_through_the_list_with_the_mock(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    app._on_submit("/login")  # noqa: SLF001
    _key(app, "down")
    _key(app, "enter")
    assert [i.key for i in app._picker.matches()] == ["anthropic", "openai"]  # noqa: SLF001
    _key(app, "enter")
    _key(app, "enter")
    saved = load_settings(app.home).auth
    assert (saved.mode, saved.oauth_provider, saved.model) == ("oauth", "anthropic",
                                                               "claude-mock-opus")
    assert load_credentials(app.home)["oauth_access_token"] == "mock-anthropic-token"
    assert "Signed in to anthropic · model claude-mock-opus" in _snap(app)


class _StatusError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status


def test_a_refused_key_points_at_login(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_error(_StatusError(401, "没有有效的订阅计划"))  # noqa: SLF001
    assert "没有有效的订阅计划 · /login to change the key" in _snap(app)
    try:
        try:
            raise _StatusError(403, "forbidden")
        except _StatusError as inner:
            raise RuntimeError("the agent stopped") from inner
    except RuntimeError as outer:
        app._on_error(outer)  # noqa: SLF001
    assert "the agent stopped · /login to change the key" in _snap(app)
    app._on_error(_StatusError(500, "upstream broke"))  # noqa: SLF001
    assert "upstream broke · /login" not in _snap(app)


def test_the_setup_controller_can_leave_probe_and_saving_to_the_caller(tmp_path):
    calls = []
    login = InitController(home=tmp_path, defer_probe=True, persist=False,
                           probe=lambda url, key: calls.append(key) or ProbeResult(
                               "openai", ["m"], base_url=url))
    login.confirm()
    login.submit_line("https://gateway.example/v1")
    login.submit_line("sk-1")
    assert login.step == InitStep.PROBING and calls == []
    login.run_probe()
    login.confirm()
    assert login.done and login.auth.model == "m" and login.credentials == {"api_key": "sk-1"}
    assert not (tmp_path / "settings.json").exists() and not (tmp_path / "credentials.json").exists()


def _picker(**kw) -> tuple[Picker, list]:
    picked: list = []
    picker = Picker(title="T", items=[PickerItem("a", "alpha"), PickerItem("b", "beta")],
                    on_pick=picked.append, render=lambda: None, **kw)
    return picker, picked


def test_picker_asks_for_a_masked_line_that_takes_a_paste():
    picker, _ = _picker()
    got: list[str] = []
    picker.ask("api key", "", got.append, mask=True, keys="enter continues")
    picker.handle_paste("sk-\r\nabc")
    picker.handle_key("x", "x")
    rows = "\n".join(picker.render_lines(80))
    assert "api key: •••••••▏  enter continues" in rows and "sk-" not in rows
    picker.handle_key("ctrl+u", "")
    picker.handle_paste("k2")
    picker.handle_key("enter", "")
    assert got == ["k2"] and not picker.asking


def test_the_asked_line_does_not_change_the_rows_under_it():
    """What is typed is not the list: no "(1/26)" count for a long URL, no "Nothing to show"
    for an empty line."""
    for text in ("", "https://gateway.example/claude/aws"):
        picker, _ = _picker()
        picker.ask("base url", text, lambda _t: None)
        rows = picker.render_lines(80)
        assert len(rows) == 4, rows  # title, the asked line, alpha, beta
        assert not any("Nothing to show" in r or "(1/" in r for r in rows)


def test_picker_paste_searches_and_enter_on_no_match_hands_over_the_text():
    typed: list[str] = []
    picker, picked = _picker(free_text=typed.append)
    picker.handle_paste("bet")
    assert [i.key for i in picker.matches()] == ["b"]
    picker.handle_key("ctrl+u", "")
    picker.handle_paste("gamma")
    picker.handle_key("enter", "")
    assert typed == ["gamma"] and picked == []
    plain, plain_picked = _picker()
    plain.handle_paste("gamma")
    plain.handle_key("enter", "")
    assert plain_picked == [], "without free_text, enter on no match does nothing"


def test_the_endpoint_row_in_settings_opens_login(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/settings")  # noqa: SLF001
    app._picker.focus_on("endpoint")  # noqa: SLF001
    _key(app, "enter")
    assert app._picker.title == "Sign in" and app._login is not None  # noqa: SLF001


def _cells(app, width: int = 100, height: int = 24):
    from tests.test_theme_matching import _paint

    return _paint(app, width, height)


def _rgb(codes: tuple[str, ...], kind: str) -> str | None:
    """The last 24-bit colour of ``kind`` (38 foreground, 48 background) in a cell's codes."""
    import re

    found = None
    for code in codes:
        for m in re.finditer(rf"(?:^|[;\[]){kind};2;(\d+);(\d+);(\d+)", code):
            found = "#%02x%02x%02x" % tuple(int(x) for x in m.groups())
    return found


def test_the_login_list_reads_on_dark_and_light_and_follows_a_switch(tmp_path, monkeypatch):
    from circle.ink import theme

    monkeypatch.setattr(theme, "query_terminal_palette", lambda timeout=0.25: None)
    saved = theme._detected  # noqa: SLF001
    try:
        for colorfgbg, dark in (("15;0", True), ("0;15", False)):
            monkeypatch.setenv("COLORFGBG", colorfgbg)
            theme._detected = None  # noqa: SLF001
            theme.reset_palette()
            root = tmp_path / colorfgbg.replace(";", "_")
            root.mkdir()
            app = _app(root, monkeypatch)
            assert theme.palette().is_dark is dark
            app._on_submit("/login")  # noqa: SLF001
            _key(app, "enter")
            _key(app, "enter")
            app._handle_input(PasteEvent(text="sk-x"))  # noqa: SLF001
            rows = [row for row in _cells(app)
                    if any(w in "".join(c for c, _ in row)
                           for w in ("Sign in", "api key", "API URL + KEY", "OAuth sign-in"))]
            assert len(rows) == 4
            for row in rows:
                for ch, codes in row:
                    if ch.strip():
                        fg, bg = _rgb(codes, "38"), _rgb(codes, "48")
                        assert fg and bg, (ch, codes)
                        assert theme.contrast_ratio(fg, bg) >= 3.0, (ch, fg, bg)

        # auto follows the terminal while the list is open: its rows are drawn again
        theme._detected = ("#1a1b26", "#c0caf5", {})  # noqa: SLF001 — dark text on light
        app.settings.theme = "auto"
        light_bg = theme.apply_theme("auto").panel_bg
        theme._detected = ("#c0caf5", "#1a1b26", {})  # noqa: SLF001 — the terminal went dark
        app._on_terminal_theme_change()  # noqa: SLF001
        dark_bg = theme.palette().panel_bg
        assert dark_bg != light_bg
        drawn = "".join(child.value for child in app._ask_panel.node.children  # noqa: SLF001
                        if hasattr(child, "value"))
        assert dark_bg in drawn and light_bg not in drawn
    finally:
        theme._detected = saved  # noqa: SLF001
        theme.reset_palette()


def test_settings_file_keeps_unknown_keys_through_login(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    path = app.home / "settings.json"
    raw = json.loads(path.read_text())
    raw["my_own_key"] = 7
    path.write_text(json.dumps(raw))
    app._on_submit("/login")  # noqa: SLF001
    for _ in range(3):
        _key(app, "enter")
    _wait(lambda: _models_listed(app))
    _key(app, "enter")
    assert json.loads(path.read_text())["my_own_key"] == 7
