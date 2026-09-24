"""The composer frame is one closed loop, including while the gradient moves."""

from __future__ import annotations

import re

from circle.ink.components.dialog_frame import build_loop_frame
from circle.ink.components.footer import FooterPane
from circle.ink.dom import NodeType, create_element, create_text
from circle.ink.layout.engine import compute_layout
from circle.ink.output import Output
from circle.ink.render import render_tree
from circle.ink.screen import CharPool, Screen, StylePool
from circle.ink.string_width import string_width

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _plain(text: str) -> str:
    return _ANSI_RE.sub("", text)


def test_quiet_frame_is_a_closed_rectangle():
    top, left, right, bottom = build_loop_frame(18, elapsed=None)
    assert _plain(top) == "╭" + "─" * 16 + "╮"
    assert _plain(bottom) == "╰" + "─" * 16 + "╯"
    assert _plain(left) == "│"
    assert _plain(right) == "│"
    assert string_width(_plain(top)) == 18
    assert string_width(_plain(bottom)) == 18


def test_busy_frame_keeps_corners_and_embeds_label():
    label = "✶ Brewing… (3.5s · ↑ 12 tokens)"
    top, left, right, bottom = build_loop_frame(40, elapsed=1.2, label=label)
    plain_top = _plain(top)
    assert plain_top[0] == "╭" and plain_top[-1] == "╮"
    assert "Brewing" in plain_top
    assert _plain(bottom)[0] == "╰" and _plain(bottom)[-1] == "╯"
    assert _plain(left) == "│" and _plain(right) == "│"
    assert string_width(plain_top) == 40
    assert string_width(_plain(bottom)) == 40


def test_wide_label_is_truncated_so_the_loop_still_closes():
    label = "深度思考中" * 12
    top, _left, _right, bottom = build_loop_frame(24, elapsed=0.4, label=label)
    plain_top = _plain(top)
    assert plain_top[0] == "╭" and plain_top[-1] == "╮"
    assert plain_top.endswith("──╮") or plain_top.endswith("─╮")
    assert "…" in plain_top
    assert string_width(plain_top) == 24
    assert string_width(_plain(bottom)) == 24
    assert _plain(bottom)[0] == "╰" and _plain(bottom)[-1] == "╯"


def test_gradient_moves_without_changing_the_shape():
    a = build_loop_frame(30, elapsed=0.0, label="Brewing")
    b = build_loop_frame(30, elapsed=4.0, label="Brewing")
    assert _plain(a[0]) == _plain(b[0])
    assert _plain(a[3]) == _plain(b[3])
    assert a[0] != b[0]


def test_busy_frame_is_one_rainbow_through_the_label():
    """A pre-colored thinking word must not keep its own shimmer."""
    shimmered = "\x1b[2;34mBre\x1b[94mw\x1b[34ming\x1b[0m… (1s)"
    top, left, right, bottom = build_loop_frame(36, elapsed=0.4, label=shimmered)
    painted = top + left + right + bottom
    assert "38;2" in painted
    assert "\x1b[94m" not in painted
    assert "\x1b[2;34m" not in painted
    plain = _plain(top)
    assert "Brewing" in plain
    assert plain[0] == "╭" and plain[-1] == "╮"


def test_rendered_frame_does_not_spill_onto_the_prompt_row():
    width = 28
    top, left, right, bottom = build_loop_frame(
        width, elapsed=2.0, label="✶ Brewing… (2.0s · ↑ 0 · ↓ 0 tokens)",
    )
    root = create_element(NodeType.ROOT)
    root.style.flex_direction = "column"
    root.style.height = 3
    dialog = create_element(NodeType.BOX)
    dialog.style.height = 3
    dialog.style.overflow = "hidden"

    def _line(text: str, *, height: int = 1, width_fixed: int | None = None, grow: float = 0):
        box = create_element(NodeType.BOX)
        box.style.height = height
        if width_fixed is not None:
            box.style.width = width_fixed
        box.style.flex_grow = grow
        box.append_child(create_text(text))
        return box

    top_box = _line(top)
    mid = create_element(NodeType.BOX)
    mid.style.height = 1
    mid.style.flex_direction = "row"
    mid.append_child(_line(left, width_fixed=1))
    prompt = _line("> hello", grow=1)
    mid.append_child(prompt)
    mid.append_child(_line(right, width_fixed=1))
    dialog.append_child(top_box)
    dialog.append_child(mid)
    dialog.append_child(_line(bottom))
    root.append_child(dialog)

    char_pool = CharPool()
    style_pool = StylePool()
    screen = Screen(width, 3, char_pool, style_pool)
    compute_layout(root, width, 3)
    output = Output(width, 3, char_pool, style_pool, screen)
    render_tree(root, output, char_pool, style_pool)
    output.apply()

    def cell(x: int, y: int) -> str:
        return char_pool.get(screen.get_cell(x, y).char_id)

    assert cell(0, 0) == "╭" and cell(width - 1, 0) == "╮"
    assert cell(0, 1) == "│" and cell(width - 1, 1) == "│"
    assert cell(0, 2) == "╰" and cell(width - 1, 2) == "╯"
    assert cell(1, 1) == ">"
    assert cell(3, 1) == "h"
    # The top edge must not wrap into the prompt row.
    assert cell(2, 1) != "─"


def test_footer_status_is_a_label_for_the_frame():
    captured: list[str | None] = []
    footer = FooterPane(thinking_text_cb=captured.append)
    footer._verb = "Brewing"
    footer._busy_since = __import__("time").time() - 3.5
    footer._timer_running = True
    footer._refresh()
    label = captured[-1]
    assert label
    plain = _plain(label)
    assert "─" not in plain
    assert "╭" not in plain
    assert "Brewing" in plain
    top, _left, _right, _bottom = build_loop_frame(48, elapsed=3.5, label=label)
    plain_top = _plain(top)
    assert plain_top[0] == "╭" and plain_top[-1] == "╮"
    assert "Brewing" in plain_top
    assert string_width(plain_top) == 48
