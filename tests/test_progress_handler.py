"""The progress handler through the real harness: model rounds, tool status, subagent
tags, internal model calls kept off screen, usage, todo updates — and a whole session
turn rendered from snapshots."""

from __future__ import annotations

import re
import textwrap
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, LLMResult
from langgraph.types import Command

from circle.events import EventBus
from circle.extensions import ExtensionHost
from circle.harness import BUILTIN_TOOL_NAMES, create_harness
from circle.testing import ScriptedModel
from circle.tui.progress_handler import ProgressHandler, extract_message_usage

ANSI = re.compile(r"\x1b\[[0-9;]*m")
CRASHY = '''
def register(api):
    obj = {"type": "object", "properties": {"x": {"type": "integer"}}}

    def crash(args):
        raise RuntimeError("boom")

    api.register_tool("crashy", "Raises.", obj, crash, read_only=True)
'''


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id,
                                              "type": "tool_call"}])


def _run_events(tmp_path: Path, responses: list) -> list[dict]:
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir(parents=True, exist_ok=True)
    path = home / "extensions" / "t" / "extension.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(CRASHY), encoding="utf-8")
    host = ExtensionHost(home=home, workspace=ws, trusted=True,
                         reserved_tools=set(BUILTIN_TOOL_NAMES)).load()
    agent = create_harness(ScriptedModel(responses=responses), root_dir=ws, home=home,
                           extensions=host)
    bus = EventBus(run_id="r1")
    seen: list[dict] = []
    bus.subscribe(seen.append)
    agent.invoke({"messages": [{"role": "user", "content": "go"}]},
                 config={"configurable": {"thread_id": "t"}, "callbacks": [ProgressHandler(bus)]})
    return seen


def test_rounds_tools_and_subagents_become_events(tmp_path):
    events = _run_events(tmp_path, [
        _call("ls", {"path": "/"}, "c1"),
        _call("crashy", {"x": 1}, "c2"),
        _call("task", {"description": "look", "subagent_type": "general-purpose"}, "c3"),
        _call("glob", {"pattern": "*"}, "s1"),
        AIMessage(content="sub done"),
        AIMessage(content="all done"),
    ])
    results = [(e["payload"]["name"], e["payload"].get("status"), e["tags"].get("parent_subagent"))
               for e in events if e["kind"] == "tool_result"]
    assert results == [("ls", "success", None), ("crashy", "error", None),
                       ("glob", "success", "general-purpose"), ("task", "success", None)]
    finals = [e["payload"].get("content") for e in events
              if e["kind"] == "llm_end" and e["payload"].get("name") == "final_thought"]
    assert finals == ["all done"], "subagent answers are not main-agent answers"
    sub_tokens = [e for e in events if e["kind"] == "llm_token" and e["tags"].get("parent_subagent")]
    assert sub_tokens and all(e["tags"]["parent_subagent"] == "general-purpose" for e in sub_tokens)


def test_internal_model_calls_stay_off_screen():
    bus = EventBus()
    seen: list[dict] = []
    bus.subscribe(seen.append)
    handler = ProgressHandler(bus)
    run_id = uuid4()
    meta = {"lc_source": "summarization", "lc_internal_call": "x"}
    handler.on_chat_model_start({"name": "M"}, [[]], run_id=run_id, metadata=meta)
    handler.on_llm_new_token("summary text", run_id=run_id)
    handler.on_llm_end(LLMResult(generations=[[ChatGeneration(message=AIMessage(content="sum"))]]),
                       run_id=run_id)
    assert seen == []


def test_todo_updates_and_recoverable_results():
    bus = EventBus()
    seen: list[dict] = []
    bus.subscribe(seen.append)
    handler = ProgressHandler(bus)
    todo_run, bad_run = uuid4(), uuid4()
    handler.on_tool_start({"name": "write_todos"}, "{}", run_id=todo_run)
    handler.on_tool_end(Command(update={"todos": [{"content": "a", "status": "pending"}],
                                        "messages": [ToolMessage(content="Updated todo list",
                                                                 tool_call_id="x")]}),
                        run_id=todo_run)
    handler.on_tool_start({"name": "read_file"}, "{}", run_id=bad_run)
    msg = ToolMessage(content="invalid arguments", tool_call_id="y", status="error",
                      additional_kwargs={"recoverable": True})
    handler.on_tool_end(msg, run_id=bad_run)
    kinds = [(e["kind"], e["payload"].get("name")) for e in seen]
    assert ("todo_list", None) in kinds
    last = seen[-1]["payload"]
    assert last["status"] == "error" and last["recoverable"] is True


def test_anthropic_usage_counts_cache_reads_as_input():
    message = SimpleNamespace(usage_metadata=None, response_metadata={"usage": {
        "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 90,
        "cache_creation_input_tokens": 0}})
    usage = extract_message_usage(message)
    assert usage["input_tokens"] == 100 and usage["prompt_cache_hit_tokens"] == 90
    assert usage["total_tokens"] == 105


# ── a whole session turn ───────────────────────────────────────────────────


def _session(tmp_path: Path, monkeypatch, responses: list):
    from circle.oauth import start_oauth_login
    from circle.tui.controllers import InitController, TrustController
    from circle.tui.session_app import CircleSessionApp

    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    (ws / "notes.txt").write_text("an error was logged here\n", encoding="utf-8")
    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    TrustController(init.settings, ws, home=home).confirm()
    return CircleSessionApp(init.settings, ws, home=home,
                            model_override=ScriptedModel(responses=responses))


def _wait_idle(app, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    time.sleep(0.2)
    while (app._bridge.is_running or app._is_loading) and time.time() < deadline:  # noqa: SLF001
        time.sleep(0.05)


def test_session_turn_renders_rows_results_and_answer_from_snapshots(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch, [
        _call("read_file", {"file_path": "/notes.txt"}, "c1"),
        _call("write_file", {"file_path": "/out.txt", "content": "x"}, "c2"),
        AIMessage(content="**Finished** reading."),
    ])
    decisions: list = []
    original = app._bridge.resume  # noqa: SLF001

    def reject(value):
        decisions.append(value)
        original({"decisions": [{"type": "reject", "message": "The user rejected this tool call."}]})

    app._on_submit("read my notes")  # noqa: SLF001
    _wait_idle(app)
    assert app._exec_approval is not None  # noqa: SLF001 — write_file waits for approval
    pending = ANSI.sub("", "\n".join(app._transcript.snapshot()))  # noqa: SLF001
    assert "Write(/out.txt) 等待审批" in pending
    app._bridge.resume = reject  # noqa: SLF001
    app._finish_exec_approval({"decision": "reject"})  # noqa: SLF001
    _wait_idle(app)
    raw = "\n".join(app._transcript.snapshot())  # noqa: SLF001
    text = ANSI.sub("", raw)
    assert "Read(/notes.txt)" in text
    assert "Write(/out.txt)" in text and "等待审批" not in text
    assert "The user rejected this tool call." in text
    assert "Finished reading." in text
    read_row = next(line for line in raw.splitlines() if "Read(/notes.txt)" in line)
    write_row = next(line for line in raw.splitlines() if "Write(/out.txt)" in line)
    from circle.ink.theme import status_light

    assert status_light("ok") in read_row, "a file mentioning 'error' is not a failure"
    assert status_light("error") in write_row, "a rejected call is a failure"
    assert app._last_assistant_plain == "**Finished** reading."  # noqa: SLF001


def test_calls_refused_by_middleware_still_get_a_muted_row(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch, [
        _call("read_file", {"limit": "not-a-number"}, "c1"),
        _call("no_such_tool", {}, "c2"),
        AIMessage(content="ok"),
    ])
    app._on_submit("go")  # noqa: SLF001
    _wait_idle(app)
    raw = "\n".join(app._transcript.snapshot())  # noqa: SLF001
    text = ANSI.sub("", raw)
    assert "Read(" in text and "was not run: invalid arguments" in text
    assert "no_such_tool(" in text and "not a valid tool" in text
    from circle.ink.theme import palette

    rows = [line for line in raw.splitlines() if "Read(" in line or "no_such_tool(" in line]
    assert len(rows) == 2 and all(palette().muted_strike in row for row in rows)
