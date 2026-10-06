"""``circle -p`` and line mode: nobody can answer a card, so calls that ask are decided by
a fixed rule, the answer goes to stdout, and an open stdin never blocks a given prompt."""

from __future__ import annotations

import os
import sys

from langchain_core.messages import AIMessage, ToolMessage

from circle import cli
from circle.harness import create_harness
from circle.headless import ALWAYS_ASKED, NOT_ASKED, HeadlessRun
from circle.init_flow import complete_api_key_init
from circle.probe import ProbeResult
from circle.testing import ScriptedModel
from circle.trust import accept_trust


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id}])


def _run(tmp_path, responses, **kwargs) -> tuple[HeadlessRun, str]:
    ws = tmp_path / "ws"
    ws.mkdir(exist_ok=True)
    agent = create_harness(ScriptedModel(responses=responses), root_dir=ws, home=tmp_path / "home")
    run = HeadlessRun(agent, **kwargs)
    return run, run.turn("go")


def _tool_results(run: HeadlessRun) -> list[str]:
    state = run.agent.get_state(run.config)
    return [str(m.content) for m in state.values["messages"] if isinstance(m, ToolMessage)]


def test_without_yolo_calls_that_ask_are_not_run_and_the_model_is_told(tmp_path):
    run, answer = _run(tmp_path, [_call("execute", {"command": "touch made"}, "e1"),
                                  AIMessage(content="I would run touch made.")])
    assert answer == "I would run touch made."
    assert not (tmp_path / "ws" / "made").exists()
    assert run.not_run == 1 and NOT_ASKED in _tool_results(run)[0]
    assert "use --yolo" in run.summary()


def test_yolo_runs_them_but_not_what_circle_always_asks_about(tmp_path):
    run, answer = _run(tmp_path, [
        _call("write_file", {"file_path": "/notes.txt", "content": "hi\n"}, "w1"),
        _call("delete", {"file_path": "/notes.txt"}, "d1"),
        AIMessage(content="done")], yolo=True)
    assert answer == "done"
    assert (tmp_path / "ws" / "notes.txt").read_text() == "hi\n", "written, and not deleted"
    assert run.not_run == 1 and ALWAYS_ASKED in _tool_results(run)[-1]


def test_progress_lists_each_call_once(tmp_path, capsys):
    run, _answer = _run(tmp_path, [_call("execute", {"command": "ls"}, "e1"),
                                   AIMessage(content="ok")], progress=sys.stderr)
    err = capsys.readouterr().err.splitlines()
    assert err == ["● Bash(ls)", "  ⎿ Bash(ls) not run · needs --yolo"]


def test_a_given_prompt_does_not_wait_forever_for_an_open_stdin(monkeypatch, capsys):
    read_end, write_end = os.pipe()
    try:
        with os.fdopen(read_end) as stdin:
            monkeypatch.setattr(sys, "stdin", stdin)
            assert cli._read_piped(0.1) == ""
            assert "nothing arrived on stdin" in capsys.readouterr().err
            os.write(write_end, b"diff --git a b\n")
            os.close(write_end)
            write_end = -1
            assert cli._read_piped(0.1) == "diff --git a b\n"
    finally:
        if write_end != -1:
            os.close(write_end)


def test_print_mode_writes_only_the_answer_to_stdout(tmp_path, monkeypatch, capsys):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    settings = complete_api_key_init(base_url="https://api.example.com", api_key="sk", model="m1",
                                     home=home, probe=lambda *_a, **_k: ProbeResult("openai", ["m1"]))
    accept_trust(settings, ws, home=home)
    monkeypatch.setattr("circle.main_session.build_chat_model",
                        lambda *_a, **_k: ScriptedModel(responses=[AIMessage(content="42")]))
    monkeypatch.setattr(cli, "_read_piped", lambda _wait: "")
    assert cli.main(["-p", "what is six times seven?", str(ws)]) == 0
    out = capsys.readouterr()
    assert out.out == "42\n" and out.err == ""
    assert cli.main(["-p", "", str(ws)]) == 2


def test_line_mode_does_not_send_commands_to_the_model(tmp_path, monkeypatch, capsys):
    import io

    from circle.main_session import run_main

    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    settings = complete_api_key_init(base_url="https://api.example.com", api_key="sk", model="m1",
                                     home=home, probe=lambda *_a, **_k: ProbeResult("openai", ["m1"]))
    model = ScriptedModel(responses=[AIMessage(content="first"), AIMessage(content="second")])
    monkeypatch.setattr("circle.main_session.build_chat_model", lambda *_a, **_k: model)
    monkeypatch.setattr(sys, "stdin", io.StringIO(
        "/compact\n/modles x\n /compact is a word here\n/usr/bin/env is missing\n/exit\nnever\n"))
    assert run_main(settings, ws, home=home) == 0
    out = capsys.readouterr()
    assert out.out == "first\nsecond\n"
    assert "/compact works in the full-screen interface only" in out.err
    assert "/modles is not a command" in out.err
    assert model.i == 2
