"""The todo_list event kind reaches the reducer.

Ported from InfoTest ``tests/ist_core/test_events_todo_list_kind.py``."""

from __future__ import annotations

import typing

from circle.events import EventBus, EventKind, CircleEvent

def test_todo_list_is_valid_event_kind():
    assert typing.get_args(EventKind).__contains__("todo_list")


def test_event_bus_accepts_todo_list_emit():
    bus = EventBus(run_id="t1")
    seen: list[CircleEvent] = []
    bus.subscribe(seen.append)
    ev = bus.emit("todo_list", payload={"todos": [{"content": "x", "status": "pending"}]})
    assert ev["kind"] == "todo_list"
    assert seen[-1]["payload"]["todos"][0]["content"] == "x"
