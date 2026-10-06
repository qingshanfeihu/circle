"""pi's command-line options: messages and @files after the folder, --system-prompt and
SYSTEM.md, --no-context-files, --tools, --name, --no-session, --session-id, --fork."""

from __future__ import annotations

from typing import ClassVar

from langchain_core.messages import AIMessage, SystemMessage

from circle import cli, session_index
from circle.harness import create_harness
from circle.headless import HeadlessRun
from circle.init_flow import complete_api_key_init
from circle.probe import ProbeResult
from circle.run_options import RunOptions, tool_names
from circle.system_prompt import build_system_prompt, prompt_overrides
from circle.testing import ScriptedModel
from circle.trust import accept_trust


class Recording(ScriptedModel):
    """Keeps what each model call was given: the messages and the tool names."""

    seen: ClassVar[list[list]] = []
    tools: ClassVar[list[list[str]]] = []

    def bind_tools(self, tools, **kwargs):
        Recording.tools.append(sorted(getattr(t, "name", None) or t.get("name", "") for t in tools))
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        Recording.seen.append(list(messages))
        return super()._generate(messages, stop, run_manager, **kwargs)


def _recording(answers=("done",)) -> Recording:
    Recording.seen, Recording.tools = [], []
    return Recording(responses=[AIMessage(content=a) for a in answers])


def _system(messages) -> str:
    content = next(m.content for m in messages if isinstance(m, SystemMessage))
    if isinstance(content, str):
        return content
    return "\n\n".join(block.get("text", "") for block in content if isinstance(block, dict))


# ── the words on the command line ──────────────────────────────────────────


def test_words_are_a_folder_then_messages_and_files(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    args = cli._parse([str(ws), "explain this", "@notes.txt", "then this"])  # noqa: SLF001
    assert (args.workspace, args.messages, args.files) == (
        str(ws), ["explain this", "then this"], ["notes.txt"])
    args = cli._parse(["explain this project"])  # noqa: SLF001
    assert (args.workspace, args.messages) == (".", ["explain this project"])
    args = cli._parse(["explain this", str(ws)])  # noqa: SLF001
    assert (args.workspace, args.messages) == (str(ws), ["explain this"])
    args = cli._parse(["myproj"])  # noqa: SLF001
    assert args.workspace == "myproj", "one word is a folder name, so a typo is not sent"
    args = cli._parse(["--", "-x is a message"])  # noqa: SLF001
    assert args.messages == ["-x is a message"]
    args = cli._parse(["-nc", "-t", "read,grep", "--name", "review", "-xt", "bash", str(ws)])  # noqa: SLF001
    options = cli._run_options(args)  # noqa: SLF001
    assert options.no_context_files and options.tools == ["read_file", "grep"]
    assert options.exclude_tools == ["execute"] and options.session_name == "review"


def test_options_that_cannot_go_together_are_refused(tmp_path, capsys):
    for argv, says in (
        (["--fork", "abc", "-c"], "--fork"),
        (["--session-id", "abc", "-c"], "--session-id"),
        (["--no-session", "-c"], "--no-session"),
        (["--session-id", "bad!id"], "letters, digits"),
        (["-r", "do this now"], "-r opens a list"),
        (["--line", "do this now"], "--line reads"),
    ):
        assert cli.main(argv) == 2
        assert says in capsys.readouterr().err


def test_initial_messages_carry_the_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "notes.txt").write_text("the notes\n", encoding="utf-8")
    args = cli._parse(["explain these", "@notes.txt", "and then this"])  # noqa: SLF001
    args.attached = cli._file_blocks(args.files)  # noqa: SLF001
    first, second = cli._initial_messages(args)  # noqa: SLF001
    assert first[1] == "explain these @notes.txt"
    assert first[0].startswith("explain these\n\n<file path=\"notes.txt\">\nthe notes\n</file>")
    assert second == ("and then this", "and then this")
    assert cli._file_blocks(["missing.txt"]) == 2  # noqa: SLF001


# ── print mode end to end ──────────────────────────────────────────────────


def _ready(tmp_path, monkeypatch, model):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    settings = complete_api_key_init(base_url="https://api.example.com", api_key="sk", model="m1",
                                     home=home, probe=lambda *_a, **_k: ProbeResult("openai", ["m1"]))
    accept_trust(settings, ws, home=home)
    monkeypatch.setattr("circle.main_session.build_chat_model", lambda *_a, **_k: model)
    monkeypatch.setattr(cli, "_read_piped", lambda _wait: "")
    return home, ws


def test_print_mode_sends_each_message_and_prints_the_last_answer(tmp_path, monkeypatch, capsys):
    model = _recording(("first answer", "second answer"))
    home, ws = _ready(tmp_path, monkeypatch, model)
    monkeypatch.chdir(tmp_path)
    (tmp_path / "notes.txt").write_text("pelican", encoding="utf-8")
    assert cli.main(["-p", "read the notes", str(ws), "@notes.txt", "now summarize",
                     "--name", "notes run"]) == 0
    assert capsys.readouterr().out == "second answer\n"
    assert "pelican" in str(model.seen[0][-1].content)
    assert str(model.seen[1][-1].content) == "now summarize"
    assert session_index.latest(home, ws).title == "notes run"


def test_no_session_leaves_nothing_in_the_list(tmp_path, monkeypatch, capsys):
    home, ws = _ready(tmp_path, monkeypatch, _recording())
    assert cli.main(["-p", "hello", str(ws), "--no-session"]) == 0
    assert session_index.latest(home, ws) is None


def test_session_id_starts_a_conversation_with_that_id_and_reopens_it(tmp_path, monkeypatch,
                                                                     capsys):
    model = _recording(("one", "two"))
    home, ws = _ready(tmp_path, monkeypatch, model)
    assert cli.main(["-p", "remember 7", str(ws), "--session-id", "job-42"]) == 0
    assert session_index.find(home, "job-42").thread_id == "job-42"
    assert cli.main(["-p", "what number?", str(ws), "--session-id", "job-42"]) == 0
    assert "remember 7" in [str(m.content) for m in model.seen[1]]


def test_fork_copies_a_saved_conversation_into_a_new_one(tmp_path, monkeypatch, capsys):
    model = _recording(("one", "two"))
    home, ws = _ready(tmp_path, monkeypatch, model)
    assert cli.main(["-p", "remember 7", str(ws), "--session-id", "origin"]) == 0
    assert cli.main(["-p", "what number?", str(ws), "--fork", "origin"]) == 0
    assert "remember 7" in [str(m.content) for m in model.seen[1]]
    forked = session_index.latest(home, ws)
    assert forked.thread_id != "origin"


# ── what the model is given ────────────────────────────────────────────────


def test_system_md_replaces_circles_instructions_and_the_command_line_wins(tmp_path):
    ws, home = tmp_path / "ws", tmp_path / "home"
    (ws / ".circle").mkdir(parents=True)
    home.mkdir()
    (home / "SYSTEM.md").write_text("FROM HOME", encoding="utf-8")
    assert prompt_overrides(ws, home) == ("FROM HOME", [])
    (ws / ".circle" / "SYSTEM.md").write_text("FROM PROJECT", encoding="utf-8")
    (home / "APPEND_SYSTEM.md").write_text("ALSO THIS", encoding="utf-8")
    assert prompt_overrides(ws, home) == ("FROM PROJECT", ["ALSO THIS"])
    assert prompt_overrides(ws, home, system="FLAG", append=["MORE"]) == ("FLAG", ["MORE"])
    (ws / "AGENTS.md").write_text("PROJECT RULES", encoding="utf-8")
    prompt = build_system_prompt(cwd=ws, base="FLAG", append="MORE")
    assert prompt.startswith("FLAG") and "PROJECT RULES" in prompt and prompt.endswith("MORE")
    assert "Circle" not in prompt.split("PROJECT RULES")[0], "Circle's own text is gone"


def test_the_run_options_reach_the_model(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "AGENTS.md").write_text("PROJECT RULES", encoding="utf-8")
    model = _recording()
    agent = create_harness(model, root_dir=ws, home=tmp_path / "home", run_options=RunOptions(
        system_prompt="YOU ARE TERSE", append_system_prompt=["ANSWER IN ONE WORD"],
        no_context_files=True, tools=tool_names("read,grep")))
    HeadlessRun(agent).turn("hi")
    system = _system(model.seen[0])
    assert system.startswith("YOU ARE TERSE") and "ANSWER IN ONE WORD" in system
    assert "PROJECT RULES" not in system
    assert model.tools[0] == ["compact_conversation", "grep", "read_file"]  # /compact needs it


def test_a_tool_that_is_turned_off_is_not_run(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    model = Recording(responses=[
        AIMessage(content="", tool_calls=[{"name": "ls", "args": {"path": "/"}, "id": "l1"}]),
        AIMessage(content="ok")])
    agent = create_harness(model, root_dir=ws, home=tmp_path / "home",
                           run_options=RunOptions(tools=[]))
    run = HeadlessRun(agent)
    assert run.turn("list") == "ok"
    results = [m for m in agent.get_state(run.config).values["messages"] if m.type == "tool"]
    assert results and "turned off for this run" in str(results[0].content)


# ── the full-screen session ────────────────────────────────────────────────


def test_the_session_sends_the_command_line_messages_in_turn(tmp_path, monkeypatch):
    from tests.test_conversation_tree import _app, _history, _wait_idle
    from tests.test_tui_contract import plain

    app = _app(tmp_path, monkeypatch)
    app._initial_messages = [("explain\n\n<file path=\"a.txt\">\nA\n</file>", "explain @a.txt"),  # noqa: SLF001
                             ("and more", "and more")]
    app._send_initial_messages()  # noqa: SLF001
    _wait_idle(app)
    assert _history(app) == ["explain\n\n<file path=\"a.txt\">\nA\n</file>", "a1", "and more", "a2"]
    shown = [plain(r) for r in app._transcript.snapshot()]  # noqa: SLF001
    assert " › explain @a.txt" in shown and not any("<file" in r for r in shown)


def test_no_session_and_models_scope_in_the_session(tmp_path, monkeypatch):
    from tests.test_conversation_tree import _app

    app = _app(tmp_path, monkeypatch)
    app._run_options = RunOptions(no_session=True, models=["m-*"])  # noqa: SLF001
    app._remember_session()  # noqa: SLF001
    assert session_index.latest(app.home, app.workspace) is None
    app._model_list = ["m-1", "x-2", "m-3"]  # noqa: SLF001
    app.settings.auth.model = "m-1"
    assert app._model_scope() == ["m-1", "m-3"]  # noqa: SLF001


def test_list_models_and_thinking(tmp_path, monkeypatch, capsys):
    home, ws = _ready(tmp_path, monkeypatch, _recording())
    monkeypatch.setattr("circle.probe.probe_endpoint", lambda *_a, **_k: ProbeResult(
        "openai", ["step-3.7-flash", "step-5-preview", "other-1"]))
    assert cli.main(["--list-models", "step"]) == 0
    assert capsys.readouterr().out.split() == ["step-3.7-flash", "step-5-preview"]
    assert cli.main(["--list-models", "nothing"]) == 1
    monkeypatch.delenv("CIRCLE_REASONING_EFFORT", raising=False)
    assert cli.main(["-p", "hi", str(ws), "--thinking", "low"]) == 0
    import os

    assert os.environ.pop("CIRCLE_REASONING_EFFORT") == "low"


def test_a_file_is_looked_for_in_the_folder_circle_works_in_too(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "inside.txt").write_text("in the workspace", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    assert "in the workspace" in cli._file_blocks(["inside.txt"], ws)  # noqa: SLF001


def test_session_lists_what_the_conversation_holds(tmp_path, monkeypatch):
    from tests.test_conversation_tree import _app, _say
    from tests.test_tui_contract import plain

    app = _app(tmp_path, monkeypatch)
    _say(app, "q1")
    _say(app, "q2")
    app._dispatch_slash("name", "check")  # noqa: SLF001
    app._dispatch_slash("session", "")  # noqa: SLF001
    shown = "\n".join(plain(r) for r in app._transcript.snapshot())  # noqa: SLF001
    assert f"session  {app._thread_id} · check" in shown  # noqa: SLF001
    assert "messages 4 · 2 yours · 2 from the model · 0 tool calls · 0 results" in shown
    assert "checkpoints.sqlite" in shown


def test_json_mode_writes_every_step_as_a_line(tmp_path, monkeypatch, capsys):
    import json

    model = Recording(responses=[
        AIMessage(content="", id="m1", tool_calls=[{"name": "ls", "args": {"path": "/"}, "id": "l1"}]),
        AIMessage(content="two files", id="m2")])
    Recording.seen, Recording.tools = [], []
    home, ws = _ready(tmp_path, monkeypatch, model)
    assert cli.main(["--mode", "json", "what is here?", str(ws)]) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [e["type"] for e in events] == [
        "session", "turn_start", "assistant", "tool_result", "assistant", "turn_end"]
    assert events[2]["tool_calls"][0]["name"] == "ls"
    assert events[3]["id"] == "l1" and events[3]["status"] == "success"
    assert events[-1]["answer"] == "two files"
    assert cli.main(["--mode", "json", "--line"]) == 2


def test_p_does_not_swallow_a_folder_or_a_file(tmp_path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.chdir(tmp_path)
    args = cli._parse(["-p", "@notes.md", "summarize"])  # noqa: SLF001
    assert (args.prompt, args.files, args.workspace) == ("summarize", ["notes.md"], ".")
    args = cli._parse(["-p", str(ws), "explain this"])  # noqa: SLF001
    assert (args.prompt, args.workspace, args.messages) == ("", str(ws), ["explain this"])
    args = cli._parse(["--mode", "json", "summarize", str(ws)])  # noqa: SLF001
    assert (args.prompt, args.workspace) == ("summarize", str(ws))


def test_print_mode_goes_on_from_the_point_tree_went_back_to(tmp_path, monkeypatch, capsys):
    from circle.checkpoint_store import make_checkpointer
    from circle.tui.conversation_tree import build_tree

    model = _recording(("a1", "a2", "a3"))
    home, ws = _ready(tmp_path, monkeypatch, model)
    assert cli.main(["-p", "q1", str(ws), "--session-id", "job"]) == 0
    assert cli.main(["-p", "q2", str(ws), "--session-id", "job"]) == 0
    reader = create_harness(ScriptedModel(), root_dir=ws, home=home,
                            checkpointer=make_checkpointer(home))
    tree = build_tree(reader, "job")
    a1 = next(e for e in tree.entries.values() if e.text == "a1")
    session_index.set_leaf(home, "job", a1.resume_from)
    assert cli.main(["-p", "q3", str(ws), "-c"]) == 0
    assert [str(m.content) for m in model.seen[2] if m.type != "system"] == ["q1", "a1", "q3"]
    assert not session_index.find(home, "job").leaf, "back at the latest after the turn"


def test_fork_into_an_existing_id_is_refused_and_a_new_id_gets_a_title(tmp_path, monkeypatch,
                                                                       capsys):
    home, ws = _ready(tmp_path, monkeypatch, _recording(("one", "two")))
    assert cli.main(["-p", "first question", str(ws), "--session-id", "a"]) == 0
    assert session_index.find(home, "a").title == "first question"
    assert cli.main(["-p", "x", str(ws), "--fork", "a", "--session-id", "a"]) == 2
    assert "exists already" in capsys.readouterr().err


def test_compaction_stays_available_with_no_tools():
    from circle.middleware.tool_selection import ToolSelectionMiddleware

    none = ToolSelectionMiddleware(allowed=[], excluded=["compact_conversation"])
    assert none.permits("compact_conversation") and not none.permits("ls")
