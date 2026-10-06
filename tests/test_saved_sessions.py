"""Conversations survive a restart: the folder's list, ``-c`` / ``--session``, print mode
going on with a saved conversation, and the screen drawn again from saved messages."""

from __future__ import annotations

import time
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from circle import session_index
from circle.checkpoint_store import make_checkpointer
from circle.cli import _parse, _saved_thread
from circle.harness import create_harness
from circle.headless import HeadlessRun
from circle.testing import ScriptedModel
from circle.tui.replay import saved_turns
from circle.ink.parse_keypress import KeyPress
from circle.tui.transcript_view import ViewOptions, render_turn
from tests.test_tui_contract import plain


def test_the_list_is_per_folder_newest_first_and_keeps_titles(tmp_path):
    home, a, b = tmp_path / "home", tmp_path / "a", tmp_path / "b"
    a.mkdir(), b.mkdir()
    for args, kwargs in ((("circle-11111111", a), {"title": "first", "model": "m"}),
                         (("circle-22222222", a), {"title": "second", "model": "m"}),
                         (("circle-33333333", b), {"title": "elsewhere", "model": "m"}),
                         (("circle-11111111", a), {})):  # used again; the title stays
        session_index.record(home, *args, **kwargs)
        time.sleep(0.01)
    listed = session_index.for_workspace(home, a)
    assert [(s.thread_id, s.title) for s in listed] == [("circle-11111111", "first"),
                                                       ("circle-22222222", "second")]
    assert session_index.latest(home, b).thread_id == "circle-33333333"
    assert session_index.find(home, "2222").thread_id == "circle-22222222"
    assert session_index.find(home, "circle-") is None, "ambiguous"
    assert session_index.find(home, "%") is None


def test_continue_and_session_pick_a_saved_conversation(tmp_path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    session_index.record(home, "circle-aaaaaaaa", ws, title="one")
    args = _parse(["-c", str(ws)])
    assert _saved_thread(args, home, ws) == "circle-aaaaaaaa"
    assert _saved_thread(_parse(["--session", "aaaa", str(ws)]), home, ws) == "circle-aaaaaaaa"
    assert _saved_thread(_parse(["--session", "zzzz", str(ws)]), home, ws) == 2
    assert _saved_thread(_parse([str(ws)]), home, ws) is None
    empty = tmp_path / "empty"
    empty.mkdir()
    assert _saved_thread(_parse(["-c", str(empty)]), home, empty) is None


def test_p_works_as_a_flag_before_other_options(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    args = _parse(["-p", "-c", "what changed?", str(ws)])
    assert (args.prompt, args.workspace, args.resume_latest) == ("what changed?", str(ws), True)
    args = _parse(["-p", "-c", "what changed?"])
    assert (args.prompt, args.workspace) == ("what changed?", ".")
    args = _parse(["-p", "summarize", str(ws)])
    assert (args.prompt, args.workspace) == ("summarize", str(ws))
    args = _parse(["-p", str(ws)])
    assert (args.prompt, args.workspace) == ("", str(ws)), "a folder alone: the prompt is piped"


def _agent(tmp_path: Path, responses: list) -> object:
    return create_harness(ScriptedModel(responses=responses), root_dir=tmp_path / "ws",
                          home=tmp_path / "home", checkpointer=make_checkpointer(tmp_path / "home"))


def test_print_mode_goes_on_with_a_saved_conversation(tmp_path):
    (tmp_path / "ws").mkdir()
    first = HeadlessRun(_agent(tmp_path, [AIMessage(content="OK")]))
    assert first.turn("remember MARMALADE") == "OK"
    # A new process: a new agent on the same data folder, told which thread to use.
    later = HeadlessRun(_agent(tmp_path, [AIMessage(content="MARMALADE")]),
                        thread_id=first.thread_id)
    assert later.turn("which word?") == "MARMALADE"
    state = later.agent.get_state(later.config)
    assert [m.content for m in state.values["messages"] if isinstance(m, HumanMessage)] == [
        "remember MARMALADE", "which word?"]


def test_saved_messages_are_drawn_like_a_live_turn():
    messages = [
        HumanMessage(content="fix the test"),
        AIMessage(content="", tool_calls=[{"name": "read_file", "args": {"file_path": "/a.py"},
                                           "id": "r1"}],
                  additional_kwargs={"reasoning_content": "look at the file first"}),
        ToolMessage(content="@@ lines 1-3 of 3 @@\nx = 1\ny = 2\nz = 3", tool_call_id="r1",
                    name="read_file"),
        AIMessage(content="", tool_calls=[{"name": "execute", "args": {"command": "pytest -q"},
                                           "id": "e1"}]),
        ToolMessage(content="1 failed", tool_call_id="e1", name="execute", status="error"),
        HumanMessage(content="going in circles", additional_kwargs={"circle_loop_guard": True}),
        HumanMessage(content="summary", additional_kwargs={"lc_source": "summarization"}),
        AIMessage(content="Fixed it."),
        HumanMessage(content="thanks"),
        AIMessage(content="You are welcome."),
    ]
    turns = saved_turns(messages)
    assert [text for text, _snap in turns] == ["fix the test", "thanks"]
    shown = plain("\n".join(render_turn(turns[0][1], ViewOptions(width=80))))
    assert "Read(/a.py:1-3)" in shown and "Read 3 lines" in shown
    assert "Bash(pytest -q)" in shown and "1 failed" in shown
    assert "Fixed it." in shown and "∴" in shown
    assert "You are welcome." in plain("\n".join(render_turn(turns[1][1], ViewOptions(width=80))))


def test_resume_reopens_a_conversation_from_an_earlier_run(tmp_path, monkeypatch):
    from tests.test_tui_contract import _fake_session

    from types import SimpleNamespace

    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 30  # noqa: SLF001
    saved = {"circle-0ld0ld00": [HumanMessage(content="remember MARMALADE"),
                                 AIMessage(content="OK")]}
    app._agent.get_state = lambda config: SimpleNamespace(  # noqa: SLF001 — the checkpoint store
        values={"messages": saved.get(config["configurable"]["thread_id"], [])})
    session_index.record(app.home, "circle-0ld0ld00", app.workspace, title="code word")
    app._dispatch_slash("resume", "")  # noqa: SLF001
    listed = plain("\n".join(app._picker.render_lines(100)))  # noqa: SLF001
    assert "Sessions · this folder" in listed and "code word" in listed
    for ch in "code":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._handle_key(KeyPress(key="enter"))  # noqa: SLF001
    shown = [plain(row) for row in app._transcript.snapshot()]  # noqa: SLF001
    assert app._thread_id == "circle-0ld0ld00" and app._session_title == "code word"  # noqa: SLF001
    assert " › remember MARMALADE" in shown and " ⏺ OK" in shown
    assert app._turns, "ctrl+o and ctrl+t can redraw the reopened turns"  # noqa: SLF001


def _app_with_history(tmp_path, monkeypatch):
    """A session whose agent really keeps state, after two turns."""
    from tests.test_tui_contract import _fake_session

    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 30  # noqa: SLF001
    app._agent = create_harness(  # noqa: SLF001
        ScriptedModel(responses=[AIMessage(content="first answer"),
                                 AIMessage(content="second answer")]),
        root_dir=app.workspace, home=app.home, checkpointer=app._checkpointer)  # noqa: SLF001
    config = {"configurable": {"thread_id": app._thread_id}}  # noqa: SLF001
    for text in ("first question", "second question"):
        app._session_tree.add("user", text)  # noqa: SLF001
        app._agent.invoke({"messages": [HumanMessage(content=text)]}, config=config)  # noqa: SLF001
        app._session_tree.add("assistant", text.replace("question", "answer"))  # noqa: SLF001
    return app


def _model_history(app) -> list[str]:
    state = app._agent.get_state({"configurable": {"thread_id": app._thread_id}})  # noqa: SLF001
    return [str(m.content) for m in state.values.get("messages", [])]


def test_clone_carries_the_model_history(tmp_path, monkeypatch):
    app = _app_with_history(tmp_path, monkeypatch)
    old = app._thread_id  # noqa: SLF001
    app._dispatch_slash("clone", "")  # noqa: SLF001
    assert app._thread_id != old  # noqa: SLF001
    assert _model_history(app) == ["first question", "first answer",
                                   "second question", "second answer"]
    shown = [plain(row) for row in app._transcript.snapshot()]  # noqa: SLF001
    assert " › second question" in shown and " ⏺ second answer" in shown


def test_fork_at_a_message_keeps_what_came_before_and_gives_it_back(tmp_path, monkeypatch):
    app = _app_with_history(tmp_path, monkeypatch)
    second = [n for n in app._session_tree.path_to() if n.text == "second question"][0]  # noqa: SLF001
    app._dispatch_slash("fork", second.id)  # noqa: SLF001
    assert _model_history(app) == ["first question", "first answer"]
    assert app._prompt.value == "second question"  # noqa: SLF001
    shown = [plain(row) for row in app._transcript.snapshot()]  # noqa: SLF001
    assert " ⏺ first answer" in shown and not any("second" in row for row in shown
                                                   if row.startswith(" ›"))


def test_a_compact_request_is_not_replayed_as_a_turn():
    messages = [
        HumanMessage(content="first"), AIMessage(content="answer"),
        HumanMessage(content="Call the compact_conversation tool now",
                     additional_kwargs={"circle_internal": "compact"}),
        AIMessage(content="", tool_calls=[{"name": "compact_conversation", "args": {},
                                           "id": "c1"}]),
        ToolMessage(content="Nothing to compact yet", tool_call_id="c1",
                    name="compact_conversation"),
        AIMessage(content="COMPACT_OK"),
        HumanMessage(content="second"), AIMessage(content="again"),
    ]
    turns = saved_turns(messages)
    assert [text for text, _snap in turns] == ["first", "second"]
    assert "COMPACT_OK" not in plain("\n".join(render_turn(turns[0][1], ViewOptions(width=80))))


def test_the_resume_list_is_cut_to_the_screen_not_wrapped(tmp_path, monkeypatch):
    from tests.test_tui_contract import _fake_session

    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 50, 30  # noqa: SLF001
    app._transcript.node.rect.width = 50  # noqa: SLF001
    session_index.record(app.home, "circle-abcdabcd", app.workspace, title="x " * 60)
    app._dispatch_slash("resume", "")  # noqa: SLF001
    from circle.ink.components.dialog_card import visible_width

    rows = app._picker.render_lines(50)  # noqa: SLF001
    assert all(visible_width(r) <= 50 for r in rows)


def test_a_reopened_message_shows_what_the_user_typed():
    sent = HumanMessage(content="row 1\nrow 2\n\nfix it\n\n<file path=\"a.py\">\nx = 1\n</file>",
                        additional_kwargs={"circle_shown": "[Pasted text #1 +1 lines] fix @a.py",
                                           "circle_pastes": {"1": "row 1\nrow 2"}})
    [(text, _snap)] = saved_turns([sent, AIMessage(content="done")])
    assert text == "[Pasted text #1 +1 lines] fix @a.py"


def test_the_bridge_keeps_the_short_form_and_the_pastes(tmp_path):
    from circle.tui.harness_bridge import HarnessBridge

    agent = create_harness(ScriptedModel(responses=[AIMessage(content="ok")]),
                           root_dir=tmp_path, home=tmp_path / "home")
    done: list[str] = []
    bridge = HarnessBridge(agent=agent, thread_id="t", on_update=lambda _u: None,
                           on_interrupt=lambda _i: None, on_done=done.append,
                           on_error=lambda exc: done.append(repr(exc)))
    bridge.start("row 1\nrow 2 fix it", shown="[Pasted text #1 +1 lines] fix it",
                 pastes={1: "row 1\nrow 2"})
    deadline = time.monotonic() + 10
    while bridge.is_running and time.monotonic() < deadline:
        time.sleep(0.02)
    first = agent.get_state({"configurable": {"thread_id": "t"}}).values["messages"][0]
    assert first.content == "row 1\nrow 2 fix it"
    assert first.additional_kwargs == {"circle_shown": "[Pasted text #1 +1 lines] fix it",
                                       "circle_pastes": {"1": "row 1\nrow 2"}}


def test_fork_after_switching_back_counts_that_sessions_turns(tmp_path, monkeypatch):
    app = _app_with_history(tmp_path, monkeypatch)
    first = app._thread_id  # noqa: SLF001
    app._session_title = "history"  # noqa: SLF001 — as after a real first turn
    session_index.record(app.home, first, app.workspace, title="history")
    app._dispatch_slash("new", "")  # noqa: SLF001
    assert app._session_tree.path_to() == []  # noqa: SLF001 — a new session, a new tree
    app._dispatch_slash("resume", first[-8:])  # noqa: SLF001
    second_answer = [n for n in app._session_tree.path_to() if n.text == "second answer"][0]  # noqa: SLF001
    app._dispatch_slash("fork", second_answer.id)  # noqa: SLF001
    assert _model_history(app) == ["first question", "first answer",
                                   "second question", "second answer"]


def test_fork_gives_back_a_message_with_its_pastes(tmp_path, monkeypatch):
    app = _app_with_history(tmp_path, monkeypatch)
    config = {"configurable": {"thread_id": app._thread_id}}  # noqa: SLF001
    app._agent.update_state(config, {"messages": [  # noqa: SLF001
        HumanMessage(content="line a\nline b explain",
                     additional_kwargs={"circle_shown": "[Pasted text #1 +1 lines] explain",
                                        "circle_pastes": {"1": "line a\nline b"}})]})
    app._session_tree.add("user", "[Pasted text #1 +1 lines] explain")  # noqa: SLF001
    node = app._session_tree.active_id  # noqa: SLF001
    app._dispatch_slash("fork", node)  # noqa: SLF001
    assert app._prompt.value == "[Pasted text #1 +1 lines] explain"  # noqa: SLF001
    assert app._prompt.model_text(app._prompt.value) == "line a\nline b explain"  # noqa: SLF001


def _picker_app(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from tests.test_tui_contract import _fake_session

    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 30  # noqa: SLF001
    saved = {"circle-aaaa0001": [HumanMessage(content="first job"), AIMessage(content="done 1")],
             "circle-bbbb0002": [HumanMessage(content="other folder job"),
                                 AIMessage(content="done 2")]}
    app._agent.get_state = lambda config: SimpleNamespace(  # noqa: SLF001
        values={"messages": saved.get(config["configurable"]["thread_id"], [])})
    copied: dict = {}

    def update_state(config, values, as_node=None):
        if values:
            copied.setdefault(config["configurable"]["thread_id"], []).extend(values["messages"])
        return config

    app._agent.update_state = update_state  # noqa: SLF001
    session_index.record(app.home, "circle-aaaa0001", app.workspace, title="first job")
    other = tmp_path / "elsewhere"
    other.mkdir()
    session_index.record(app.home, "circle-bbbb0002", other, title="other folder job")
    return app, copied


def _keys(app, *keys):
    for key in keys:
        if len(key) == 1:
            app._handle_key(KeyPress(key=key, char=key))  # noqa: SLF001
        else:
            app._handle_key(KeyPress(key=key, ctrl=key.startswith("ctrl"),  # noqa: SLF001
                                     char=key[-1] if key.startswith("ctrl") else ""))


def test_the_session_picker_shows_every_folder_with_tab(tmp_path, monkeypatch):
    app, _copied = _picker_app(tmp_path, monkeypatch)
    app._dispatch_slash("resume", "")  # noqa: SLF001
    shown = plain("\n".join(app._picker.render_lines(100)))  # noqa: SLF001
    assert "first job" in shown and "other folder job" not in shown
    _keys(app, "tab")
    shown = plain("\n".join(app._picker.render_lines(100)))  # noqa: SLF001
    assert "Sessions · every folder" in shown and "other folder job" in shown and "elsewhere" in shown


def test_picking_a_session_from_another_folder_forks_it_here(tmp_path, monkeypatch):
    app, copied = _picker_app(tmp_path, monkeypatch)
    app._dispatch_slash("resume", "")  # noqa: SLF001
    _keys(app, "tab", "o", "t", "h", "e", "r", "enter")
    assert app._thread_id not in ("circle-bbbb0002",)  # noqa: SLF001
    assert [m.content for m in copied[app._thread_id]] == ["other folder job", "done 2"]  # noqa: SLF001
    assert session_index.latest(app.home, app.workspace).thread_id == app._thread_id  # noqa: SLF001


def test_rename_and_delete_from_the_picker(tmp_path, monkeypatch):
    app, _copied = _picker_app(tmp_path, monkeypatch)
    app._dispatch_slash("resume", "")  # noqa: SLF001
    _keys(app, "f", "i", "r", "s", "t", "ctrl+r", "ctrl+u")
    app._picker._asking = ("New name", "", app._picker._asking[2])  # noqa: SLF001 — clear the field
    _keys(app, "r", "e", "n", "a", "m", "e", "d", "enter")
    assert session_index.find(app.home, "aaaa0001").title == "renamed"
    _keys(app, "escape")  # clear the search
    _keys(app, "r", "e", "n", "ctrl+d")
    assert "Delete" in plain("\n".join(app._picker.render_lines(100)))  # noqa: SLF001
    _keys(app, "enter")
    assert session_index.find(app.home, "aaaa0001") is None
