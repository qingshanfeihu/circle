"""In-flight subagents render as the InfoTest bottom strip."""

from circle.ink.components.dialog_frame import _color_at
from circle.ink.components.footer import FooterPane
from circle.tui.agent_strip import render_agent_strip


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


def test_agent_strip_lists_running_tasks_under_a_header():
    lines = render_agent_strip(
        [
            {"name": "explore", "action": "列出当前目录", "started": 1000.0},
            {"name": "explore", "action": "说明 pathlib", "started": 1002.0},
        ],
        width=60,
        now=1012.0,
    )
    plain = "\n".join(lines)
    assert "在途 AGENT ─ 2" in plain
    assert plain.count("explore") == 2
    assert "列出当前目录" in plain
    assert "说明 pathlib" in plain
    assert "12s" in plain
    assert lines[0].endswith("─" * 60) or "─" * 40 in lines[0]
