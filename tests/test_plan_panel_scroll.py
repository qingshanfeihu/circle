"""Fixed-height todo window, follow behavior, and wheel routing."""

from __future__ import annotations

import re

from circle.ink.components.plan_panel import MAX_ITEMS, PlanPanel
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


def test_long_plan_has_fixed_height_and_every_visible_item_keeps_its_status() -> None:
    panel = PlanPanel()
    panel.update(_todos(first_open=4), width=60)
    assert panel.node.style.height == MAX_ITEMS + 5
    assert panel.window == (2, 12)
    first = _lines(panel)
    assert "4/20 complete" in first[1]
    assert "上面还有 2 项" in first[2] and "下面还有 8 项" in first[-2]
    assert sum(line.startswith(("   ●", "   ○")) for line in first) == MAX_ITEMS
    assert "● step 2" in first[3] and "○ step 4" in first[5]

    for _ in range(20):
        panel.scroll(1)
    assert panel.window == (10, 20)
    last = _lines(panel)
    assert panel.node.style.height == MAX_ITEMS + 5
    assert "上面还有 10 项" in last[2] and last[-2] == ""
    assert "○ step 19" in last[-3]


def test_scroll_moves_one_item_and_stops_at_both_ends() -> None:
    panel = PlanPanel()
    panel.update(_todos(13))
    assert panel.window == (0, 10)
    assert not panel.scroll(-1)
    assert panel.scroll(1) and panel.window == (1, 11)
    assert panel.scroll(1) and panel.window == (2, 12)
    assert panel.scroll(1) and panel.window == (3, 13)
    assert not panel.scroll(1)
    assert panel.scroll(-1) and panel.window == (2, 12)


def test_updates_follow_first_open_but_resize_preserves_manual_position() -> None:
    panel = PlanPanel()
    todos = _todos(first_open=12)
    panel.update(todos, width=80)
    assert panel.window == (10, 20)
    panel.scroll(-4)
    assert panel.window == (6, 16)
    panel.update(todos, width=45)
    assert panel.window == (6, 16) and panel.node.style.height == MAX_ITEMS + 5
    assert "step 6" in "\n".join(_lines(panel))

    updated = _todos(first_open=3)
    panel.update(updated, width=45)
    assert panel.window == (1, 11)
    panel.scroll(5)
    panel.follow()
    assert panel.window == (1, 11), "a new turn resumes automatic follow"
    panel.clear()
    assert not panel.is_visible and panel.window == (0, 0)
    panel.update(todos)
    assert panel.window == (10, 20), "a hidden panel starts fresh when it reappears"


def test_short_plan_does_not_scroll() -> None:
    panel = PlanPanel()
    panel.update(_todos(3), width=40)
    original = panel._text.value
    assert panel.window == (0, 3)
    assert panel.node.style.height == 6
    assert not panel.scroll(1) and not panel.scroll(-1)
    assert panel._text.value == original


def test_layout_rect_identifies_the_visible_plan_rows(tmp_path, monkeypatch) -> None:
    app = _fake_session(tmp_path, monkeypatch)
    app._plan_panel.update(_todos(15))
    compute_layout(app._app.root, 80, 24)
    rect = app._plan_panel.node.rect
    assert rect.width == 80 and rect.height == MAX_ITEMS + 5
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
    assert app._plan_panel.window == (1, 11) and transcript_scrolls == []
    assert len(renders) == 1
    app._handle_mouse(MouseEvent(type="wheel", button=0, x=10, y=7))
    assert app._plan_panel.window == (0, 10)
    app._handle_mouse(MouseEvent(type="wheel", button=0, x=10, y=7))
    assert app._plan_panel.window == (0, 10) and transcript_scrolls == []

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
    assert app._plan_panel.window == (10, 20)
    app._plan_panel.scroll(-3)
    app._sync_plan_panel(_snapshot(todos))
    app._app._width = 120
    app._sync_plan_panel()
    assert app._plan_panel.window == (7, 17)

    app._sync_plan_panel(_snapshot(_todos(first_open=3)))
    assert app._plan_panel.window == (1, 11)
    app._plan_panel.scroll(5)
    app._open_turn_region()
    assert app._plan_panel.window == (1, 11)
