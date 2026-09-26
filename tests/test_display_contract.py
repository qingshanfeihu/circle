"""InfoTest's final display contract (07 §11.25), as ported to circle.

Block pacing through one gap rule, type tints on tool and thinking rows, the
transcript's bottom without the old spare row, the single-line footer, the composer
frame's labels, the welcome shown once, and the key and mouse matrix: ↑↓ scrolling
when the prompt is empty and history is spent, Home/End, drag-select autoscroll that
grows the selection, hover and click on the strip and the detail buttons.
"""

from __future__ import annotations

import re
import time
import typing

import pytest

from circle.ink import theme
from circle.ink.components.dialog_frame import build_loop_frame
from circle.ink.components.footer import FooterPane
from circle.ink.components.transcript import Transcript
from circle.ink.dom import NodeType, create_element, create_text
from circle.ink.layout.engine import compute_layout
from circle.ink.output import Output
from circle.ink.parse_keypress import KeyPress, MouseEvent
from circle.ink.render import render_tree
from circle.ink.screen import CELL_NORMAL, CharPool, Screen, StylePool
from circle.ink.selection import Point, SelectionState
from circle.ink.string_width import string_width
from circle.tui.message_model import (
    MessageSnapshot,
    make_assistant_message,
    make_payload_block,
    make_system_message,
    make_text_block,
    make_thinking_block,
    make_tool_result_block,
    make_tool_use_block,
    make_user_message,
)
from circle.tui.transcript_view import ViewOptions, render_turn_rows, tool_type_bg_hex

ANSI = re.compile(r"\x1b\[[0-9;]*m")


@pytest.fixture(autouse=True)
def _palette():
    theme.reset_palette()
    theme.set_palette(theme.build_palette("#d6dee6", "#10151a"))
    yield
    theme.reset_palette()


def plain(text: str) -> str:
    return ANSI.sub("", text)


def call(uid, name, args=None):
    return make_assistant_message(uuid=uid, content=make_tool_use_block(
        tool_use_id=uid, name=name, input={"raw": "", "args": args or {}}, status="done"))


def result(uid, name, output="ok"):
    return make_user_message(uuid=f"{uid}:r", content=make_tool_result_block(
        tool_use_id=uid, output=output, is_error=False, name=name, payload={}))


def thinking(uid, text="plan"):
    return make_assistant_message(uuid=uid, content=make_thinking_block(text, done=True))


def text(uid, body):
    return make_assistant_message(uuid=uid, content=make_text_block(body))


def kinds(rows):
    """Each row as the block it is ('' for the gap line)."""
    out = []
    for entry, _bg in rows:
        line = plain(entry)
        if not line:
            out.append("")
        elif "∴" in line:
            out.append("thinking")
        elif theme.GLYPH_AGENT in line:
            out.append("text")
        elif "△" in line or theme.GLYPH_ERROR in line:
            out.append("notice")
        else:
            out.append("tool")
    return out


# ── pacing: one blank between blocks, none inside ─────────────────────────


def test_answer_blocks_and_tool_groups_follow_the_continuation_table():
    snap = MessageSnapshot(messages=(
        thinking("t1"), thinking("t2"), text("x1", "first"),
        text("x2", "second"),
        call("a", "read_file", {"file_path": "/a"}), result("a", "read_file"),
        call("b", "grep", {"pattern": "p"}), result("b", "grep"),
        thinking("t3"),
        call("c", "execute", {"command": "ls"}), result("c", "execute"),
        text("x3", "done"),
        make_system_message(uuid="e", content=make_payload_block("error", {"text": "boom"})),
        make_system_message(uuid="w", content=make_payload_block("warn", {"text": "slow"})),
    ))
    assert kinds(render_turn_rows(snap, ViewOptions())) == [
        "thinking", "thinking", "text",   # ∴ ∴ ⏺ is one answer block
        "", "text",                       # ⏺ → ⏺ are two blocks
        "", "tool", "tool",               # a tool group
        "", "thinking",
        "", "tool",
        "", "text",
        "", "notice", "", "notice",
    ]


def test_type_tints_follow_the_tool_and_leave_answers_plain():
    pal = theme.palette()
    assert tool_type_bg_hex("read_file") == pal.read_bg_hex
    assert tool_type_bg_hex("grep") == tool_type_bg_hex("websearch") == pal.read_bg_hex
    assert tool_type_bg_hex("edit_file") == tool_type_bg_hex("apply_patch") == pal.write_bg_hex
    assert tool_type_bg_hex("task") == pal.agent_bg_hex
    assert tool_type_bg_hex("execute") is None and tool_type_bg_hex("question") is None
    snap = MessageSnapshot(messages=(
        thinking("t"), text("x", "answer"),
        call("a", "read_file", {"file_path": "/a"}), result("a", "read_file"),
        call("b", "write_file", {"file_path": "/b"}), result("b", "write_file"),
        call("c", "execute", {"command": "ls"}), result("c", "execute"),
    ))
    rows = render_turn_rows(snap, ViewOptions(pending_calls=[
        {"name": "edit_file", "args": {"file_path": "/c"}}]))
    tints = [bg for entry, bg in rows if entry]
    assert tints == [pal.think_bg_hex, None, pal.read_bg_hex, pal.write_bg_hex, None,
                     pal.write_bg_hex]
    assert all(bg is None for entry, bg in rows if not entry), "gap lines are never tinted"


def test_tinted_rows_fill_the_width_and_selection_still_wins():
    width = 24
    root = create_element(NodeType.ROOT)
    root.style.height = 2
    view = Transcript()
    root.append_child(view.node)
    view.append_message(" ● Read(/a)\n   ⎿ ok", bg=theme.palette().read_bg_hex)
    char_pool, style_pool = CharPool(), StylePool()
    screen = Screen(width, 2, char_pool, style_pool)
    compute_layout(root, width, 2)
    output = Output(width, 2, char_pool, style_pool, screen)
    render_tree(root, output, char_pool, style_pool)
    output.apply()
    rgb = theme.palette().read_bg_hex.lstrip("#")
    tint = f"48;2;{int(rgb[0:2], 16)};{int(rgb[2:4], 16)};{int(rgb[4:6], 16)}"
    for y in (0, 1):
        last = screen.get_cell(width - 1, y)
        assert any(tint in code for code in style_pool.get(last.style_id)), "row is padded"
    style_pool.set_selection_bg([theme.palette().sel_bg])
    selected = style_pool.get(style_pool.with_selection_bg(screen.get_cell(3, 0).style_id))
    assert theme.palette().sel_bg in selected and not any(tint in c for c in selected)


# ── the transcript component ──────────────────────────────────────────────


def test_block_gap_is_one_blank_line_at_most():
    view = Transcript()
    view.ensure_block_gap()
    assert view.snapshot() == [], "nothing above, no gap"
    view.append_message("a")
    view.ensure_block_gap()
    view.ensure_block_gap()
    assert view.snapshot() == ["a", ""]


def test_tints_follow_their_lines_through_every_edit():
    view = Transcript()
    view.append_messages(["a", "b"], bg="#111111")
    view.replace_range(1, 1, ["x", "y"], bgs=["#222222", None])
    view.update_message_at(0, "a2")
    assert view.snapshot() == ["a2", "x", "y"]
    assert view.snapshot_bgs() == ["#111111", "#222222", None]
    nodes = view.node.children
    assert [n.text_styles.background_color for n in nodes] == ["#111111", "#222222", None]
    copy = Transcript()
    copy.restore(view.snapshot(), view.snapshot_bgs())
    assert copy.snapshot_bgs() == view.snapshot_bgs() and copy.bg_at(-1) is None
    copy.clear()
    assert copy.snapshot_bgs() == []


def test_the_bottom_has_no_spare_row():
    view = Transcript()
    view.node.rect.width, view.node.rect.height = 40, 5
    view.append_messages([f"line {i}" for i in range(5)])
    assert view.max_top() == 0 and view.node.scroll_top == 0, "five rows fit a five-row view"
    view.append_messages(["six", "seven"])
    assert view.node.scroll_top == 2
    view.scroll_by(10)
    assert view.node.scroll_top == 2 and view.node.sticky_scroll
    view.scroll_to(0)
    assert view.node.scroll_top == 0 and not view.node.sticky_scroll
    view.scroll_to(None)
    assert view.node.scroll_top == 2 and view.node.sticky_scroll


def test_sticky_bottom_follows_a_viewport_that_shrank_in_the_same_frame():
    """An approval panel that opens in the same frame as the pending row must not
    hide that row: the bottom is settled when painting, against this frame's view."""
    width, height = 20, 8
    root = create_element(NodeType.ROOT)
    root.style.flex_direction = "column"
    root.style.height = height
    view = Transcript()
    panel = create_element(NodeType.BOX)
    panel.style.height = 0
    root.append_child(view.node)
    root.append_child(panel)
    char_pool, style_pool = CharPool(), StylePool()

    def paint() -> list[str]:
        screen = Screen(width, height, char_pool, style_pool)
        compute_layout(root, width, height)
        output = Output(width, height, char_pool, style_pool, screen)
        render_tree(root, output, char_pool, style_pool)
        output.apply()
        return ["".join(char_pool.get(screen.get_cell(x, y).char_id) for x in range(width)).rstrip()
                for y in range(height)]

    view.append_messages([f"line {i}" for i in range(20)])
    assert paint()[-1] == "line 19"
    panel.style.height = 3
    panel.append_child(create_text("panel"))
    view.append_message("pending")  # settled against the old, taller view
    rows = paint()
    assert rows[4] == "pending" and rows[5] == "panel"
    view.scroll_by(-2)
    assert not view.node.sticky_scroll and paint()[4] == "line 18", "scrolled up stays put"


# ── footer and composer frame ─────────────────────────────────────────────


def _busy_footer(**kwargs) -> tuple[FooterPane, list]:
    labels: list = []
    footer = FooterPane(thinking_text_cb=labels.append, **kwargs)
    footer._verb = "Brewing"  # noqa: SLF001
    footer._busy_since = time.time() - 2  # noqa: SLF001
    footer._timer_running = True  # noqa: SLF001
    return footer, labels


def test_footer_is_one_metering_line_with_yolo_up_front():
    footer, _labels = _busy_footer()
    pal = theme.palette()
    assert footer.node.style.height == 1 and len(footer.node.children) == 2
    footer.set_engine_line("engine")
    assert footer.node.style.height == 2
    footer.set_engine_line("")
    footer.set_yolo(True)
    status = footer._status_line.value  # noqa: SLF001
    assert status.startswith(f" {theme.sgr_join(chr(27) + '[1m', pal.reason)}yolo{pal.reset} · ")
    assert "ctrl+c" not in plain(status), "key hints live in the welcome, not the footer"
    footer.set_search_state("gre", "grep foo")
    assert plain(footer._status_line.value).startswith(" yolo · (reverse-i-search)")  # noqa: SLF001
    footer.shutdown()


def test_toast_and_search_do_not_clear_the_busy_word():
    footer, labels = _busy_footer()
    footer.set_toast("Copied 3 chars", ttl_seconds=0)
    assert labels[-1] and labels[-1].startswith("Brewing")
    footer.set_search_state("x", None)
    assert labels[-1] and labels[-1].startswith("Brewing")
    assert "✶" not in labels[-1] and "✶" in theme.RETIRED_GLYPHS
    footer._timer_running = False  # noqa: SLF001
    footer._refresh()  # noqa: SLF001
    assert labels[-1] is None, "the word goes out only when the timer stops"
    footer.shutdown()


def test_frame_labels_sit_at_column_three_and_keep_the_width(monkeypatch):
    pal = theme.palette()
    monkeypatch.setenv("CIRCLE_TUI_SHIMMER", "0")
    top, _l, _r, bottom = build_loop_frame(40, elapsed=3.0, label="Brewing… · 3s",
                                           bottom_label="tracing off")
    assert plain(top).startswith("╭──Brewing") and plain(bottom).startswith("╰──tracing off")
    assert f"{pal.yellow}tracing off" in bottom
    assert string_width(plain(top)) == string_width(plain(bottom)) == 40
    monkeypatch.setenv("CIRCLE_TUI_SHIMMER", "1")
    busy_top, _l, _r, busy_bottom = build_loop_frame(40, elapsed=3.0, label="深度思考中",
                                                     bottom_label="tracing off")
    assert plain(busy_top).startswith("╭──深度思考中") and string_width(plain(busy_top)) == 40
    assert "38;2" in busy_top and plain(busy_bottom) == plain(bottom), "the alert edge stays still"


# ── the session ───────────────────────────────────────────────────────────


@pytest.fixture
def session(tmp_path, monkeypatch):
    from tests.test_subagent_views import _fake_session

    app = _fake_session(tmp_path, monkeypatch)
    app._app._repaint_full = lambda: None  # noqa: SLF001 — no terminal in tests
    return app


def test_welcome_is_one_message_shown_once(session):
    events = []
    session._extensions.emit = lambda name, payload: events.append(name)  # noqa: SLF001
    session._show_welcome()  # noqa: SLF001
    session._show_welcome()  # noqa: SLF001
    welcome = [m for m in session._transcript.snapshot() if "Circle v" in plain(m)]  # noqa: SLF001
    assert len(welcome) == 1 and welcome[0].startswith("\n")
    assert "/help 查看命令" in plain(welcome[0]) and "ctrl+d 退出" in plain(welcome[0])
    assert events == ["session_start", "session_start"]


def test_user_turn_and_notices_keep_one_blank_between_blocks(session):
    session._bridge.start = lambda *_a, **_k: None  # noqa: SLF001
    session._show_welcome()  # noqa: SLF001
    session._toast("note one")  # noqa: SLF001
    session._toast("note two")  # noqa: SLF001
    session._start_user_turn("hi")  # noqa: SLF001
    lines = [plain(m) for m in session._transcript.snapshot()]  # noqa: SLF001
    at = lines.index(" note one")
    assert lines[at - 1] == "" and lines[at + 1] == "" and lines[at + 2] == " note two"
    rule = next(i for i, ln in enumerate(lines) if ln.startswith("─"))
    assert lines[rule + 1:rule + 4] == ["", " > hi", ""]
    assert session._turn_base == len(lines)  # noqa: SLF001
    session._leave_busy()  # noqa: SLF001


def _tall_transcript(session, rows: int = 60):
    view = session._transcript  # noqa: SLF001
    view.node.rect.width, view.node.rect.height = 80, 10
    view.append_messages([f"row {i}" for i in range(rows)])
    view.scroll_to(None)
    return view


def test_arrows_scroll_when_the_prompt_is_empty_and_history_is_spent(session):
    view = _tall_transcript(session)
    bottom = view.node.scroll_top
    session._handle_key(KeyPress(key="up"))  # noqa: SLF001
    assert view.node.scroll_top == bottom - 3 and session._prompt.value == ""  # noqa: SLF001
    session._handle_key(KeyPress(key="down"))  # noqa: SLF001
    assert view.node.scroll_top == bottom
    session._input_history.add("earlier")  # noqa: SLF001
    session._handle_key(KeyPress(key="up"))  # noqa: SLF001
    assert session._prompt.value == "earlier" and view.node.scroll_top == bottom  # noqa: SLF001
    session._handle_key(KeyPress(key="down"))  # noqa: SLF001
    assert session._prompt.value == "" and view.node.scroll_top == bottom  # noqa: SLF001


def test_page_and_home_end_keys_scroll_only_an_empty_prompt(session):
    view = _tall_transcript(session)
    bottom = view.node.scroll_top
    session._handle_key(KeyPress(key="home"))  # noqa: SLF001
    assert view.node.scroll_top == 0 and not view.node.sticky_scroll
    session._handle_key(KeyPress(key="end"))  # noqa: SLF001
    assert view.node.scroll_top == bottom and view.node.sticky_scroll
    session._handle_key(KeyPress(key="pageup"))  # noqa: SLF001
    assert view.node.scroll_top == bottom - 5
    session._handle_key(KeyPress(key="end"))  # noqa: SLF001
    session._prompt.set_value("draft")  # noqa: SLF001
    for key in ("home", "pageup", "end"):
        session._handle_key(KeyPress(key=key))  # noqa: SLF001
        assert view.node.scroll_top == bottom, f"{key} belongs to the prompt"
    assert session._prompt.value == "draft"  # noqa: SLF001


class _FakeTimer:
    made: typing.ClassVar[list] = []

    def __init__(self, interval, function):
        self.interval, self.function, self.cancelled = interval, function, False
        self.daemon = False
        _FakeTimer.made.append(self)

    def start(self):
        pass

    def cancel(self):
        self.cancelled = True


class _Lock:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _ScreenApp:
    def __init__(self, screen: Screen):
        self.selection = SelectionState()
        self._curr_screen = self._prev_screen = screen
        self.lock = _Lock()
        self.width = screen.width

    def visible_screen(self):
        return self._prev_screen

    def notify_selection_change(self):
        pass

    def render(self):
        pass

    def _repaint_full(self):
        pass

    @property
    def _terminal(self):
        return self

    def write(self, _data):
        pass


class _StubFooter:
    def set_toast(self, *_a, **_k):
        pass


def _drag_app(monkeypatch):
    from circle.tui.session_app import CircleSessionApp

    char_pool, style_pool = CharPool(), StylePool()
    screen = Screen(10, 5, char_pool, style_pool)
    for y, row in enumerate(["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"]):
        for x, ch in enumerate(row):
            screen.set_cell(x, y, char_pool.intern(ch), style_pool.none, 0, CELL_NORMAL)
    app = CircleSessionApp.__new__(CircleSessionApp)
    app._app = _ScreenApp(screen)  # noqa: SLF001
    app._transcript = Transcript()  # noqa: SLF001
    app._transcript.node.rect.width, app._transcript.node.rect.height = 10, 5  # noqa: SLF001
    app._transcript.append_messages([f"row {i}" for i in range(40)])  # noqa: SLF001
    app._transcript.scroll_to(10)  # noqa: SLF001
    app._detail_active = False  # noqa: SLF001
    app._footer = _StubFooter()  # noqa: SLF001
    app._autoscroll_timer = None  # noqa: SLF001
    app._autoscroll_delta = 0  # noqa: SLF001
    app._drag_point = None  # noqa: SLF001
    _FakeTimer.made = []
    monkeypatch.setattr("circle.tui.session_app.threading.Timer", _FakeTimer)
    return app


def test_dragging_to_the_edge_keeps_scrolling_and_grows_the_selection(monkeypatch):
    app = _drag_app(monkeypatch)
    sel = app._app.selection  # noqa: SLF001
    sel.anchor, sel.is_dragging = Point(col=0, row=1), True
    app._handle_mouse(MouseEvent(type="move", button=0, x=3, y=4))  # noqa: SLF001
    assert app._autoscroll_delta == 2 and len(_FakeTimer.made) == 1  # noqa: SLF001
    _FakeTimer.made[0].function()
    assert app._transcript.node.scroll_top == 12, "one step scrolls two rows"  # noqa: SLF001
    assert sel.focus == Point(col=3, row=4), "the end stays under the mouse"
    assert sel.scrolled_off_above == ["BBBB"], "rows that left the view stay selected"
    assert len(_FakeTimer.made) == 2, "and the next step is armed"
    app._handle_mouse(MouseEvent(type="move", button=0, x=3, y=2))  # noqa: SLF001
    assert app._autoscroll_timer is None and _FakeTimer.made[1].cancelled  # noqa: SLF001
    app._handle_mouse(MouseEvent(type="move", button=0, x=3, y=0))  # noqa: SLF001
    assert app._autoscroll_delta == -2  # noqa: SLF001
    app._handle_mouse(MouseEvent(type="release", button=0, x=3, y=0))  # noqa: SLF001
    assert app._autoscroll_timer is None and not sel.is_dragging  # noqa: SLF001


def test_wheel_while_dragging_extends_and_after_release_moves_the_selection(monkeypatch):
    app = _drag_app(monkeypatch)
    sel = app._app.selection  # noqa: SLF001
    sel.anchor, sel.focus, sel.is_dragging = Point(col=0, row=1), Point(col=3, row=3), True
    app._drag_point = (3, 3)  # noqa: SLF001
    app._handle_mouse(MouseEvent(type="wheel", button=1, x=3, y=3))  # noqa: SLF001
    assert sel.focus == Point(col=3, row=3), "while dragging the end stays under the mouse"
    assert sel.anchor.row == 0 and sel.virtual_anchor_row == -2
    assert sel.scrolled_off_above == ["BBBB", "CCCC"]
    sel.is_dragging = False
    app._handle_mouse(MouseEvent(type="wheel", button=0, x=3, y=3))  # noqa: SLF001
    assert sel.anchor == Point(col=0, row=1), "a finished selection moves with the content"
    assert sel.virtual_focus_row == 6 and sel.scrolled_off_above == []


def test_strip_hover_and_detail_buttons(session):
    from tests.test_subagent_views import Feed

    feed = Feed()
    feed.task("T1", "left side")
    feed.task("T2", "right side")
    session._open_turn_region()  # noqa: SLF001
    session._on_snapshot(feed.snap())  # noqa: SLF001
    session._sync_agent_strip()  # noqa: SLF001
    session._agent_strip.rect.y = 30  # noqa: SLF001
    session._mouse_to_screen_coords = lambda x, y: (x, y)  # noqa: SLF001
    pal = theme.palette()

    session._handle_mouse(MouseEvent(type="move", button=3, x=5, y=33))  # noqa: SLF001
    assert session._strip_hover == "agent:T2"  # noqa: SLF001
    hovered = next(ln for ln in session._agent_strip_text.value.splitlines() if "right side" in ln)  # noqa: SLF001
    assert hovered.startswith(theme.sgr_join(pal.sel_bg, pal.text)) and "← 选中" not in hovered
    session._handle_mouse(MouseEvent(type="press", button=0, x=5, y=33))  # noqa: SLF001
    assert session._detail_active and session._detail_uuid == "agent:T2"  # noqa: SLF001

    session._agent_detail_band.rect.y = 0  # noqa: SLF001
    start, _end, _action = next(span for span in session._detail_buttons if span[2] == "prev")  # noqa: SLF001
    session._handle_mouse(MouseEvent(type="move", button=3, x=start + 1, y=1))  # noqa: SLF001
    assert session._detail_hover == "prev"  # noqa: SLF001
    assert f"{theme.sgr_join(pal.sel_bg, pal.em)} 上一个 " in session._agent_detail_band_text.value  # noqa: SLF001
    session._handle_mouse(MouseEvent(type="press", button=0, x=start + 1, y=1))  # noqa: SLF001
    assert session._detail_uuid == "agent:T1"  # noqa: SLF001
    back = next(span for span in session._detail_buttons if span[2] == "back")  # noqa: SLF001
    session._handle_mouse(MouseEvent(type="press", button=0, x=back[0], y=1))  # noqa: SLF001
    assert not session._detail_active  # noqa: SLF001


def test_a_lone_escape_is_the_esc_key(monkeypatch):
    from circle.ink.parse_keypress import InputParser
    from circle.tui.session_app import _StandaloneEscapeInputParser

    _FakeTimer.made = []
    monkeypatch.setattr("circle.tui.session_app.threading.Timer", _FakeTimer)
    emitted: list = []
    parser = _StandaloneEscapeInputParser(InputParser(), emitted.append)
    assert parser.feed("\x1b") == [] and len(_FakeTimer.made) == 1
    _FakeTimer.made[0].function()
    assert [event.key for event in emitted] == ["escape"]
    assert [event.key for event in parser.feed("[A")] == ["up"], "a late sequence tail keeps its ESC"
    assert [event.key for event in parser.feed("\x1b[B")] == ["down"]
    assert [event.key for event in parser.feed("x")] == ["x"] and len(_FakeTimer.made) == 1
    parser.feed("\x1b")
    assert [event.key for event in parser.feed("b")] == ["alt+b"] and _FakeTimer.made[1].cancelled
