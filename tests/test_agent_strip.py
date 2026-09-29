"""In-flight subagents render as the bottom strip: a ` Agents · N` header, then one row
per subagent — lamp, name, what it is doing, elapsed · tokens; at most six rows, a
window that follows the selection."""

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
         tokens=(0, 0), status="running", end=None, **extra):
    payload = {"kind": "subagent", "name": name, "tool_use_id": call_id,
               "description": description, "reasoning_title": title, "start_ts": start,
               "tokens_in": tokens[0], "tokens_out": tokens[1], "status": status, **extra}
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


def test_strip_rows_carry_lamp_name_activity_elapsed_and_tokens():
    rows = [card("toolu_01AAAAbbbb1111", description="列出当前目录", tokens=(1000, 234)),
            card("call_2", name="explore", title="Planning the search", start=1002.0)]
    raw = render_agent_strip(rows, width=80, now=1012.0)
    lines = [ANSI.sub("", ln) for ln in raw]
    assert len(lines) == 3, "header + one row per subagent; no rule, no hint line"
    pal = theme.palette()
    assert raw[0].startswith(theme.sgr_join(pal.panel_bg, pal.faint))
    assert lines[0].rstrip() == " Agents · 2" and string_width(lines[0]) == 80
    first, second = lines[1], lines[2]
    assert first.startswith(" ● general-purpose·bbbb1111  ")
    assert _lamp("running", 1012.0) in raw[1], "the lamp shares the row's background SGR"
    assert "列出当前目录" in first and first.rstrip().endswith("12s · 1.2k tokens")
    assert "explore·call2" in second and "Planning the search" in second
    assert "思考" not in second
    assert second.rstrip().endswith("10s · 0 tokens")
    assert "agent " not in first and "↓↑" not in "".join(lines)



def _lamp(state: str, now: float = 0.0) -> str:
    """The lamp's colour code + glyph as it sits inside a row's combined SGR (``…;33m●``)."""
    return theme.status_light(state, now=now, reset=False)[2:]


def test_a_card_waiting_on_the_user_gets_the_wait_lamp_and_says_so():
    rows = [card("c1", description="build it", awaiting_approval=True),
            card("c2", description="ask it", awaiting_question=True),
            card("c3", description="still going")]
    raw = render_agent_strip(rows, width=80, now=1005.0)
    lines = [ANSI.sub("", ln) for ln in raw]
    wait = _lamp("wait")
    assert wait in raw[1] and wait in raw[2] and wait not in raw[3]
    assert "waiting for you" in lines[1] and "build it" not in lines[1]
    assert "waiting for you" in lines[2] and "ask it" not in lines[2]
    assert "still going" in lines[3]
    assert _lamp("running", 1005.0) in raw[3]


def test_reasoning_title_wins_over_description_and_nothing_shows_a_dash():
    assert card_activity({"reasoning_title": "Plan", "description": "do x"}) == "Plan"
    assert card_activity({"description": "do   x\n y"}) == "do x y"
    assert card_activity({}) == "—"
    assert card_activity({"awaiting_approval": True, "reasoning_title": "Plan"}) == "waiting for you"
    assert card_activity({"awaiting_question": True, "description": "do x"}) == "waiting for you"


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
    assert lines[0].rstrip() == " Agents · 8"
    assert sum(1 for ln in lines if ln.startswith(" ● ")) == MAX_ROWS
    assert lines[-1].rstrip() == "  … +2 more"
    pal = theme.palette()
    on_sel = [i for i, ln in enumerate(raw) if ln.startswith(theme.sgr_join(pal.sel_bg, ""))]
    assert len(on_sel) == 1
    assert "task 7" in lines[on_sel[0]]
    assert theme.sgr_join(pal.sel_bg, pal.em) in raw[on_sel[0]]


def test_rows_never_run_past_the_width():
    rows = [card("c1", description="一个非常长的任务描述" * 20, tokens=(123456, 0)),
            card("c2", name="a-very-long-subagent-type-name-indeed", title="x" * 200)]
    for width in (40, 60, 100):
        for line in render_agent_strip(rows, width=width, now=1500.0, selected="agent:c1"):
            assert string_width(ANSI.sub("", line)) == width


def test_nothing_running_draws_nothing():
    assert render_agent_strip([], width=80) == []


def test_a_long_activity_leaves_room_for_the_meter():
    rows = [card("c1", description="一个非常长的任务描述" * 20, tokens=(8200, 0)),
            card("c2", description="short")]
    raw = render_agent_strip(rows, width=100, now=1500.0, selected="agent:c1", hover="agent:c2")
    lines = [ANSI.sub("", ln) for ln in raw]
    row = next(ln for ln in lines if "一个非常长" in ln)
    assert "…" in row, "the doing column gives way first"
    assert row.endswith("8m 20s · 8.2k tokens "), row
    assert string_width(row) == 100
    assert "← 选中" not in "".join(lines)
    pal = theme.palette()
    hovered = next(ln for ln in raw if "short" in ln)
    assert hovered.startswith(theme.sgr_join(pal.sel_bg, ""))
    assert theme.sgr_join(pal.sel_bg, pal.em) in hovered
