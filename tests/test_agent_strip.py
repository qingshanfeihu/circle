"""In-flight subagents render as the InfoTest bottom strip: badge, name, what it is
doing, elapsed, tokens; at most six rows, a window that follows the selection."""

import re

import pytest

from circle.ink import theme
from circle.ink.components.dialog_frame import _color_at
from circle.ink.components.footer import FooterPane
from circle.ink.string_width import string_width
from circle.tui.agent_strip import (
    MAX_ROWS,
    card_activity,
    card_elapsed,
    render_agent_strip,
    strip_window,
)

ANSI = re.compile(r"\x1b\[[0-9;]*m")


@pytest.fixture(autouse=True)
def _palette():
    theme.reset_palette()
    theme.set_palette(theme.build_palette("#d6dee6", "#10151a"))
    yield
    theme.reset_palette()


def card(call_id, *, name="general-purpose", description="", title="", start=1000.0,
         tokens=(0, 0), status="running", end=None):
    payload = {"kind": "subagent", "name": name, "tool_use_id": call_id,
               "description": description, "reasoning_title": title, "start_ts": start,
               "tokens_in": tokens[0], "tokens_out": tokens[1], "status": status}
    if end is not None:
        payload["end_ts"] = end
    return (f"agent:{call_id}", payload)


def test_rainbow_frame_does_not_wash_toward_white():
    for index in range(24):
        red, green, blue = _color_at(index, 48, elapsed=1.7)
        assert not (red > 230 and green > 230 and blue > 230)


def test_busy_label_has_no_star_before_the_verb():
    captured: list[str] = []
    footer = FooterPane(thinking_text_cb=captured.append)
    footer._verb = "Thinking"
    footer._busy_since = __import__("time").time() - 2
    footer._timer_running = True
    footer._refresh()
    label = captured[-1]
    assert label.startswith("Thinking")
    assert "✶" not in label


def test_strip_rows_carry_badge_name_activity_elapsed_and_tokens():
    rows = [card("toolu_01AAAAbbbb1111", description="列出当前目录", tokens=(1000, 234)),
            card("call_2", name="explore", title="Planning the search", start=1002.0)]
    lines = [ANSI.sub("", ln) for ln in render_agent_strip(rows, width=80, now=1012.0)]
    assert lines[0] == "─" * 80
    assert lines[1].startswith("  在途 AGENT ─ 2")
    first, second = lines[2], lines[3]
    assert first.startswith("  agent  ") and "general-purpose·bbbb1111" in first
    assert "列出当前目录" in first and "12s" in first and first.rstrip().endswith("1.2k")
    assert "explore·call2" in second and "思考·Planning the search" in second
    assert "10s" in second and second.rstrip().endswith("0")
    assert lines[-1].strip().startswith("↓↑ 选择")


def test_reasoning_title_wins_over_description_and_nothing_shows_a_dash():
    assert card_activity({"reasoning_title": "Plan", "description": "do x"}) == "思考·Plan"
    assert card_activity({"description": "do   x\n y"}) == "do x y"
    assert card_activity({}) == "—"


def test_finished_card_elapsed_stops_at_its_end():
    _uuid, done = card("c", start=100.0, status="ok", end=130.0)
    assert card_elapsed(done, now=500.0) == 30.0
    _uuid, running = card("c", start=100.0)
    assert card_elapsed(running, now=500.0) == 400.0


def test_six_rows_at_most_and_the_window_follows_the_selection():
    rows = [card(f"c{i}", description=f"task {i}") for i in range(8)]
    ids = [uuid for uuid, _c in rows]
    start = strip_window(ids, ids[7], 0)
    assert start == 2
    assert strip_window(ids, ids[3], start) == 2, "a selection inside the window keeps it"
    assert strip_window(ids, ids[0], start) == 0
    visible = rows[start:start + MAX_ROWS]
    raw = render_agent_strip(visible, width=80, now=1001.0, selected=ids[7], total=8,
                             hidden=8 - len(visible))
    lines = [ANSI.sub("", ln) for ln in raw]
    assert lines[1].startswith("  在途 AGENT ─ 8")
    assert sum(1 for ln in lines if ln.startswith("  agent")) == MAX_ROWS
    assert any("另有 2 个在途" in ln for ln in lines)
    selected = next(i for i, ln in enumerate(lines) if "← 选中" in ln)
    assert "task 7" in lines[selected]
    assert raw[selected].startswith(theme.sgr_join(theme.palette().sel_bg, theme.palette().text))
    assert sum("← 选中" in ln for ln in lines) == 1


def test_rows_never_run_past_the_width():
    rows = [card("c1", description="一个非常长的任务描述" * 20, tokens=(123456, 0)),
            card("c2", name="a-very-long-subagent-type-name-indeed", title="x" * 200)]
    for width in (40, 60, 100):
        for line in render_agent_strip(rows, width=width, now=1500.0, selected="agent:c1"):
            assert string_width(ANSI.sub("", line)) == width


def test_nothing_running_draws_nothing():
    assert render_agent_strip([], width=80) == []
