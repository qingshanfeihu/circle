"""Subagents on screen: the block folded under the task row, the card's reasoning
bodies, the detail page, the strip keys, and a whole session turn with a subagent."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from circle.ink import theme
from circle.ink.components.transcript import Transcript
from circle.ink.parse_keypress import KeyPress
from circle.ink.string_width import string_width
from circle.tui.agent_detail import render_detail_band, render_detail_lines
from circle.tui.agent_strip import snapshot_cards
from circle.tui.reducer import (
    CARD_THINKING_PUSH_STEP,
    CARD_THINKING_TAIL_CHARS,
    MessageReducer,
)
from circle.tui.transcript_view import ViewOptions, render_turn

ANSI = re.compile(r"\x1b\[[0-9;]*m")


@pytest.fixture(autouse=True)
def _palette():
    theme.reset_palette()
    theme.set_palette(theme.build_palette("#d6dee6", "#10151a"))
    yield
    theme.reset_palette()


def plain(text: str) -> str:
    return ANSI.sub("", text)


class Feed:
    """Dispatch bus-shaped events into a reducer."""

    def __init__(self) -> None:
        self.reducer = MessageReducer()
        self.seq = 0

    def emit(self, kind, *, name="", run="", task="", payload=None, usage=None):
        self.seq += 1
        tags = {}
        if name:
            tags["name"] = name
        if run:
            tags["lc_tool_run_id"] = run
        if task:
            tags.update(parent_subagent="general-purpose", parent_tool_use_id=task)
        event = {"kind": kind, "run_id": "r", "seq": self.seq, "ts": "", "tags": tags,
                 "payload": payload or {}}
        if usage:
            event["usage"] = usage
        self.reducer.dispatch(event)

    def task(self, run, description, subagent="general-purpose"):
        self.emit("tool_call", name="task", run=run,
                  payload={"input": {"description": description, "subagent_type": subagent}})

    def inner(self, task, run, path, *, output="ok", status="success", recoverable=False):
        self.emit("tool_call", name="read_file", run=run, task=task,
                  payload={"input": {"file_path": path}})
        if output is not None:
            payload = {"output": output, "status": status}
            if recoverable:
                payload["recoverable"] = True
            self.emit("tool_result", name="read_file", run=run, task=task, payload=payload)

    def finish(self, run, output="sub done"):
        self.emit("tool_result", name="task", run=run,
                  payload={"output": output, "status": "success"})

    def snap(self):
        return self.reducer.snapshot()

    def card(self, index=0):
        return snapshot_cards(self.snap())[index][1]


def _entry(feed: Feed, **opts) -> list[str]:
    card = feed.card()
    options = ViewOptions(now=float(card["start_ts"]) + 12, **opts)
    return plain(render_turn(feed.snap(), options)[0]).splitlines()


# ── folded block ───────────────────────────────────────────────────────────


def test_running_subagent_shows_meta_and_its_last_three_calls():
    feed = Feed()
    feed.task("T", "find the config")
    for i in range(5):
        feed.inner("T", f"s{i}", f"/f{i}.py")
    feed.emit("llm_end", task="T", payload={"name": "subagent_usage"},
              usage={"input_tokens": 1000, "output_tokens": 234})
    lines = _entry(feed)
    assert lines[0].endswith("Agent(find the config)")
    assert lines[1] == "   ⎿ general-purpose · 5 calls · 12s · 1.2k tokens"
    assert lines[2] == "     … +2 更早"
    assert [ln.strip().split(" ", 1)[1] for ln in lines[3:6]] == [
        "Read(/f2.py)", "Read(/f3.py)", "Read(/f4.py)"]
    assert len(lines) == 6, "no result line while the subagent runs"


def test_finished_subagent_folds_to_meta_and_result_and_ctrl_o_lists_every_call():
    feed = Feed()
    feed.task("T", "find the config")
    for i in range(4):
        feed.inner("T", f"s{i}", f"/f{i}.py")
    feed.finish("T", "found it in /etc/app.toml\nsecond line")
    collapsed = _entry(feed)
    assert collapsed[1].startswith("   ⎿ general-purpose · 4 calls · ")
    assert collapsed[2] == "   ⎿ found it in /etc/app.toml (ctrl+o 展开 +1 行)"
    assert len(collapsed) == 3
    expanded = _entry(feed, tools_expanded=True)
    assert sum("Read(/f" in ln for ln in expanded) == 4 and "更早" not in "\n".join(expanded)


def test_parallel_subagents_keep_their_own_calls():
    feed = Feed()
    feed.task("T1", "left")
    feed.task("T2", "right")
    feed.inner("T1", "a", "/left.py")
    feed.inner("T2", "b", "/right.py")
    feed.inner("T1", "c", "/left2.py", output=None)
    first, second = (card for _uuid, card in snapshot_cards(feed.snap()))
    assert [i["input"]["file_path"] for i in first["transcript"]] == ["/left.py", "/left2.py"]
    assert [i["input"]["file_path"] for i in second["transcript"]] == ["/right.py"]
    assert first["n_calls"] == 2 and second["n_calls"] == 1
    assert first["transcript"][-1]["status"] == "running"


def test_a_call_left_running_when_the_subagent_ends_is_settled_as_failed():
    feed = Feed()
    feed.task("T", "x")
    feed.inner("T", "a", "/a.py", output=None)
    feed.finish("T")
    assert feed.card()["transcript"][0]["status"] == "error"


# ── reasoning bodies on the card ───────────────────────────────────────────


def test_each_round_keeps_one_bounded_reasoning_item():
    feed = Feed()
    feed.task("T", "x")
    feed.emit("llm_start", task="T", payload={"name": "M"})
    feed.emit("llm_token", task="T", payload={"reasoning": "a" * (CARD_THINKING_PUSH_STEP - 1)})
    assert not [i for i in feed.card().get("transcript") or () if i["kind"] == "thinking_body"], \
        "under one step nothing is pushed"
    for _ in range(3):
        feed.emit("llm_token", task="T", payload={"reasoning": "b" * CARD_THINKING_PUSH_STEP,
                                                  "reasoning_title": "Scanning"})
    items = [i for i in feed.card()["transcript"] if i["kind"] == "thinking_body"]
    assert len(items) == 1 and items[0]["done"] is False
    assert len(items[0]["text"]) == CARD_THINKING_TAIL_CHARS and items[0]["truncated"] is True
    feed.emit("llm_end", task="T", payload={"name": "subagent_done"})
    items = [i for i in feed.card()["transcript"] if i["kind"] == "thinking_body"]
    assert len(items) == 1 and items[0]["done"] is True and "duration_s" in items[0]
    assert items[0]["chars"] == CARD_THINKING_PUSH_STEP * 4 - 1
    assert items[0]["title"] == "Scanning"
    feed.emit("llm_start", task="T", payload={"name": "M"})
    feed.emit("llm_token", task="T", payload={"reasoning": "short"})
    feed.emit("llm_end", task="T", payload={"name": "subagent_done"})
    keys = [i["key"] for i in feed.card()["transcript"] if i["kind"] == "thinking_body"]
    assert keys == ["think:1", "think:2"]


def test_main_agent_reasoning_never_lands_on_a_card():
    feed = Feed()
    feed.task("T", "x")
    feed.emit("llm_start", payload={"name": "M"})
    feed.emit("llm_token", payload={"reasoning": "main " * 1000})
    assert not feed.card().get("transcript")


# ── detail page ────────────────────────────────────────────────────────────


def _detail_feed() -> Feed:
    feed = Feed()
    feed.task("T", "find the config")
    feed.emit("llm_start", task="T", payload={"name": "M"})
    feed.emit("llm_token", task="T", payload={"reasoning": "z" * (CARD_THINKING_TAIL_CHARS + 10)})
    feed.emit("llm_end", task="T", payload={"name": "subagent_done"})
    feed.inner("T", "a", "/a.py", output="line one\nline two")
    feed.inner("T", "b", "/b.py", output="Tool call 'read_file' was not run: invalid arguments",
               status="error", recoverable=True)
    feed.inner("T", "c", "/c.py", output="Permission denied", status="error")
    return feed


def test_detail_lists_every_call_and_reasoning_in_order():
    feed = _detail_feed()
    card = feed.card()
    lines = [plain(ln) for ln in render_detail_lines(card, now=float(card["start_ts"]) + 5)]
    assert lines[0] == "任务: find the config"
    think = next(i for i, ln in enumerate(lines) if "∴ Thought" in ln)
    call_a = next(i for i, ln in enumerate(lines) if "Read(/a.py)" in ln)
    assert think < call_a
    assert "(ctrl+t 展开)" in lines[think] and "下面是末" not in lines[think]
    assert lines[call_a].endswith("Read(/a.py) line one")
    assert "工具 3 次 · 思考 1 段 · 距上次事件" in "\n".join(lines)
    expanded = [plain(ln) for ln in render_detail_lines(card, expanded=True)]
    assert any(f"下面是末 {CARD_THINKING_TAIL_CHARS} 字" in ln for ln in expanded)
    assert any(ln.strip().startswith("…z") for ln in expanded)


def test_detail_marks_the_recoverable_failure_muted_and_the_end_result():
    feed = _detail_feed()
    feed.finish("T", "found it")
    card = feed.card()
    raw = render_detail_lines(card)
    row_b = next(ln for ln in raw if "Read(/b.py)" in ln)
    assert theme.palette().muted_strike in row_b and theme.status_light("error") not in row_b
    row_c = next(ln for ln in raw if "Read(/c.py)" in ln)
    assert theme.status_light("error") in row_c and "Permission denied" in row_c
    text = "\n".join(plain(ln) for ln in raw)
    assert "◆ 结果：完成 · 3 calls" in text and "⎿ found it" in text
    assert "距上次事件" not in text


def test_detail_band_keeps_the_keys_on_a_narrow_screen():
    card = _detail_feed().card()
    for width in (40, 60, 120):
        band = [plain(ln) for ln in render_detail_band(card, index=2, total=3, width=width)]
        assert len(band) == 3 and all(string_width(ln) == width for ln in band)
        assert "esc 返回 · ←→ 切换" in band[1]
    wide = plain(render_detail_band(card, index=2, total=3, width=120)[1])
    assert "general-purpose·" in wide and "(2 of 3)" in wide and "运行中" in wide


# ── transcript node order ──────────────────────────────────────────────────


def test_replace_range_keeps_screen_nodes_in_message_order():
    view = Transcript()
    view.append_messages(["a", "b", "c", "d"])
    view.replace_range(1, 1, ["x", "y", "z"])
    view.replace_range(6, 0, ["tail1", "tail2"])
    view.replace_range(0, 2, [])
    values = [getattr(node, "value", None) for node in view.node.children]
    assert view.snapshot() == ["y", "z", "c", "d", "tail1", "tail2"] == values


# ── the session: strip keys and the detail page ────────────────────────────


def _fake_session(tmp_path: Path, monkeypatch):
    from circle.settings import CircleSettings, ModelAuth, save_settings
    from circle.tui.session_app import CircleSessionApp

    home, ws = tmp_path / "home", tmp_path / "ws"
    home.mkdir()
    ws.mkdir()
    settings = CircleSettings(initialized=True, trusted_folders=[str(ws)], auth=ModelAuth(
        mode="api_key", protocol="openai", base_url="http://127.0.0.1:9", model="test-model"))
    save_settings(settings, home=home)
    monkeypatch.setenv("CIRCLE_HOME", str(home))

    class _FakeAgent:
        def stream(self, *a, **k):
            return iter(())

    monkeypatch.setattr("circle.tui.session_app.create_harness", lambda *a, **k: _FakeAgent())
    monkeypatch.setattr("circle.tui.session_app.build_chat_model", lambda *a, **k: object())
    return CircleSessionApp(settings, ws, home=home)


def _strip_text(app) -> str:
    return plain(getattr(app._agent_strip_text, "value", "") or "")  # noqa: SLF001


def _band_text(app) -> str:
    return plain(getattr(app._agent_detail_band_text, "value", "") or "")  # noqa: SLF001


def test_strip_selection_and_detail_page_keys(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    feed = Feed()
    feed.task("T1", "left side")
    feed.task("T2", "right side")
    feed.inner("T1", "a", "/left.py")
    app._open_turn_region()  # noqa: SLF001
    app._on_snapshot(feed.snap())  # noqa: SLF001
    app._sync_agent_strip()  # noqa: SLF001
    assert "在途 AGENT ─ 2" in _strip_text(app) and "← 选中" not in _strip_text(app)

    app._handle_key(KeyPress(key="down"))  # noqa: SLF001
    assert "← 选中" in next(ln for ln in _strip_text(app).splitlines() if "left side" in ln)
    app._handle_key(KeyPress(key="down"))  # noqa: SLF001
    assert "← 选中" in next(ln for ln in _strip_text(app).splitlines() if "right side" in ln)

    app._handle_key(KeyPress(key="return"))  # noqa: SLF001
    assert app._detail_active  # noqa: SLF001
    assert app._transcript.node.style.display == "none"  # noqa: SLF001
    assert app._agent_detail.node.style.display == "flex"  # noqa: SLF001
    assert "(2 of 2)" in _band_text(app)
    assert "任务: right side" in plain("\n".join(app._agent_detail.snapshot()))  # noqa: SLF001

    app._handle_key(KeyPress(key="left"))  # noqa: SLF001
    assert "(1 of 2)" in _band_text(app)
    assert "Read(/left.py)" in plain("\n".join(app._agent_detail.snapshot()))  # noqa: SLF001

    app._is_loading = True  # noqa: SLF001 — esc on these views never cancels the turn
    cancelled = []
    app._bridge.cancel = lambda: cancelled.append(1)  # noqa: SLF001
    app._handle_key(KeyPress(key="escape"))  # noqa: SLF001
    assert not app._detail_active and app._strip_selecting  # noqa: SLF001
    assert app._transcript.node.style.display == "flex"  # noqa: SLF001
    assert app._agent_detail.node.style.display == "none"  # noqa: SLF001
    app._handle_key(KeyPress(key="escape"))  # noqa: SLF001
    assert not app._strip_selecting and cancelled == []  # noqa: SLF001
    app._is_loading = False  # noqa: SLF001

    app._handle_key(KeyPress(key="down"))  # noqa: SLF001
    app._handle_key(KeyPress(key="char", char="h"))  # noqa: SLF001
    assert not app._strip_selecting and app._prompt.value == "h"  # noqa: SLF001
    app._handle_key(KeyPress(key="down"))  # noqa: SLF001
    assert not app._strip_selecting, "with text in the prompt ↓ stays with the prompt"  # noqa: SLF001


def test_a_click_on_a_strip_row_opens_that_subagent(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    feed = Feed()
    feed.task("T1", "left side")
    feed.task("T2", "right side")
    app._open_turn_region()  # noqa: SLF001
    app._on_snapshot(feed.snap())  # noqa: SLF001
    app._sync_agent_strip()  # noqa: SLF001
    app._agent_strip.rect.y = 30  # noqa: SLF001
    assert app._strip_row_at(31) is None and app._strip_row_at(34) is None  # noqa: SLF001
    assert app._strip_row_at(33) == "agent:T2"  # noqa: SLF001
    from circle.ink.parse_keypress import MouseEvent

    app._mouse_to_screen_coords = lambda x, y: (x, y)  # noqa: SLF001 — no terminal in tests
    app._handle_mouse(MouseEvent(type="press", button=0, x=5, y=33))  # noqa: SLF001
    assert app._detail_active and app._detail_uuid == "agent:T2"  # noqa: SLF001


# ── a whole turn through the real harness ──────────────────────────────────


def test_session_turn_with_a_subagent_shows_strip_then_folded_block(tmp_path, monkeypatch):
    from tests.test_progress_handler import _call, _session, _wait_idle

    app = _session(tmp_path, monkeypatch, [
        _call("task", {"description": "look around", "subagent_type": "general-purpose"}, "c3"),
        _call("ls", {"path": "/"}, "s1"),
        AIMessage(content="sub done"),
        AIMessage(content="all done"),
    ])
    strips: list[str] = []
    original = app._on_snapshot  # noqa: SLF001

    def record(snap):
        original(snap)
        with app._app.lock:  # noqa: SLF001
            app._sync_agent_strip()  # noqa: SLF001
            strips.append(_strip_text(app))

    app._bridge._on_snapshot = record  # noqa: SLF001
    app._on_submit("go")  # noqa: SLF001
    _wait_idle(app)
    assert any("在途 AGENT ─ 1" in s and "general-purpose·" in s and "look around" in s
               for s in strips)
    assert strips[-1] == "", "nothing is left in flight"
    text = plain("\n".join(app._transcript.snapshot()))  # noqa: SLF001
    assert "Agent(look around)" in text
    assert re.search(r"⎿ general-purpose · 1 calls · \d+s · \d+ tokens", text)
    assert "⎿ sub done" in text and "all done" in text
    assert "Ls(/)" not in text, "a finished subagent's calls stay folded"
