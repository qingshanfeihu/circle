"""Generic middleware (C5): the tool error boundary, tool-call repair, the loop guard and
old tool-output pruning — each on its own and through the real harness."""

from __future__ import annotations

import json
import textwrap
from pathlib import Path
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.errors import GraphInterrupt
from pydantic import Field

from circle.extensions import ExtensionHost
from circle.harness import BUILTIN_TOOL_NAMES, create_harness
from circle.middleware import (
    LoopGuardMiddleware,
    ToolCallCompatibilityMiddleware,
    ToolErrorBoundaryMiddleware,
)
from circle.middleware.loop_guard import analyze, build_reminder
from circle.middleware.redact import redact
from circle.middleware.tool_call_compat import (
    parse_tool_input,
    repair_tool_call,
    repair_unicode_escapes,
    resolve_name,
)
from circle.middleware.tool_error_boundary import TOOL_EXECUTION_FAULT_PREFIX
from circle.middleware.tool_result_prune import prune_messages
from circle.testing import ScriptedModel

CRASHY = '''
def register(api):
    obj = {"type": "object", "properties": {"x": {"type": "integer"}}}

    def crash(args):
        raise RuntimeError("backend at https://svc:hunter2@db.local failed; token=abcd1234efgh")

    def echo(args):
        return {"echo": args}

    api.register_tool("crashy", "Raises an unexpected exception.", obj, crash, read_only=True)
    api.register_tool("echo_ro", "Echo the arguments back.", obj, echo, read_only=True)
'''


class RecordingModel(ScriptedModel):
    seen: list[list[Any]] = Field(default_factory=list)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def _call(name: str, args: Any, call_id: str = "c1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id,
                                              "type": "tool_call"}])


def _agent(tmp_path: Path, responses: list, *, ext: str | None = CRASHY, model_cls=ScriptedModel):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir(parents=True, exist_ok=True)
    host = None
    if ext:
        path = home / "extensions" / "t" / "extension.py"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(ext), encoding="utf-8")
        host = ExtensionHost(home=home, workspace=ws, trusted=True,
                             reserved_tools=set(BUILTIN_TOOL_NAMES)).load()
    model = model_cls(responses=responses)
    return create_harness(model, root_dir=ws, home=home, extensions=host), model, ws


def _run(agent, text: str = "go"):
    cfg = {"configurable": {"thread_id": "t1"}}
    result = agent.invoke({"messages": [{"role": "user", "content": text}]}, config=cfg)
    return result, agent.get_state(cfg)


def _tool_messages(result) -> list[ToolMessage]:
    return [m for m in result["messages"] if isinstance(m, ToolMessage)]


# ── error boundary ──────────────────────────────────────────────────────────


def test_a_tool_that_raises_becomes_an_error_result_and_the_turn_continues(tmp_path):
    agent, _, _ = _agent(tmp_path, [_call("crashy", {"x": 1}), AIMessage(content="recovered")])
    result, _ = _run(agent)
    msg = _tool_messages(result)[0]
    assert msg.status == "error" and msg.name == "crashy"
    assert msg.content.startswith(TOOL_EXECUTION_FAULT_PREFIX + "RuntimeError: ")
    assert "hunter2" not in msg.content and "abcd1234efgh" not in msg.content
    assert result["messages"][-1].content == "recovered"


def test_without_the_boundary_the_same_tool_ends_the_run(tmp_path, monkeypatch):
    # 反向对照：去掉边界后同一脚本确实会让整轮崩掉
    monkeypatch.setattr(ToolErrorBoundaryMiddleware, "wrap_tool_call",
                        lambda self, request, handler: handler(request))
    agent, _, _ = _agent(tmp_path, [_call("crashy", {"x": 1}), AIMessage(content="recovered")])
    with pytest.raises(RuntimeError, match="failed"):
        _run(agent)


def test_boundary_lets_graph_control_flow_through():
    boundary = ToolErrorBoundaryMiddleware()
    request = type("R", (), {"tool_call": {"name": "t", "id": "1"}, "tool": None})()

    def interrupting(_):
        raise GraphInterrupt(())

    with pytest.raises(GraphInterrupt):
        boundary.wrap_tool_call(request, interrupting)


def test_redact_covers_the_common_secret_shapes():
    text = redact("https://u:pw@h/x Authorization: Bearer abcdefghijk password=s3cret "
                  "key sk-abcdefghijklmnopqrstu")
    for secret in ("pw@", "abcdefghijk", "s3cret", "sk-abcdefghijklmnopqrstu"):
        assert secret not in text


# ── tool-call repair ────────────────────────────────────────────────────────


def _read_tool() -> StructuredTool:
    def read(file_path: str, limit: int = 100, tags: list[str] | None = None) -> str:
        return f"{file_path}:{limit}:{tags}"

    return StructuredTool.from_function(read, name="read_file", description="Read.")


def test_repairs_names_json_strings_keys_and_unicode_escapes():
    tools = {"read_file": _read_tool()}
    assert resolve_name("Read_File", tools) == "read_file"
    assert resolve_name("readfile", tools) == "read_file"
    assert resolve_name("write_file", tools) is None
    assert repair_unicode_escapes('"caf\\u 00e9"') == '"caf\\u00e9"'
    assert parse_tool_input('{"a": "caf\\u00 e9"}') == {"a": "café"}

    fixed = repair_tool_call("Read_File", '{"filePath": "a.txt", "tags": "[\\"x\\"]"}', tools)
    assert fixed is not None and fixed.tool_name == "read_file"
    assert fixed.args == {"file_path": "a.txt", "tags": ["x"]}
    assert {"tool_name", "json_string_args", "argument_keys_or_json_fields"} <= set(fixed.codes)

    one = repair_tool_call("read_file", {"file_path": ["a.txt"]}, tools)
    assert one is not None and one.args == {"file_path": "a.txt"}
    assert repair_tool_call("read_file", {"file_path": "a.txt"}, tools) is None


def test_ambiguous_names_are_not_guessed():
    tools = {"read_file": _read_tool(), "Read_File": _read_tool()}
    assert resolve_name("READ_FILE", tools) is None


def test_harness_runs_a_repaired_call(tmp_path):
    agent, _, _ = _agent(tmp_path, [_call("Echo_RO", {"X": 3}), AIMessage(content="ok")])
    result, _ = _run(agent)
    msg = _tool_messages(result)[0]
    assert msg.status == "success" and json.loads(msg.content) == {"echo": {"x": 3}}


def test_name_repair_never_lands_on_a_tool_that_needs_approval(tmp_path):
    agent, _, ws = _agent(tmp_path, [_call("Write_File", {"file_path": "/x.txt", "content": "hi"}),
                                     AIMessage(content="ok")])
    result, state = _run(agent)
    assert not state.interrupts
    msg = _tool_messages(result)[0]
    assert msg.status == "error" and "Did you mean 'write_file'" in msg.content
    assert not (ws / "x.txt").exists()


def test_invalid_arguments_name_the_field_not_the_value(tmp_path):
    agent, _, _ = _agent(tmp_path, [_call("read_file", {"limit": "secret-value"}),
                                    AIMessage(content="ok")])
    result, _ = _run(agent)
    msg = _tool_messages(result)[0]
    assert msg.status == "error" and "was not run: invalid arguments" in msg.content
    assert "file_path" in msg.content and "secret-value" not in msg.content


def test_unknown_tools_still_get_the_tool_node_answer(tmp_path):
    agent, _, _ = _agent(tmp_path, [_call("no_such_tool", {}), AIMessage(content="ok")])
    result, _ = _run(agent)
    msg = _tool_messages(result)[0]
    assert msg.status == "error" and "no_such_tool" in msg.content


def test_compat_is_bound_to_the_final_tool_table(tmp_path, monkeypatch):
    import circle.harness as harness

    captured: dict[str, Any] = {}
    real = harness.create_deep_agent

    def spy(**kwargs):
        captured.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(harness, "create_deep_agent", spy)
    _agent(tmp_path, [AIMessage(content="ok")])
    stack = captured["middleware"]
    assert isinstance(stack[0], ToolErrorBoundaryMiddleware)
    compat = next(m for m in stack if isinstance(m, ToolCallCompatibilityMiddleware))
    assert {"read_file", "execute", "crashy", "echo_ro"} <= set(compat.tools_by_name)
    assert {"execute", "write_file", "edit_file"} <= compat.gated


# ── loop guard ──────────────────────────────────────────────────────────────


def _turn(*calls_and_results) -> list:
    msgs: list = [HumanMessage(content="find it")]
    for i, (name, args, result) in enumerate(calls_and_results):
        msgs.append(_call(name, args, f"c{i}"))
        msgs.append(ToolMessage(content=result, name=name, tool_call_id=f"c{i}"))
    return msgs


def _reminder(msgs, **kw) -> str | None:
    thresholds = {"dup_threshold": 3, "empty_threshold": 4, "soft_budget": 25}
    thresholds.update(kw)
    return build_reminder(analyze(msgs, window=8), **thresholds)


def test_same_call_three_times_triggers_a_reminder():
    msgs = _turn(*[("grep", {"pattern": "foo"}, "a.py:1: foo")] * 3)
    text = _reminder(msgs)
    assert text and 'data-source="loop-guard"' in text and "same arguments" in text
    assert "grep(pattern=foo)" in text


def test_empty_results_trigger_a_reminder():
    msgs = _turn(*[("grep", {"pattern": f"p{i}"}, "No matches found") for i in range(4)])
    assert "came back empty" in (_reminder(msgs) or "")


def test_rereading_the_same_file_out_of_order_triggers_but_paging_forward_does_not():
    back_and_forth = _turn(*[("read_file", {"file_path": "a.py", "offset": o}, "x")
                             for o in (0, 100, 0, 100, 0, 100)])
    assert "read the same target" in (_reminder(back_and_forth) or "")
    forward = _turn(*[("read_file", {"file_path": "a.py", "offset": o}, "x")
                      for o in (0, 100, 200, 300, 400, 500)])
    assert _reminder(forward) is None


def test_many_distinct_calls_get_a_note_not_a_stop():
    msgs = _turn(*[("read_file", {"file_path": f"f{i}.py"}, "content") for i in range(25)])
    text = _reminder(msgs) or ""
    assert "not a request to stop" in text


def test_a_new_user_message_starts_a_fresh_window():
    msgs = _turn(*[("grep", {"pattern": "foo"}, "hit")] * 3) + [HumanMessage(content="next")]
    assert _reminder(msgs) is None


def test_loop_guard_reaches_the_model_but_not_the_stored_thread(tmp_path, monkeypatch):
    monkeypatch.delenv("CIRCLE_LOOP_GUARD", raising=False)
    same = {"pattern": "needle"}
    agent, model, _ = _agent(
        tmp_path,
        [_call("grep", same, "a"), _call("grep", same, "b"), _call("grep", same, "c"),
         AIMessage(content="done")],
        model_cls=RecordingModel)
    result, _ = _run(agent)
    last_seen = model.seen[-1][-1]
    assert isinstance(last_seen, HumanMessage) and "loop-guard" in last_seen.content
    assert not any("loop-guard" in str(m.content) for m in result["messages"])


def test_loop_guard_can_be_turned_off(monkeypatch):
    monkeypatch.setenv("CIRCLE_LOOP_GUARD", "0")
    msgs = _turn(*[("grep", {"pattern": "foo"}, "hit")] * 3)
    request = type("Req", (), {"messages": msgs,
                               "override": lambda self, **kw: pytest.fail("changed")})()
    assert LoopGuardMiddleware()._with_reminder(request) is request


# ── pruning ─────────────────────────────────────────────────────────────────


def _tool(text: str, name: str = "read_file", i: int = 0) -> ToolMessage:
    return ToolMessage(content=text, name=name, tool_call_id=f"t{i}")


def test_old_tool_outputs_are_cut_once_the_recent_window_is_full(monkeypatch):
    monkeypatch.delenv("CIRCLE_PRUNE_PROTECT_TOKENS", raising=False)
    big = "x" * 120_000  # ≈30k tokens each
    msgs = [HumanMessage(content="go"), _tool(big, i=0), _tool(big, i=1), _tool(big, i=2)]
    out = prune_messages(msgs)
    assert out is not msgs
    assert out[3].content == big  # newest stays whole
    for pruned in out[1:3]:
        assert len(pruned.content) < 400 and "pruned to free context" in pruned.content
    assert msgs[1].content == big  # the caller's list is untouched


def test_pruning_keeps_small_sessions_json_and_protected_tools(monkeypatch):
    monkeypatch.delenv("CIRCLE_PRUNE_PROTECT_TOKENS", raising=False)
    small = [HumanMessage(content="go"), _tool("x" * 1000), _tool("y" * 1000, i=1)]
    assert prune_messages(small) is small
    doc = json.dumps({"k": "v" * 120_000})
    big = "x" * 120_000
    msgs = [_tool(doc, i=0), _tool(big, name="skill", i=1), _tool(big, i=2), _tool(big, i=3),
            _tool(big, i=4)]
    out = prune_messages(msgs)
    assert out[0].content == doc and out[1].content == big
    assert "pruned to free context" in out[2].content and out[4].content == big
