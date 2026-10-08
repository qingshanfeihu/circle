"""A background job the model started ends while nothing runs: a turn starts by itself with
Circle's notice (shown as a row, not as your message). esc holds that off until you send
something; other conversations' notices wait; leaving stops every job."""

from __future__ import annotations

import sys
import threading
import time

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from pydantic import Field

from circle.harness import create_harness
from circle.ink.parse_keypress import KeyPress
from circle.jobs import Owner, is_job_notice
from circle.testing import ScriptedModel
from tests.test_tui_contract import _fake_session, plain

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")


class Recording(ScriptedModel):
    seen: list = Field(default_factory=list)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return super()._generate(messages, stop, run_manager, **kwargs)


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _app(tmp_path, monkeypatch, responses):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 40  # noqa: SLF001
    app._approvals.set_yolo(app._thread_id, True)  # noqa: SLF001
    model = Recording(responses=responses)
    app._agent = create_harness(  # noqa: SLF001
        model, root_dir=app.workspace, home=app.home, checkpointer=app._checkpointer,  # noqa: SLF001
        approvals=app._approvals, jobs=app._jobs)  # noqa: SLF001
    app._bridge = app._make_bridge()  # noqa: SLF001
    return app, model


def _busy(app) -> bool:
    with app._app.lock:  # noqa: SLF001
        return app._bridge.is_running or app._is_loading or bool(app._msg_queue)  # noqa: SLF001


def _wait_idle(app, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while _busy(app):
        assert time.monotonic() < deadline, "the turn did not finish"
        time.sleep(0.02)


def _say(app, text: str) -> None:
    app._on_submit(text)  # noqa: SLF001
    _wait_idle(app)


def _pump(app, predicate, timeout: float = 10) -> bool:
    """Run the session loop's job check until ``predicate`` holds."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        app._maybe_wake_for_jobs()  # noqa: SLF001
        if predicate():
            return True
        time.sleep(0.05)
    return False


def _history(app) -> list:
    state = app._agent.get_state({"configurable": {"thread_id": app._thread_id}})  # noqa: SLF001
    return list(state.values.get("messages", []))


def _shown(app) -> str:
    return "\n".join(plain(row) for row in app._transcript.snapshot())  # noqa: SLF001


def test_a_job_ending_while_idle_starts_a_turn_with_its_notice(tmp_path, monkeypatch):
    app, model = _app(tmp_path, monkeypatch, [
        _call("execute", {"command": "sleep 0.5; echo hi there", "background": True}, "e1"),
        AIMessage(content="started it"),
        AIMessage(content="it printed hi there")])
    _say(app, "start the job")
    assert not any(is_job_notice(m) for m in _history(app))
    assert _pump(app, lambda: any(m.content == "it printed hi there" for m in _history(app)))
    _wait_idle(app)
    notice = next(m for m in _history(app) if is_job_notice(m))
    assert "hi there" in notice.content and "j1" in notice.content
    assert any(is_job_notice(m) for m in model.seen[-1])
    shown = _shown(app)
    assert "◆ j1 done · sleep 0.5; echo hi there" in shown
    assert "it printed hi there" in shown
    assert " › <system-reminder" not in shown, "the notice is not drawn as your message"


def test_after_esc_finished_jobs_wait_for_your_next_message(tmp_path, monkeypatch):
    app, model = _app(tmp_path, monkeypatch, [
        _call("execute", {"command": "sleep 0.4; echo from-job", "background": True}, "e1"),
        _call("execute", {"command": "sleep 20; true"}, "e2"),
        AIMessage(content="answered with the notice")])
    app._on_submit("start and wait")  # noqa: SLF001
    assert _pump(app, lambda: app._jobs.foreground_runs(), 10)  # noqa: SLF001
    app._handle_key(KeyPress(key="escape"))  # noqa: SLF001
    _wait_idle(app)
    assert app._jobs_hold  # noqa: SLF001
    assert _pump(app, lambda: app._jobs.has_notices(app._thread_id))  # noqa: SLF001
    assert not _pump(app, lambda: _busy(app) or any(is_job_notice(m) for m in _history(app)),
                     timeout=1.5), "no turn starts by itself after esc"
    _say(app, "go on")
    history = _history(app)
    notice = next(i for i, m in enumerate(history) if is_job_notice(m))
    asked = next(i for i, m in enumerate(history)
                 if isinstance(m, HumanMessage) and m.content == "go on")
    assert notice > asked and "from-job" in history[notice].content
    assert not app._jobs_hold  # noqa: SLF001


def test_nothing_wakes_while_something_waits_or_after_ten_in_a_row(tmp_path, monkeypatch):
    app, _model = _app(tmp_path, monkeypatch, [AIMessage(content="ok")])
    assert app._can_wake_for_jobs()  # noqa: SLF001
    app._msg_queue.append(("followup", "later"))  # noqa: SLF001
    assert not app._can_wake_for_jobs(), "a queued message of yours goes first"  # noqa: SLF001
    app._msg_queue.clear()  # noqa: SLF001
    app._notice_streak = 10  # noqa: SLF001
    assert not app._can_wake_for_jobs()  # noqa: SLF001


def test_a_notice_of_another_conversation_waits_until_it_is_open(tmp_path, monkeypatch):
    app, _model = _app(tmp_path, monkeypatch, [AIMessage(content="seen in other")])
    job = app._jobs.register("watch", "elsewhere", owner=Owner("other-thread"))  # noqa: SLF001
    app._jobs.finish(job.id, "done", summary="all good")  # noqa: SLF001
    assert not _pump(app, lambda: _busy(app), timeout=1.5)
    assert "j1 done · 0s · elsewhere · in another conversation" in _shown(app)
    app._thread_id = "other-thread"  # noqa: SLF001
    app._bridge = app._make_bridge()  # noqa: SLF001
    assert _pump(app, lambda: any(m.content == "seen in other" for m in _history(app)))


def test_leaving_stops_every_job_and_tells_its_conversation(tmp_path, monkeypatch):
    app, _model = _app(tmp_path, monkeypatch, [AIMessage(content="ok")])
    backend = app._agent._circle_backend  # noqa: SLF001
    job = backend.start_background("sleep 30", owner=Owner(app._thread_id)).job  # noqa: SLF001
    assert app._stop_jobs_at_exit() == 1  # noqa: SLF001
    assert app._jobs.get(job.id).status == "stopped"  # noqa: SLF001
    [record] = _history(app)
    assert record.additional_kwargs["circle_internal"] == "job_exit"
    assert job.id in record.content and "sleep 30" in record.content


def test_a_finished_job_cannot_slip_in_while_your_turn_starts(tmp_path, monkeypatch):
    app, _model = _app(tmp_path, monkeypatch, [AIMessage(content="ok")])
    started = threading.Event()

    def send() -> None:
        app._start_user_turn("hello")  # noqa: SLF001
        started.set()

    with app._app.lock:  # noqa: SLF001
        sender = threading.Thread(target=send)
        sender.start()
        assert not started.wait(0.3), "the turn waits for the lock"
    sender.join(5)
    assert started.is_set()
    _wait_idle(app)


def test_a_bang_command_moved_to_the_background_shares_its_output_when_it_ends(
        tmp_path, monkeypatch):
    app, _model = _app(tmp_path, monkeypatch, [AIMessage(content="ok")])
    for ch in "!sleep 0.6; echo bang-done":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._handle_key(KeyPress(key="enter"))  # noqa: SLF001
    assert _pump(app, lambda: app._jobs.foreground_runs(), 5)  # noqa: SLF001
    assert app._jobs.detach_foreground() == 1  # noqa: SLF001
    _wait_idle(app)
    assert _pump(app, lambda: any((m.additional_kwargs or {}).get("circle_shell")
                                  for m in _history(app)))
    shared = next(m for m in _history(app) if (m.additional_kwargs or {}).get("circle_shell"))
    assert "bang-done" in shared.content
    assert "j1 done" in _shown(app)
