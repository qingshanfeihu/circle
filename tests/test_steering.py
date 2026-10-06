"""enter during a turn steers it: the model reads the message before its next call, the
screen shows it where it landed, and what was not read becomes the next turn."""

from __future__ import annotations

import time

from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool

from circle.events import EventBus
from circle.harness import create_harness
from circle.ink.parse_keypress import KeyPress
from circle.middleware.steering import SteeringInbox, is_steering
from circle.testing import ScriptedModel
from circle.tui.harness_bridge import HarnessBridge
from circle.tui.reducer import MessageReducer
from circle.tui.transcript_view import ViewOptions, render_turn
from tests.test_tui_contract import _fake_session, plain

SEEN: list[list] = []


class Recording(ScriptedModel):
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        SEEN.append(list(messages))
        return super()._generate(messages, stop, run_manager, **kwargs)


def _wait(predicate, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline
        time.sleep(0.02)


def test_a_message_typed_during_a_tool_call_reaches_the_next_model_call(tmp_path):
    SEEN.clear()
    inbox = SteeringInbox()

    @tool
    def slow_step() -> str:
        """A step that takes a while."""
        inbox.put("use the other file", "use the other file")  # typed while it ran
        return "step done"

    model = Recording(responses=[
        AIMessage(content="", tool_calls=[{"name": "slow_step", "args": {}, "id": "s1"}]),
        AIMessage(content="switched to the other file")])
    agent = create_harness(model, root_dir=tmp_path, extra_tools=[slow_step])
    bus = EventBus(run_id="r")
    events: list = []
    bus.subscribe(events.append)
    from circle.events import bind_bus, unbind_bus

    token = bind_bus(bus)
    try:
        result = agent.invoke({"messages": [HumanMessage(content="edit the file")]},
                              config={"configurable": {"thread_id": "t", "circle_inbox": inbox}})
    finally:
        unbind_bus(token)
    second_call = SEEN[1]
    assert is_steering(second_call[-1]) and second_call[-1].content == "use the other file"
    assert [type(m).__name__ for m in second_call[-3:]] == ["AIMessage", "ToolMessage",
                                                            "HumanMessage"]
    assert result["messages"][-1].content == "switched to the other file"
    assert [e["payload"]["text"] for e in events if e.get("kind") == "steer"] == [
        "use the other file"]
    assert inbox.take_delivered() == ["use the other file"] and len(inbox) == 0


def test_a_steering_message_is_drawn_where_it_landed():
    reducer = MessageReducer()
    bus = EventBus(run_id="r")
    bus.subscribe(reducer.dispatch)
    bus.emit("run_start")
    bus.emit("tool_call", tags={"name": "read_file", "lc_tool_run_id": "c1"},
             payload={"input": {"file_path": "/a.py"}})
    bus.emit("tool_result", tags={"name": "read_file", "lc_tool_run_id": "c1"},
             payload={"output": "x = 1"})
    bus.emit("steer", payload={"text": "use b.py instead"})
    rows = plain("\n".join(render_turn(reducer.snapshot(), ViewOptions(width=80)))).split("\n")
    read_at = next(i for i, row in enumerate(rows) if "Read(" in row)
    steer_at = rows.index(" › use b.py instead")
    assert steer_at > read_at


def _session(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 30  # noqa: SLF001
    return app


def _type(app, text: str, key: str = "enter") -> None:
    for ch in text:
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._handle_key(KeyPress(key=key, alt=key.startswith("alt")))  # noqa: SLF001


def test_enter_during_a_turn_steers_and_leftovers_run_next(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._bridge._worker = type("Running", (), {"is_alive": lambda self: True})()  # noqa: SLF001
    app._is_loading = True  # noqa: SLF001
    _type(app, "also update the docs")
    assert len(app._bridge.inbox) == 1 and app._msg_queue == []  # noqa: SLF001
    assert "Steering · 1 waiting" in app._footer._toast_text  # noqa: SLF001
    _type(app, "and then run the tests", key="alt+enter")
    assert app._msg_queue == [("followup", "and then run the tests")]  # noqa: SLF001
    # The turn ends before the model read the steering message: it goes first.
    app._settle_inbox()  # noqa: SLF001
    assert app._msg_queue == [("steering", "also update the docs"),  # noqa: SLF001
                              ("followup", "and then run the tests")]


def test_waiting_messages_are_listed_above_the_input_box(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._bridge._worker = type("Running", (), {"is_alive": lambda self: True})()  # noqa: SLF001
    app._is_loading = True  # noqa: SLF001
    _type(app, "also update the docs")
    _type(app, "and then run the tests", key="alt+enter")
    app._sync_dialog_frame()  # noqa: SLF001
    rows = plain(app._pending_text.value).splitlines()  # noqa: SLF001
    assert rows == [" steering: also update the docs", " follow-up: and then run the tests"]
    assert app._pending_box.style.height == 2  # noqa: SLF001
    app._handle_key(KeyPress(key="alt+up", alt=True))  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert app._pending_text.value == "" and app._pending_box.style.height == 0  # noqa: SLF001


def test_alt_up_brings_unsent_messages_back(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._bridge._worker = type("Running", (), {"is_alive": lambda self: True})()  # noqa: SLF001
    app._is_loading = True  # noqa: SLF001
    _type(app, "first thought")
    _type(app, "second thought", key="alt+enter")
    app._handle_key(KeyPress(key="alt+up", alt=True))  # noqa: SLF001
    assert len(app._bridge.inbox) == 0 and app._msg_queue == []  # noqa: SLF001
    assert app._prompt.model_text(app._prompt.value) == "first thought\n\nsecond thought"  # noqa: SLF001


def test_the_bridge_hands_its_inbox_to_the_run(tmp_path):
    model = Recording(responses=[AIMessage(content="", tool_calls=[
        {"name": "ls", "args": {"path": "/"}, "id": "l1"}]), AIMessage(content="done")])
    SEEN.clear()
    agent = create_harness(model, root_dir=tmp_path)
    done: list = []
    bridge = HarnessBridge(agent=agent, thread_id="b", on_update=lambda _u: None,
                           on_interrupt=lambda _i: None, on_done=done.append,
                           on_error=done.append)
    bridge.inbox.put("look in src too")
    bridge.start("list the files")
    _wait(lambda: done)
    assert any(is_steering(m) and m.content == "look in src too" for m in SEEN[0])


def test_ctrl_q_queues_a_follow_up(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._bridge._worker = type("Running", (), {"is_alive": lambda self: True})()  # noqa: SLF001
    app._is_loading = True  # noqa: SLF001
    _type(app, "after this, run the tests", key="ctrl+q")
    assert app._msg_queue == [("followup", "after this, run the tests")]  # noqa: SLF001
    assert len(app._bridge.inbox) == 0  # noqa: SLF001
