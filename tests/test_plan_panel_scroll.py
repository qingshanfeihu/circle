"""Fixed-height todo window, follow behavior, and wheel routing."""

from __future__ import annotations

import re

from circle.ink.components.plan_panel import PLAN_ROWS, PlanPanel
from circle.ink.layout.engine import compute_layout
from circle.ink.parse_keypress import MouseEvent
from circle.tui.reducer import MessageReducer
from tests.test_plan_and_turns import _fake_session

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _todos(count: int = 20, *, first_open: int = 0) -> list[dict[str, str]]:
    return [{"content": f"step {index}",
             "status": "completed" if index < first_open else "pending"}
            for index in range(count)]


def _lines(panel: PlanPanel) -> list[str]:
    return [_ANSI.sub("", line) for line in panel._text.value.split("\n")]


def _snapshot(todos: list[dict[str, str]]):
    reducer = MessageReducer()
    reducer.dispatch({"kind": "todo_list", "run_id": "plan", "seq": 1,
                      "payload": {"todos": todos}})
    return reducer.snapshot()


def test_long_plan_is_a_five_row_box_and_every_visible_item_keeps_its_status() -> None:
    panel = PlanPanel()
    panel.update(_todos(first_open=4), width=60)
    assert panel.node.style.height == PLAN_ROWS + 2
    assert panel.window == (2, 7)
    first = _lines(panel)
    assert first[0].startswith("┌─") and "Plan 4/20" in first[0] and first[0].endswith("┐")
    assert first[-1].endswith("3–7 / 20 ─┘")
    assert all(len(line) == 60 for line in first)
    rows = first[1:-1]
    assert len(rows) == PLAN_ROWS
    assert "●" in rows[0] and "step 2" in rows[0]          # completed: lamp lit
    assert "●" not in rows[2] and "step 4" in rows[2]      # pending: unlit

    for _ in range(20):
        panel.scroll(1)
    assert panel.window == (15, 20)
    last = _lines(panel)
    assert panel.node.style.height == PLAN_ROWS + 2
    assert last[-1].endswith("16–20 / 20 ─┘") and "step 19" in last[-2]


def test_scroll_moves_one_item_and_stops_at_both_ends() -> None:
    panel = PlanPanel()
    panel.update(_todos(13))
    assert panel.window == (0, 5)
    assert not panel.scroll(-1)
    for step in range(1, 9):
        assert panel.scroll(1) and panel.window == (step, step + 5)
    assert not panel.scroll(1)
    assert panel.scroll(-1) and panel.window == (7, 12)


def test_updates_follow_the_current_item_but_resize_preserves_manual_position() -> None:
    panel = PlanPanel()
    todos = _todos(first_open=12)
    panel.update(todos, width=80)
    assert panel.window == (10, 15)
    panel.scroll(-4)
    assert panel.window == (6, 11)
    panel.update(todos, width=45)
    assert panel.window == (6, 11) and panel.node.style.height == PLAN_ROWS + 2
    assert "step 6" in "\n".join(_lines(panel))

    updated = _todos(first_open=3)
    panel.update(updated, width=45)
    assert panel.window == (1, 6)
    panel.scroll(5)
    panel.follow()
    assert panel.window == (1, 6), "a new turn resumes automatic follow"
    panel.clear()
    assert not panel.is_visible and panel.window == (0, 0)
    panel.update(todos)
    assert panel.window == (10, 15), "a hidden panel starts fresh when it reappears"


def test_short_plan_does_not_scroll() -> None:
    panel = PlanPanel()
    panel.update(_todos(3), width=40)
    original = panel._text.value
    assert panel.window == (0, 3)
    assert panel.node.style.height == 5  # three rows + the two edges
    assert not panel.scroll(1) and not panel.scroll(-1)
    assert panel._text.value == original


def test_box_hides_while_a_card_holds_the_frame_and_returns_after() -> None:
    panel = PlanPanel()
    panel.update(_todos(8), width=60)
    assert panel.is_visible and panel.node.style.height == PLAN_ROWS + 2
    panel.set_suppressed(True)
    assert not panel.is_visible and panel.node.style.height == 0 and panel._text.value == ""
    assert not panel.scroll(1), "a hidden box does not take the wheel"
    panel.set_suppressed(False)
    assert panel.is_visible and panel.node.style.height == PLAN_ROWS + 2


def test_layout_rect_identifies_the_visible_plan_rows(tmp_path, monkeypatch) -> None:
    app = _fake_session(tmp_path, monkeypatch)
    app._plan_panel.update(_todos(15))
    compute_layout(app._app.root, 80, 24)
    rect = app._plan_panel.node.rect
    assert rect.width == 80 and rect.height == PLAN_ROWS + 2
    assert app._plan_panel_at(rect.x + 10, rect.y)
    assert app._plan_panel_at(rect.x + 10, rect.y + rect.height - 1)
    assert not app._plan_panel_at(rect.x + 10, rect.y - 1)
    assert not app._plan_panel_at(rect.x + 10, rect.y + rect.height)


def test_wheel_routes_by_panel_rectangle_and_short_plan_consumes_it(tmp_path, monkeypatch) -> None:
    app = _fake_session(tmp_path, monkeypatch)
    app._plan_panel.update(_todos(15))
    rect = app._plan_panel.node.rect
    rect.x, rect.y, rect.width, rect.height = 2, 6, 50, app._plan_panel.node.style.height
    monkeypatch.setattr(app, "_mouse_to_screen_coords", lambda x, y: (x, y))
    transcript_scrolls = []
    renders = []
    monkeypatch.setattr(app, "_scroll_transcript", transcript_scrolls.append)
    monkeypatch.setattr(app._app, "render", lambda: renders.append(1))

    app._handle_mouse(MouseEvent(type="wheel", button=1, x=10, y=7))
    assert app._plan_panel.window == (1, 6) and transcript_scrolls == []
    assert len(renders) == 1
    app._handle_mouse(MouseEvent(type="wheel", button=0, x=10, y=7))
    assert app._plan_panel.window == (0, 5)
    app._handle_mouse(MouseEvent(type="wheel", button=0, x=10, y=7))
    assert app._plan_panel.window == (0, 5) and transcript_scrolls == []

    app._handle_mouse(MouseEvent(type="wheel", button=1, x=1, y=7))
    app._handle_mouse(MouseEvent(type="wheel", button=0, x=10, y=21))
    assert transcript_scrolls == [3, -3]

    app._plan_panel.update(_todos(3))
    app._handle_mouse(MouseEvent(type="wheel", button=1, x=10, y=7))
    assert app._plan_panel.window == (0, 3) and transcript_scrolls == [3, -3]
    app._plan_panel.clear()
    app._handle_mouse(MouseEvent(type="wheel", button=1, x=10, y=7))
    assert transcript_scrolls == [3, -3, 3]


def test_session_redraw_preserves_scroll_until_todos_change_and_new_turn_follows(
        tmp_path, monkeypatch) -> None:
    app = _fake_session(tmp_path, monkeypatch)
    todos = _todos(first_open=12)
    app._sync_plan_panel(_snapshot(todos))
    assert app._plan_panel.window == (10, 15)
    app._plan_panel.scroll(-3)
    app._sync_plan_panel(_snapshot(todos))
    app._app._width = 120
    app._sync_plan_panel()
    assert app._plan_panel.window == (7, 12)

    app._sync_plan_panel(_snapshot(_todos(first_open=3)))
    assert app._plan_panel.window == (1, 6)
    app._plan_panel.scroll(5)
    app._open_turn_region()
    assert app._plan_panel.window == (1, 6)
