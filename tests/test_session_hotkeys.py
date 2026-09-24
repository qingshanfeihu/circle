"""InfoTest-aligned session hotkeys and prompt history."""

from __future__ import annotations

from pathlib import Path

from circle.ink.parse_keypress import KeyPress
from circle.tui.content_blocks import render_thinking_line
from circle.tui.input_history import InputHistory
from circle.tui.slash_commands import hotkeys_text


def test_hotkeys_text_lists_infotest_bindings():
    text = hotkeys_text()
    for needle in (
        "ctrl+t",
        "ctrl+o",
        "ctrl+r",
        "ctrl+d",
        "ctrl+l",
        "pageup",
        "up/down",
        "tab",
    ):
        assert needle in text


def test_input_history_up_down_and_search(tmp_path: Path):
    hist = InputHistory(path=tmp_path / "history")
    hist.add("alpha one")
    hist.add("beta two")
    hist.add("alpha three")

    assert hist.up("") == "alpha three"
    assert hist.up("") == "beta two"
    assert hist.down("") == "alpha three"
    assert hist.down("draft") == ""  # exits to draft captured on first up

    hist.reset_navigation()
    match = hist.start_search("alpha")
    assert match == "alpha three"
    assert hist.search_next() == "alpha one"


def test_render_thinking_expand_shows_body():
    collapsed = render_thinking_line(body="line-a\nline-b", done=True, expanded=False)
    assert "ctrl+t to expand" in collapsed
    assert "line-a" not in collapsed

    expanded = render_thinking_line(body="line-a\nline-b", done=True, expanded=True)
    assert "line-a" in expanded
    assert "line-b" in expanded
    assert "ctrl+t to expand" not in expanded


def test_ctrl_t_toggles_thinking_row(tmp_path: Path, monkeypatch):
    """Drive CircleSessionApp key path without a live terminal."""
    from circle.settings import CircleSettings, ModelAuth, save_settings
    from circle.tui.session_app import CircleSessionApp

    home = tmp_path / "home"
    home.mkdir()
    ws = tmp_path / "ws"
    ws.mkdir()
    settings = CircleSettings(
        initialized=True,
        auth=ModelAuth(
            mode="api_key",
            protocol="openai",
            base_url="http://127.0.0.1:9",
            model="test-model",
        ),
        trusted_folders=[str(ws)],
    )
    save_settings(settings, home=home)
    monkeypatch.setenv("CIRCLE_TEST_KEY", "x")
    monkeypatch.setenv("CIRCLE_HOME", str(home))

    # Avoid building a real LLM client during harness create.
    class _FakeAgent:
        def stream(self, *a, **k):
            return iter(())

        def get_state(self, *a, **k):
            class S:
                interrupts = ()
                values = {"messages": []}

            return S()

        def invoke(self, *a, **k):
            return {"messages": []}

    monkeypatch.setattr(
        "circle.tui.session_app.create_harness",
        lambda *a, **k: _FakeAgent(),
    )
    monkeypatch.setattr(
        "circle.tui.session_app.build_chat_model",
        lambda *a, **k: object(),
    )

    app = CircleSessionApp(settings, ws, home=home)
    # 思考行由快照渲染：推一条 thinking_block 事件，经 reducer 出快照再画
    from circle.events import EventBus
    from circle.tui.sink import TuiSink

    posted = []
    bus = EventBus(run_id="r")
    bus.subscribe(TuiSink(post=posted.append))
    app._open_turn_region()
    bus.emit("run_start")
    bus.emit("info", payload={"name": "thinking_block", "thinking": "secret thought\nsecond line",
                              "reasoning_duration_s": 1.5})
    app._on_snapshot(posted[-1])
    row = "\n".join(app._transcript.snapshot())
    assert "ctrl+t to expand" in row and "∴ Thought" in row
    assert "secret thought" not in row

    app._handle_key(KeyPress(key="ctrl+t", ctrl=True, char="t"))
    row = "\n".join(app._transcript.snapshot())
    assert "secret thought" in row
    assert "second line" in row

    app._handle_key(KeyPress(key="ctrl+o", ctrl=True, char="o"))
    assert app._tool_outputs_expanded is True
