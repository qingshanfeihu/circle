"""How background jobs look: rows under the strip's header while they run, one short line
under a call that went to the background, the ◆ row of a finished job (live and when a
session is reopened), /jobs, the job page and ctrl+b."""

from __future__ import annotations

import re
import sys
import time

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from circle.harness import create_harness
from circle.ink import theme
from circle.ink.parse_keypress import KeyPress
from circle.ink.string_width import string_width
from circle.jobs import Job, JobRegistry, Notice, Owner, notice_message
from circle.testing import ScriptedModel
from circle.tui.job_rows import notice_rows, render_job_band, render_job_rows, strip_header
from circle.tui.message_model import (
    BLOCK_JOB_NOTICE,
    MessageSnapshot,
    make_assistant_message,
    make_payload_block,
    make_tool_result_block,
    make_tool_use_block,
    make_user_message,
)
from circle.tui.replay import saved_turns
from circle.tui.transcript_view import ViewOptions, render_turn
from tests.test_tui_contract import _fake_session, plain as plain_row

ANSI = re.compile(r"\x1b\[[0-9;]*m")
posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")


@pytest.fixture(autouse=True)
def _palette():
    theme.reset_palette()
    theme.set_palette(theme.build_palette("#d6dee6", "#10151a"))
    yield
    theme.reset_palette()


def plain(rows):
    return [ANSI.sub("", r) for r in rows]


def _job(job_id="j1", *, kind="shell", title="npm run dev", status="running", **extra) -> Job:
    return Job(id=job_id, kind=kind, title=title, status=status, **extra)


def test_job_rows_carry_lamp_id_title_activity_and_time():
    rows = render_job_rows([_job(), _job("j2", kind="agent", title="explore · find the tests",
                                         status="waiting")],
                           width=80, activity={"j1": "listening on :3000"})
    shown = plain(rows)
    assert shown[0].startswith(" ● j1 npm run dev") and "listening on :3000" in shown[0]
    assert "j2 explore · find the tests" in shown[1] and "waiting for you" in shown[1]
    pal = theme.palette()
    assert pal.write_bg.split("[", 1)[1].rstrip("m") in rows[0]
    assert pal.agent_bg.split("[", 1)[1].rstrip("m") in rows[1]
    assert "\x1b[36m" in rows[1] or theme.SGR_WAIT.split("[", 1)[1][:-1] in rows[1]


@pytest.mark.parametrize("width", [20, 33, 60, 120, 200])
def test_job_rows_never_pass_the_screen_edge(width):
    long = _job(title="python3 -m http.server 8000 --directory build/html/really/long/path")
    rows = render_job_rows([long], width=width, activity={"j1": "Serving HTTP on 0.0.0.0 " * 5},
                           hidden=3)
    for row in rows:
        assert string_width(ANSI.sub("", row)) <= width
    assert plain(rows)[-1].strip() == "… +3 more jobs"


def test_the_strip_header_names_what_runs():
    assert plain([strip_header(2, 3, 40)])[0].strip() == "Agents · 2 · Jobs · 3"
    assert plain([strip_header(0, 1, 40)])[0].strip() == "Jobs · 1"


def test_notice_rows_say_how_each_job_ended():
    rows = plain(notice_rows([
        {"id": "j1", "status": "done", "title": "npm test", "elapsed_s": 12},
        {"id": "j2", "status": "failed", "exit_code": 2, "title": "make", "elapsed_s": 75},
        {"id": "j3", "status": "failed", "reason": "timeout", "title": "until curl", "elapsed_s": 300},
        {"id": "j4", "status": "stopped", "reason": "stopped by user", "title": "x", "elapsed_s": 1}]))
    assert rows == [" ◆ j1 done · npm test · 12s", " ◆ j2 failed · exit 2 · make · 1m 15s",
                    " ◆ j3 failed · timeout · until curl · 5m", " ◆ j4 stopped · x · 1s"]


def test_the_job_band_names_the_output_file():
    job = _job(status="done", exit_code=0, virtual_path="/background_jobs/1-2/j1.log")
    band = plain(render_job_band(job, width=60))
    assert "j1 npm run dev" in band[0] and "done" in band[0]
    assert band[1].strip() == "/background_jobs/1-2/j1.log"


def _turn_with(output: str, job: dict) -> list[str]:
    snap = MessageSnapshot(messages=(
        make_assistant_message(uuid="c", content=make_tool_use_block(
            tool_use_id="c", name="execute", input={"command": "npm run dev"}, status="done")),
        make_user_message(uuid="r", content=make_tool_result_block(
            tool_use_id="c", output=output, name="execute", payload={"job": job}))))
    return plain(render_turn(snap, ViewOptions(width=80)))


def test_a_call_that_went_to_the_background_shows_one_short_line():
    started = _turn_with("Started background job j1. Its output goes to /background_jobs/x."
                         " Circle adds a notice when it ends, so do not poll.",
                         {"id": "j1", "how": "started"})
    text = "\n".join(started)
    assert "⎿ in background · j1" in text and "Circle adds a notice" not in text
    moved = _turn_with("compiling 1/9\ncompiling 2/9\n\n[The command was still running after "
                       "120 seconds. It continues as background job j2; its output goes to "
                       "/background_jobs/x/j2.log. Circle adds a notice when it ends, so do not "
                       "poll or sleep for it; stop it with stop_job.]",
                       {"id": "j2", "how": "moved"})
    text = "\n".join(moved)
    assert "compiling 2/9" in text and "moved to background · j2" in text
    assert "stop_job" not in text


def test_a_notice_inside_a_turn_is_drawn_as_its_row():
    snap = MessageSnapshot(messages=(make_user_message(uuid="n", content=make_payload_block(
        BLOCK_JOB_NOTICE, {"jobs": [{"id": "j1", "status": "done", "title": "make",
                                     "elapsed_s": 3}]})),))
    assert " ◆ j1 done · make · 3s" in plain(render_turn(snap, ViewOptions(width=80)))


def _notice_message(job_id: str = "j1"):
    job = Job(id=job_id, kind="shell", title="make", status="done", exit_code=0)
    return notice_message([Notice(job=job, text="ended", wake=True)])


def test_a_reopened_session_draws_notice_turns_without_a_message_of_yours():
    messages = [
        HumanMessage(content="build it"),
        AIMessage(content="", tool_calls=[{"name": "execute", "id": "e1",
                                           "args": {"command": "make", "background": True}}]),
        ToolMessage(content="Started background job j1.", tool_call_id="e1", name="execute",
                    additional_kwargs={"circle_job": {"id": "j1", "how": "started"}}),
        AIMessage(content="started"),
        _notice_message(),
        AIMessage(content="make finished"),
    ]
    turns = saved_turns(messages)
    assert [text for text, _snap in turns] == ["build it", ""]
    first = "\n".join(plain(render_turn(turns[0][1], ViewOptions(width=80))))
    assert "⎿ in background · j1" in first
    second = plain(render_turn(turns[1][1], ViewOptions(width=80)))
    assert second[0] == " ◆ j1 done · make · 0s" and "make finished" in "\n".join(second)


def test_a_notice_read_mid_turn_stays_in_that_turn_when_reopened():
    messages = [
        HumanMessage(content="go"),
        AIMessage(content="", tool_calls=[{"name": "ls", "id": "l1", "args": {}}]),
        ToolMessage(content="a", tool_call_id="l1", name="ls"),
        _notice_message(),
        AIMessage(content="done"),
    ]
    turns = saved_turns(messages)
    assert [text for text, _snap in turns] == ["go"]
    assert " ◆ j1 done · make · 0s" in plain(render_turn(turns[0][1], ViewOptions(width=80)))


# ── the session ─────────────────────────────────────────────────────────────


def _app(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 40  # noqa: SLF001
    app._agent = create_harness(  # noqa: SLF001
        ScriptedModel(responses=[AIMessage(content="ok")]), root_dir=app.workspace,
        home=app.home, checkpointer=app._checkpointer, jobs=app._jobs)  # noqa: SLF001
    app._bridge = app._make_bridge()  # noqa: SLF001
    return app


def _strip(app) -> str:
    app._sync_agent_strip()  # noqa: SLF001
    return ANSI.sub("", app._agent_strip_text.value or "")  # noqa: SLF001


def _keys(app, *keys):
    for key in keys:
        char = key if len(key) == 1 else ""
        app._handle_key(KeyPress(key=key, char=char, ctrl=key.startswith("ctrl+")))  # noqa: SLF001


@posix_only
def test_the_strip_shows_running_jobs_between_turns(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    backend = app._agent._circle_backend  # noqa: SLF001
    job = backend.start_background("echo serving; sleep 30",
                                   owner=Owner(app._thread_id)).job  # noqa: SLF001
    deadline = time.monotonic() + 5
    while "serving" not in _strip(app):
        assert time.monotonic() < deadline
        time.sleep(0.05)
    strip = _strip(app)
    assert "Jobs · 1" in strip and f"{job.id} echo serving; sleep 30" in strip
    app._jobs.stop(job.id, by="user")  # noqa: SLF001
    assert _strip(app) == ""


def test_jobs_lists_them_and_ctrl_d_stops_one_after_asking(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    stopped = []
    first = app._jobs.register("watch", "cex run 7", owner=Owner(app._thread_id),  # noqa: SLF001
                               stop=lambda: stopped.append("j1"))
    done = app._jobs.register("watch", "login", owner=Owner(app._thread_id))  # noqa: SLF001
    app._jobs.finish(done.id, "done")  # noqa: SLF001
    app._dispatch_slash("jobs", "")  # noqa: SLF001
    picker = app._picker  # noqa: SLF001
    labels = [item.label for item in picker.matches()]
    assert labels == [f"{first.id} cex run 7", f"{done.id} login"]
    assert picker.matches()[0].meta.startswith("running")
    _keys(app, "ctrl+d")
    assert stopped == [] and app._jobs.get(first.id).running, "it asks first"  # noqa: SLF001
    _keys(app, "enter")
    assert stopped == ["j1"] and app._jobs.get(first.id).status == "stopped"  # noqa: SLF001
    assert f"{first.id} stopped" in "\n".join(plain_row(r) for r in app._transcript.snapshot())  # noqa: SLF001


def test_enter_on_a_job_opens_its_page(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    log = tmp_path / "out.log"
    log.write_text("line one\nline two\n")
    job = app._jobs.register("watch", "tail", owner=Owner(app._thread_id))  # noqa: SLF001
    app._jobs.update(job.id, output_path=str(log))  # noqa: SLF001
    app._dispatch_slash("jobs", "")  # noqa: SLF001
    _keys(app, "enter")
    assert app._detail_active and app._detail_uuid == f"job:{job.id}"  # noqa: SLF001
    page = "\n".join(plain_row(r) for r in app._agent_detail.snapshot())  # noqa: SLF001
    assert "line one" in page and "line two" in page
    _keys(app, "escape")
    assert not app._detail_active  # noqa: SLF001


def test_ctrl_b_with_nothing_to_move_says_so(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _keys(app, "ctrl+b")
    assert app._footer._toast_text == "Nothing to move"  # noqa: SLF001


@posix_only
def test_ctrl_b_moves_a_bang_command_to_the_background(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    for ch in "!sleep 30":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._handle_key(KeyPress(key="enter"))  # noqa: SLF001
    deadline = time.monotonic() + 5
    while not app._jobs.foreground_runs():  # noqa: SLF001
        assert time.monotonic() < deadline
        time.sleep(0.02)
    _keys(app, "ctrl+b")
    while app._is_loading:  # noqa: SLF001
        assert time.monotonic() < deadline
        time.sleep(0.02)
    [job] = app._jobs.live()  # noqa: SLF001
    assert job.started_by == "user" and job.title == "sleep 30"
    shown = "\n".join(plain_row(r) for r in app._transcript.snapshot())  # noqa: SLF001
    assert f"moved to background · {job.id}" in shown
    app._jobs.stop_all(grace=0.2)  # noqa: SLF001


def test_ctrl_c_to_leave_says_how_many_jobs_it_stops(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._jobs.register("watch", "w", owner=Owner(app._thread_id))  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+c", ctrl=True, char="c"))  # noqa: SLF001
    assert app._footer._toast_text == "Press ctrl+c again to exit · stops 1 job"  # noqa: SLF001
    app._jobs.stop_all()  # noqa: SLF001


def test_what_a_job_writes_for_a_terminal_is_shown_as_plain_text():
    from circle.tui.job_rows import plain_output

    assert plain_output("\x1b[32mready\x1b[0m in \t2s") == "ready in     2s"
    assert plain_output("10%\r50%\r100%") == "100%"
    assert plain_output("\x1b]0;title\x07done\x07") == "done"


def test_a_card_for_a_background_command_says_it_keeps_running():
    from circle.tui.session_app import _approval_body

    assert _approval_body("execute", {"command": "npm run dev", "background": True}) == (
        "$ npm run dev\nruns in the background as a job")
    assert _approval_body("execute", {"command": "ls"}) == "$ ls"


def test_a_background_task_call_opens_no_subagent_card():
    from circle.events import EventBus
    from circle.tui.agent_strip import snapshot_cards
    from circle.tui.reducer import MessageReducer

    reducer = MessageReducer()
    bus = EventBus(run_id="r")
    bus.subscribe(reducer.dispatch)
    tags = {"name": "task", "lc_tool_run_id": "run-1", "lc_tool_call_id": "t1"}
    args = {"description": "find it", "subagent_type": "explore", "background": True}
    bus.emit("tool_call", payload={"name": "task", "input": {"raw": str(args), "args": args}},
             tags=tags)
    bus.emit("tool_result", payload={"name": "task", "output": "Started background explore "
                                     "agent j1.", "job": {"id": "j1", "how": "started"}},
             tags=tags)
    snap = reducer.snapshot()
    assert snapshot_cards(snap) == []
    text = "\n".join(plain(render_turn(snap, ViewOptions(width=80))))
    assert "Agent(find it)" in text and "⎿ in background · j1" in text
    assert "0 calls" not in text
