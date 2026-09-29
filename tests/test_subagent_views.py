"""Subagents on screen: the block folded under the task row, the card's reasoning
bodies, the detail page, the strip keys, and a whole session turn with a subagent."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from circle.ink import theme
from circle.ink.components.markdown_renderer import MarkdownRenderer
from circle.ink.components.transcript import Transcript
from circle.ink.parse_keypress import KeyPress
from circle.ink.string_width import string_width
from circle.tui.agent_detail import (
    BUTTONS,
    render_detail_band,
    render_detail_lines,
    render_detail_rows,
)
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
    assert collapsed[2] == "   ⎿ found it in /etc/app.toml"
    assert collapsed[3] == "     second line"
    assert len(collapsed) == 4
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
    assert items[0]["tail_partial_line"] is True
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


def test_expanded_subagent_thinking_keeps_faint_color_after_bold():
    body = "First I check **config**.\nThen I edit the file."
    card = {"status": "running", "start_ts": 1.0, "transcript": [
        {"kind": "thinking_body", "text": body, "chars": len(body), "done": True},
    ]}
    rendered = "\n".join(render_detail_lines(card, expanded=True))
    faint_params = theme.palette().faint[2:-1]
    for word in ("First", "config", ".\x1b", "Then"):
        before = rendered[:rendered.index(word)]
        active = ANSI.findall(before)[-1]
        assert active.endswith(f"{faint_params}m"), (word, active)


def test_truncated_subagent_thinking_starting_inside_fence_preserves_code_and_prose():
    tail = "def __init__(self):\n    x = a * b * c\n```\nThen I edit **config**."
    card = {"status": "running", "start_ts": 1.0, "transcript": [
        {"kind": "thinking_body", "text": tail, "chars": len(tail) + 6000,
         "truncated": True, "tail_fence": {"marker": "`", "count": 3,
                                           "lang": "", "indent": 0}, "done": True},
    ]}
    rendered = "\n".join(render_detail_lines(card, expanded=True))
    assert "def __init__(self):" in plain(rendered)
    assert "x = a * b * c" in plain(rendered)
    assert "Then I edit config." in plain(rendered)
    assert "Then I edit" not in next((line for line in rendered.splitlines()
                                      if theme.palette().blue in line), "")


def _truncated_thinking(source: str, *, done: bool) -> tuple[dict, str]:
    feed = Feed()
    feed.task("T", "inspect reasoning")
    feed.emit("llm_start", task="T", payload={"name": "M"})
    feed.emit("llm_token", task="T", payload={"reasoning": source})
    if done:
        feed.emit("llm_end", task="T", payload={"name": "subagent_done"})
    card = feed.card()
    item = next(entry for entry in card["transcript"] if entry["kind"] == "thinking_body")
    return item, plain("\n".join(render_detail_lines(card, expanded=True)))


@pytest.mark.parametrize("opener,closer,marker,count,indent", [
    ("```c++", "```", "`", 3, 0),
    ("  ~~~~c++", "  ~~~~", "~", 4, 2),
])
def test_truncated_tail_carries_open_fence_from_discarded_lines(
        opener, closer, marker, count, indent):
    source = (f"before\n{opener}\n" + "  int old_value = 1;\n" * 320
              + f"  def __init__(self): pass\n{closer}\nAfter **config**.")
    item, rendered = _truncated_thinking(source, done=True)
    assert item["truncated"] is True
    assert item["tail_fence"] == {"marker": marker, "count": count,
                                  "lang": "c++", "indent": indent}
    assert item["text"].startswith("  int old_value = 1;")
    assert "def __init__(self): pass" in rendered
    assert "After config." in rendered
    assert "┌─ c++" in rendered and "└─" in rendered


def test_truncated_tail_starting_in_prose_keeps_later_bare_fence_direction():
    source = "discarded prose\n" * 300 + "prose\n```\ncode **x**\n```\nmore"
    item, rendered = _truncated_thinking(source, done=True)
    assert item["truncated"] is True and item["tail_fence"] is None
    assert "code **x**" in rendered
    assert "more" in rendered
    assert rendered.index("└─") < rendered.index("more")


def test_streaming_truncated_tail_keeps_unclosed_fence_as_code():
    source = "discarded prose\n" * 300 + "prose\n```\ncode **x**"
    item, rendered = _truncated_thinking(source, done=False)
    assert item["done"] is False and item["truncated"] is True
    assert item["tail_fence"] is None
    assert "code **x**" in rendered


def test_tail_cut_exactly_after_fence_line_is_not_a_partial_line():
    source = "before\n```python\n" + "x" * CARD_THINKING_TAIL_CHARS
    item, rendered = _truncated_thinking(source, done=False)
    assert item["tail_fence"] == {"marker": "`", "count": 3,
                                  "lang": "python", "indent": 0}
    assert item["tail_partial_line"] is False
    assert item["text"] == "x" * CARD_THINKING_TAIL_CHARS
    assert "```python" in rendered and "x" * 100 in rendered


def test_fence_state_advances_across_multiple_tail_cuts():
    feed = Feed()
    feed.task("T", "inspect reasoning")
    feed.emit("llm_start", task="T", payload={"name": "M"})
    feed.emit("llm_token", task="T", payload={"reasoning": "before\n~~~python\n" + "code\n" * 700})
    feed.emit("llm_token", task="T", payload={"reasoning": "code\n" * 400
                                                  + "~~~\nafter\n" + "prose\n" * 300})
    first = next(i for i in feed.card()["transcript"] if i["kind"] == "thinking_body")
    assert first["tail_fence"] == {"marker": "~", "count": 3,
                                    "lang": "python", "indent": 0}
    assert first["text"].startswith("code\n")
    feed.emit("llm_token", task="T", payload={"reasoning": "later\n" * 700})
    second = next(i for i in feed.card()["transcript"] if i["kind"] == "thinking_body")
    assert second["tail_fence"] is None
    assert second["text"].startswith("later\n")


def test_subagent_detail_redraw_reuses_reasoning_render(monkeypatch):
    calls: list[str] = []
    original = MarkdownRenderer.render_streaming

    def counted(self, body):
        calls.append(body)
        return original(self, body)

    monkeypatch.setattr(MarkdownRenderer, "render_streaming", counted)
    body = "cache subagent reasoning **config** 42"
    card = {"status": "running", "start_ts": 1.0, "transcript": [
        {"kind": "thinking_body", "text": body, "chars": len(body), "done": True},
    ]}
    for _ in range(3):
        render_detail_lines(card, expanded=True, width=70)
    assert calls == [body]
    render_detail_lines(card, expanded=True, width=71)
    assert calls == [body, body]


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


def test_detail_band_keeps_the_text_buttons_on_a_narrow_screen():
    card = _detail_feed().card()
    for width in (40, 60, 120):
        lines, spans = render_detail_band(card, index=2, total=3, width=width)
        band = [plain(ln) for ln in lines]
        assert len(band) == 3 and all(string_width(ln) == width for ln in band)
        assert [action for _s, _e, action in spans] == ["back", "prev", "next"]
        for start, end, action in spans:
            label = dict(BUTTONS)[action]
            assert band[1][_col_to_index(band[1], start):_col_to_index(band[1], end)] == f" {label} "
    wide = plain(render_detail_band(card, index=2, total=3, width=120)[0][1])
    assert "general-purpose·" in wide and "(2 of 3)" in wide and "运行中" in wide
    assert "⌫" not in wide and "←" not in wide, "the icon buttons are retired"


def _col_to_index(line: str, col: int) -> int:
    width = 0
    for index, ch in enumerate(line):
        if width >= col:
            return index
        width += string_width(ch)
    return len(line)


def test_detail_button_hover_is_sel_bg_and_brighter():
    card = _detail_feed().card()
    pal = theme.palette()
    plain_line = render_detail_band(card, index=1, total=1, width=100)[0][1]
    hovered = render_detail_band(card, index=1, total=1, width=100, hover="prev")[0][1]
    assert f"{theme.sgr_join(pal.panel_bg, pal.text)} 上一个 " in plain_line
    assert f"{theme.sgr_join(pal.sel_bg, pal.em)} 上一个 " in hovered
    assert f"{theme.sgr_join(pal.panel_bg, pal.text)} 主视图 " in hovered


def test_detail_rows_carry_type_and_thinking_tints():
    card = _detail_feed().card()
    pal = theme.palette()
    rows = render_detail_rows(card, now=float(card["start_ts"]) + 5)
    assert any("Read(/a.py)" in plain(line) and bg == pal.read_bg_hex for line, bg in rows)
    assert any("∴ Thought" in plain(line) and bg == pal.think_bg_hex for line, bg in rows)
    assert all(bg is None for line, bg in rows if "任务:" in plain(line) or not line)


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
    return plain(getattr(app._agent_strip_text, "value", "") or "")


def _band_text(app) -> str:
    return plain(getattr(app._agent_detail_band_text, "value", "") or "")


def test_strip_selection_and_detail_page_keys(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    feed = Feed()
    feed.task("T1", "left side")
    feed.task("T2", "right side")
    feed.inner("T1", "a", "/left.py")
    app._open_turn_region()
    app._on_snapshot(feed.snap())
    app._sync_agent_strip()
    assert "在途 AGENT ─ 2" in _strip_text(app) and "← 选中" not in _strip_text(app)

    app._handle_key(KeyPress(key="down"))
    assert "← 选中" in next(ln for ln in _strip_text(app).splitlines() if "left side" in ln)
    app._handle_key(KeyPress(key="down"))
    assert "← 选中" in next(ln for ln in _strip_text(app).splitlines() if "right side" in ln)

    app._handle_key(KeyPress(key="return"))
    assert app._detail_active
    assert app._transcript.node.style.display == "none"
    assert app._agent_detail.node.style.display == "flex"
    assert "(2 of 2)" in _band_text(app)
    assert "任务: right side" in plain("\n".join(app._agent_detail.snapshot()))

    app._handle_key(KeyPress(key="left"))
    assert "(1 of 2)" in _band_text(app)
    assert "Read(/left.py)" in plain("\n".join(app._agent_detail.snapshot()))

    app._is_loading = True
    cancelled = []
    app._bridge.cancel = lambda: cancelled.append(1)
    app._handle_key(KeyPress(key="escape"))
    assert not app._detail_active and app._strip_selecting
    assert app._transcript.node.style.display == "flex"
    assert app._agent_detail.node.style.display == "none"
    app._handle_key(KeyPress(key="escape"))
    assert not app._strip_selecting and cancelled == []
    app._is_loading = False

    app._handle_key(KeyPress(key="down"))
    app._handle_key(KeyPress(key="char", char="h"))
    assert not app._strip_selecting and app._prompt.value == "h"
    app._handle_key(KeyPress(key="down"))
    assert not app._strip_selecting, "with text in the prompt ↓ stays with the prompt"


def test_a_click_on_a_strip_row_opens_that_subagent(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    feed = Feed()
    feed.task("T1", "left side")
    feed.task("T2", "right side")
    app._open_turn_region()
    app._on_snapshot(feed.snap())
    app._sync_agent_strip()
    app._agent_strip.rect.y = 30
    assert app._strip_row_at(31) is None and app._strip_row_at(34) is None
    assert app._strip_row_at(33) == "agent:T2"
    from circle.ink.parse_keypress import MouseEvent

    app._mouse_to_screen_coords = lambda x, y: (x, y)
    app._handle_mouse(MouseEvent(type="press", button=0, x=5, y=33))
    assert app._detail_active and app._detail_uuid == "agent:T2"


# ── a whole turn through the real harness ──────────────────────────────────


def test_session_turn_with_a_subagent_keeps_the_folded_block(tmp_path, monkeypatch):
    from tests.test_progress_handler import _call, _session, _wait_idle

    app = _session(tmp_path, monkeypatch, [
        _call("task", {"description": "look around", "subagent_type": "general-purpose"}, "c3"),
        _call("ls", {"path": "/"}, "s1"),
        AIMessage(content="sub done"),
        AIMessage(content="all done"),
    ])
    strips: list[str] = []
    original = app._on_snapshot

    def record(snap):
        original(snap)
        with app._app.lock:
            app._sync_agent_strip()
            strips.append(_strip_text(app))

    app._bridge._on_snapshot = record
    app._on_submit("go")
    _wait_idle(app)
    # A subagent that completes inside one 40 ms snapshot window can be
    # coalesced straight into its final card without a transient strip frame.
    assert strips[-1] == "", "nothing is left in flight"
    text = plain("\n".join(app._transcript.snapshot()))
    assert "Agent(look around)" in text
    assert re.search(r"⎿ general-purpose · 1 calls · \d+s · \d+ tokens", text)
    assert "⎿ sub done" in text and "all done" in text
    assert "Ls(/)" not in text, "a finished subagent's calls stay folded"
