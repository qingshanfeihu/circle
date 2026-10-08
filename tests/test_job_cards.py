"""A background agent that stops for approval shows its card in the session, whether a turn
runs or not; the card names the job, the turn's own cards go first, the answer goes back to
the agent, and "allow for this session" is a rule of the conversation it belongs to."""

from __future__ import annotations

import re
import sys
import time

import pytest
from langchain_core.messages import AIMessage

from circle.harness import create_harness
from circle.ink.parse_keypress import KeyPress
from circle.jobs import is_job_notice
from circle.testing import RoutedModel
from tests.test_tui_contract import _fake_session

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _bg(description: str, call_id: str = "t1") -> AIMessage:
    return _call("task", {"description": description, "subagent_type": "general-purpose",
                          "background": True}, call_id)


def _app(tmp_path, monkeypatch, model):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 40  # noqa: SLF001
    app._agent = create_harness(  # noqa: SLF001
        model, root_dir=app.workspace, home=app.home, checkpointer=app._checkpointer,  # noqa: SLF001
        approvals=app._approvals, jobs=app._jobs, ask_user=True)  # noqa: SLF001
    app._host_background_agents()  # noqa: SLF001
    app._bridge = app._make_bridge()  # noqa: SLF001
    return app


def _wait(predicate, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.02)


def _idle(app) -> bool:
    with app._app.lock:  # noqa: SLF001
        return not (app._bridge.is_running or app._is_loading or app._msg_queue)  # noqa: SLF001


def _card_title(app) -> str:
    card = app._exec_approval  # noqa: SLF001
    return card.card_spec().title if card is not None else ""


def _key(app, char: str) -> None:
    app._handle_key(KeyPress(key=char, char=char))  # noqa: SLF001


def _pump(app, predicate, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "timed out"
        app._maybe_wake_for_jobs()  # noqa: SLF001
        time.sleep(0.05)


def test_a_background_agents_card_shows_while_idle_and_the_answer_goes_back(
        tmp_path, monkeypatch):
    model = RoutedModel(
        routes={"BG-WRITE": [_call("execute", {"command": "touch from-agent"}, "e1"),
                             AIMessage(content="agent: file written")]},
        default=[_bg("BG-WRITE write the file"), AIMessage(content="started it"),
                 AIMessage(content="the agent wrote it")])
    app = _app(tmp_path, monkeypatch, model)
    app._on_submit("write it in the background")  # noqa: SLF001
    _wait(lambda: _idle(app) and app._exec_approval is not None)  # noqa: SLF001
    assert _card_title(app) == "j1 general-purpose · Bash needs your permission"
    assert app._jobs.get("j1").status == "waiting"  # noqa: SLF001
    _key(app, "y")
    _wait(lambda: not app._jobs.get("j1").running)  # noqa: SLF001
    assert (app.workspace / "from-agent").exists()
    _pump(app, lambda: _idle(app) and any(
        getattr(m, "content", "") == "the agent wrote it" for m in _history(app)))
    notice = next(m for m in _history(app) if is_job_notice(m))
    assert "agent: file written" in notice.content


def _history(app) -> list:
    state = app._agent.get_state({"configurable": {"thread_id": app._thread_id}})  # noqa: SLF001
    return list(state.values.get("messages", []))


def test_the_turns_own_card_goes_before_a_waiting_background_card(tmp_path, monkeypatch):
    model = RoutedModel(
        routes={"BG-WAIT": [_call("execute", {"command": "touch bg-file"}, "e1"),
                            AIMessage(content="agent done")]},
        default=[_bg("BG-WAIT write"), AIMessage(content="started"),
                 _call("execute", {"command": "touch main-file"}, "m1"),
                 AIMessage(content="main done"), AIMessage(content="noted")])
    app = _app(tmp_path, monkeypatch, model)
    app._on_submit("start it")  # noqa: SLF001
    _wait(lambda: _idle(app) and app._exec_approval is not None)  # noqa: SLF001
    assert _card_title(app).startswith("j1 ")
    # a turn of yours asks too: its card waits behind the one on screen, then comes first
    app._jobs_hold = True  # keep the agent's notice from starting a turn in between  # noqa: SLF001
    app._on_submit("now touch main-file")  # noqa: SLF001
    _wait(lambda: app._approval_queue)  # noqa: SLF001
    assert _card_title(app).startswith("j1 "), "the card on screen stays"
    _key(app, "n")
    _wait(lambda: _card_title(app) == "Bash needs your permission")
    _key(app, "y")
    _wait(lambda: _idle(app) and (app.workspace / "main-file").exists())
    _wait(lambda: not app._jobs.get("j1").running)  # noqa: SLF001
    assert not (app.workspace / "bg-file").exists(), "the agent's call was rejected"


def test_allow_for_this_session_from_a_background_card_is_a_rule_of_its_conversation(
        tmp_path, monkeypatch):
    model = RoutedModel(
        routes={"BG-RULE": [_call("execute", {"command": "touch rule-file"}, "e1"),
                            AIMessage(content="agent done")]},
        default=[_bg("BG-RULE write"), AIMessage(content="started"), AIMessage(content="ok")])
    app = _app(tmp_path, monkeypatch, model)
    app._on_submit("go")  # noqa: SLF001
    _wait(lambda: _idle(app) and app._exec_approval is not None)  # noqa: SLF001
    _key(app, "a")
    _wait(lambda: not app._jobs.get("j1").running)  # noqa: SLF001
    assert not app._approvals.needs_approval(  # noqa: SLF001
        "execute", {"command": "touch rule-file"}, app._thread_id)  # noqa: SLF001


def test_ctrl_c_does_not_answer_a_background_card(tmp_path, monkeypatch):
    model = RoutedModel(
        routes={"BG-KEEP": [_call("execute", {"command": "touch kept"}, "e1"),
                            AIMessage(content="agent done")]},
        default=[_bg("BG-KEEP write"), AIMessage(content="started"), AIMessage(content="ok")])
    app = _app(tmp_path, monkeypatch, model)
    app._on_submit("go")  # noqa: SLF001
    _wait(lambda: _idle(app) and app._exec_approval is not None)  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+c", ctrl=True, char="c"))  # noqa: SLF001
    assert _card_title(app).startswith("j1 ") and app._jobs.get("j1").status == "waiting"  # noqa: SLF001
    app._jobs.stop("j1", by="user")  # noqa: SLF001
    _wait(lambda: app._exec_approval is None)  # noqa: SLF001
    assert app._job_card is None and app._job_rounds == []  # noqa: SLF001


def test_what_you_were_typing_comes_back_after_the_card(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from circle.jobs import Owner

    app = _app(tmp_path, monkeypatch, RoutedModel(default=[AIMessage(content="ok")]))
    app._prompt.restore_draft("half a thought", {})  # noqa: SLF001
    app._last_key_at = 0.0  # the user stopped typing a while ago  # noqa: SLF001
    job = app._jobs.register("agent", "general-purpose · x", owner=Owner(app._thread_id),  # noqa: SLF001
                             finishes_itself=True)
    answers: list = []
    request = {"name": "execute", "args": {"command": "touch x"}}
    app.ask(job, [SimpleNamespace(id="i1", value={"action_requests": [request]})],
            answers.append)
    assert _card_title(app) == f"{job.id} general-purpose · Bash needs your permission"
    assert app._prompt.value == ""  # noqa: SLF001
    _key(app, "y")
    assert answers == [{"decisions": [{"type": "approve"}]}]
    assert app._prompt.value == "half a thought"  # noqa: SLF001
    app._jobs.stop_all()  # noqa: SLF001


def test_read_only_reaches_background_agents_started_before_it(tmp_path, monkeypatch):
    from circle.jobs import Owner

    model = RoutedModel(default=[AIMessage(content="ok")])
    app = _app(tmp_path, monkeypatch, model)
    # /plan rebuilds the agent: with the real harness and this model
    monkeypatch.setattr("circle.tui.session_app.create_harness", create_harness)
    monkeypatch.setattr("circle.tui.session_app.build_chat_model", lambda *a, **k: model)
    earlier = app._agent._circle_backend  # noqa: SLF001
    app._jobs.register("agent", "general-purpose · x", owner=Owner(app._thread_id),  # noqa: SLF001
                       finishes_itself=True)
    app._dispatch_slash("plan", "on")  # noqa: SLF001
    assert earlier.plan_mode, "the running agent's backend is read-only too"
    app._dispatch_slash("plan", "off")  # noqa: SLF001
    assert not earlier.plan_mode
    app._jobs.stop_all()  # noqa: SLF001


def test_a_background_card_held_back_while_typing_comes_back_after_esc(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from circle.jobs import Owner

    app = _app(tmp_path, monkeypatch, RoutedModel(default=[AIMessage(content="ok")]))
    app._prompt.restore_draft("typing", {})  # noqa: SLF001
    app._last_key_at = time.monotonic()  # mid-word: the card is held back  # noqa: SLF001
    job = app._jobs.register("agent", "general-purpose · x", owner=Owner(app._thread_id),  # noqa: SLF001
                             finishes_itself=True)
    request = {"name": "execute", "args": {"command": "touch x"}}
    app.ask(job, [SimpleNamespace(id="i1", value={"action_requests": [request]})], lambda _v: None)
    assert app._exec_approval is None and app._card_defer is not None  # noqa: SLF001
    app._last_key_at = 0.0  # noqa: SLF001
    app._prompt.clear()  # noqa: SLF001
    app._dismiss_user_panels()  # esc on the turn cancels the held-back card  # noqa: SLF001
    assert _card_title(app).startswith(f"{job.id} "), "the agent's card is shown again"
    app._jobs.stop_all()  # noqa: SLF001
