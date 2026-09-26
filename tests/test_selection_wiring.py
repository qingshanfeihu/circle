"""Circle session mouse + selection wiring, ported from InfoTest IstInkApp.

These tests don't open a terminal. They build CircleSessionApp via __new__
and drive _handle_mouse / _handle_key directly.
"""

from __future__ import annotations

from unittest.mock import patch

from circle.ink.components.transcript import Transcript
from circle.ink.parse_keypress import KeyPress, MouseEvent
from circle.ink.screen import (
    CELL_NORMAL,
    CharPool,
    Screen,
    StylePool,
)
from circle.ink.selection import (
    SelectionState,
    has_selection,
    selection_bounds,
)


class _DummyLock:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FakeApp:
    def __init__(self, width: int = 20, height: int = 5):
        self.lock = _DummyLock()
        char_pool = CharPool()
        self._style_pool = StylePool()
        self._curr_screen = Screen(width, height, char_pool, self._style_pool)
        text = " hello world "
        for i, ch in enumerate(text):
            self._curr_screen.set_cell(
                i, 0, char_pool.intern(ch), self._style_pool.none, 0, CELL_NORMAL
            )
        self.selection = SelectionState()
        self.notify_count = 0
        self.render_count = 0
        self.repaint_count = 0
        self.terminal_writes: list[str] = []
        self.width = width

    def visible_screen(self):
        return self._curr_screen

    def _repaint_full(self) -> None:
        self.repaint_count += 1

    def notify_selection_change(self) -> None:
        self.notify_count += 1

    def render(self) -> None:
        self.render_count += 1

    @property
    def _terminal(self):
        return self

    def write(self, data: str) -> None:
        self.terminal_writes.append(data)


class _FakeFooter:
    def __init__(self):
        self.toasts: list[str] = []

    def set_toast(self, text, ttl_seconds=1.2):
        self.toasts.append(text)

    def set_search_state(self, query, match):
        pass


class _FakeClock:
    def __init__(self, start: float = 1000.0):
        self.t = start

    def tick(self, dt: float = 0.01) -> float:
        self.t += dt
        return self.t

    def __call__(self) -> float:
        return self.t


def _make_app():
    from circle.tui.session_app import CircleSessionApp

    obj = CircleSessionApp.__new__(CircleSessionApp)
    obj._app = _FakeApp()
    obj._footer = _FakeFooter()
    obj._is_loading = False
    obj._exec_approval = None
    obj._secret_entry = None
    obj._detail_active = False
    obj._strip_selecting = False
    obj._ask_session = None
    obj._approvals_page = None
    obj._strip_ids = []
    obj._strip_visible_ids = []
    obj._strip_hover = None
    obj._detail_buttons = []
    obj._detail_hover = None
    obj._autoscroll_timer = None
    obj._autoscroll_delta = 0
    obj._drag_point = None
    obj._transcript = Transcript()
    return obj


def test_left_press_starts_selection_at_cell():
    app = _make_app()
    app._handle_mouse(MouseEvent(type="press", button=0, x=2, y=0))
    sel = app._app.selection
    assert sel.anchor is not None
    assert sel.anchor.col == 2
    assert sel.anchor.row == 0
    assert sel.is_dragging is True
    assert has_selection(sel) is False


def test_drag_motion_sets_focus_after_real_motion():
    app = _make_app()
    app._handle_mouse(MouseEvent(type="press", button=0, x=2, y=0))
    app._handle_mouse(MouseEvent(type="move", button=0, x=2, y=0))
    sel = app._app.selection
    assert sel.focus is None
    app._handle_mouse(MouseEvent(type="move", button=0, x=6, y=0))
    assert sel.focus is not None and sel.focus.col == 6


def test_release_auto_copies_when_dragged():
    app = _make_app()
    app._handle_mouse(MouseEvent(type="press", button=0, x=1, y=0))
    app._handle_mouse(MouseEvent(type="move", button=0, x=5, y=0))
    from circle.ink.termio import osc as osc_mod

    with patch.object(osc_mod, "set_clipboard", return_value="\x1b]52;c;FAKE\x07") as setc:
        app._handle_mouse(MouseEvent(type="release", button=0, x=5, y=0))
    setc.assert_called_once()
    assert setc.call_args[0][0] == "hello"
    assert has_selection(app._app.selection)
    assert any("FAKE" in w for w in app._app.terminal_writes)
    assert any("Copied" in t for t in app._footer.toasts)


def test_double_click_selects_word():
    app = _make_app()
    clock = _FakeClock()
    with patch("time.monotonic", clock):
        app._handle_mouse(MouseEvent(type="press", button=0, x=3, y=0))
        app._handle_mouse(MouseEvent(type="release", button=0, x=3, y=0))
        clock.tick()
        app._handle_mouse(MouseEvent(type="press", button=0, x=3, y=0))
    sel = app._app.selection
    assert sel.anchor is not None and sel.anchor.col == 1
    assert sel.focus is not None and sel.focus.col == 5
    assert sel.anchor_span is not None and sel.anchor_span.kind == "word"


def test_triple_click_selects_line():
    app = _make_app()
    clock = _FakeClock()
    with patch("time.monotonic", clock):
        for _ in range(3):
            app._handle_mouse(MouseEvent(type="press", button=0, x=3, y=0))
            app._handle_mouse(MouseEvent(type="release", button=0, x=3, y=0))
            clock.tick()
        app._handle_mouse(MouseEvent(type="press", button=0, x=3, y=0))
    sel = app._app.selection
    assert sel.anchor is not None and sel.anchor.col == 0
    assert sel.focus is not None and sel.focus.col == app._app._curr_screen.width - 1
    assert sel.anchor_span is not None and sel.anchor_span.kind == "line"


def test_wheel_routes_to_scroll_transcript():
    app = _make_app()
    from circle.ink.selection import Point

    app._app.selection.anchor = Point(col=2, row=0)
    app._app.selection.focus = Point(col=5, row=0)
    calls = []
    app._scroll_transcript = lambda d: calls.append(d)
    app._handle_mouse(MouseEvent(type="wheel", button=0, x=0, y=0))
    app._handle_mouse(MouseEvent(type="wheel", button=1, x=0, y=0))
    assert calls == [-3, 3]
    assert app._app.selection.anchor.col == 2
    assert app._app.selection.focus.col == 5


def test_press_on_right_button_is_ignored():
    app = _make_app()
    app._handle_mouse(MouseEvent(type="press", button=2, x=3, y=0))
    assert app._app.selection.anchor is None


def test_release_without_drag_does_not_copy():
    app = _make_app()
    app._handle_mouse(MouseEvent(type="press", button=0, x=3, y=0))
    from circle.ink.termio import osc as osc_mod

    with patch.object(osc_mod, "set_clipboard", return_value="\x1b]52;c;X\x07") as setc:
        app._handle_mouse(MouseEvent(type="release", button=0, x=3, y=0))
    setc.assert_not_called()


class _StubInputHistory:
    in_search_mode = False
    search_query = ""

    def add(self, text):
        pass


def _attach_minimum_key_state(app):
    app._input_history = _StubInputHistory()
    app._is_loading = False
    app._exec_approval = None
    app._secret_entry = None


def test_ctrl_c_with_selection_copies_and_does_not_abort():
    app = _make_app()
    _attach_minimum_key_state(app)
    from circle.ink.selection import Point

    app._app.selection.anchor = Point(col=1, row=0)
    app._app.selection.focus = Point(col=5, row=0)
    from circle.ink.termio import osc as osc_mod

    with patch.object(osc_mod, "set_clipboard", return_value="\x1b]52;c;FAKE\x07") as setc:
        app._handle_key(KeyPress(key="ctrl+c"))
    setc.assert_called_once()
    assert has_selection(app._app.selection)


def test_escape_with_selection_clears_highlight():
    app = _make_app()
    _attach_minimum_key_state(app)
    from circle.ink.selection import Point

    app._app.selection.anchor = Point(col=1, row=0)
    app._app.selection.focus = Point(col=5, row=0)
    app._handle_key(KeyPress(key="escape"))
    assert not has_selection(app._app.selection)


def test_ctrl_c_without_selection_falls_through_to_abort_branch():
    app = _make_app()
    _attach_minimum_key_state(app)
    app._last_ctrl_c = 0.0
    app._transcript = Transcript()
    app._handle_key(KeyPress(key="ctrl+c"))
    assert not app._app.terminal_writes
    assert any("ctrl+c again" in m for m in app._transcript.snapshot())


class _FakeRect:
    def __init__(self, y: int, width: int, height: int):
        self.x = 0
        self.y = y
        self.width = width
        self.height = height


class _FakeTranscriptNode:
    def __init__(self, scroll_top: int, rect: _FakeRect):
        self.scroll_top = scroll_top
        self.rect = rect


class _FakeTranscript:
    def __init__(self, scroll_top: int, rect_y: int, rect_height: int, content_rows: int):
        self.node = _FakeTranscriptNode(scroll_top, _FakeRect(rect_y, 10, rect_height))
        self._content_rows = content_rows

    def scroll_by(self, delta: int) -> None:
        max_top = max(0, self._content_rows - self.node.rect.height + 1)
        self.node.scroll_top = max(0, min(max_top, self.node.scroll_top + delta))


class _ScrollApp:
    def __init__(self, screen: Screen):
        self.selection = SelectionState()
        self._curr_screen = screen
        self._prev_screen = screen
        self.notify_count = 0
        self.repaint_count = 0
        self.width = screen.width

    def visible_screen(self) -> Screen:
        return self._prev_screen

    def notify_selection_change(self) -> None:
        self.notify_count += 1

    def _repaint_full(self) -> None:
        self.repaint_count += 1


def _make_scroll_app(*, scroll_top: int = 10, rect_height: int = 5, content_rows: int = 100):
    from circle.tui.session_app import CircleSessionApp

    char_pool = CharPool()
    style_pool = StylePool()
    screen = Screen(10, 5, char_pool, style_pool)
    for y, row in enumerate(["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"]):
        for x, ch in enumerate(row):
            screen.set_cell(x, y, char_pool.intern(ch), style_pool.none, 0, CELL_NORMAL)
    obj = CircleSessionApp.__new__(CircleSessionApp)
    obj._app = _ScrollApp(screen)
    obj._transcript = _FakeTranscript(scroll_top, 0, rect_height, content_rows)
    obj._detail_active = False
    return obj


def test_scroll_transcript_shifts_selection_and_captures_offscreen():
    from circle.ink.selection import Point

    app = _make_scroll_app(scroll_top=10, rect_height=5)
    sel = app._app.selection
    sel.anchor = Point(col=0, row=1)
    sel.focus = Point(col=3, row=3)
    app._scroll_transcript(2)
    assert selection_bounds(sel) == (Point(col=0, row=0), Point(col=3, row=1))
    assert sel.scrolled_off_above == ["BBBB"]
    assert app._app.repaint_count == 1
    assert app._app.notify_count == 1


def test_scroll_transcript_round_trip_restores_selection():
    from circle.ink.selection import Point

    app = _make_scroll_app(scroll_top=10, rect_height=5)
    sel = app._app.selection
    sel.anchor = Point(col=0, row=1)
    sel.focus = Point(col=3, row=3)
    app._scroll_transcript(2)
    app._scroll_transcript(-2)
    assert selection_bounds(sel) == (Point(col=0, row=1), Point(col=3, row=3))
    assert sel.scrolled_off_above == []


def test_scroll_transcript_noop_when_clamped_at_top():
    from circle.ink.selection import Point

    app = _make_scroll_app(scroll_top=0, rect_height=5)
    sel = app._app.selection
    sel.anchor = Point(col=0, row=1)
    sel.focus = Point(col=3, row=3)
    app._scroll_transcript(-3)
    assert selection_bounds(sel) == (Point(col=0, row=1), Point(col=3, row=3))
    assert sel.scrolled_off_above == []
    assert app._app.notify_count == 0
    assert app._app.repaint_count == 1


def test_scroll_transcript_ignores_selection_below_viewport():
    from circle.ink.selection import Point

    app = _make_scroll_app(scroll_top=10, rect_height=3)
    sel = app._app.selection
    sel.anchor = Point(col=0, row=4)
    sel.focus = Point(col=3, row=4)
    app._scroll_transcript(2)
    assert selection_bounds(sel) == (Point(col=0, row=4), Point(col=3, row=4))
    assert sel.scrolled_off_above == []
    assert app._app.notify_count == 0
