"""C6: the explore subagent really is read-only — no write/edit/delete/execute/apply_patch,
and a write attempted inside it does not reach the disk."""

from __future__ import annotations

from pathlib import Path

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import StructuredTool

import circle.harness as harness_mod
from circle.harness import EXPLORE_FS_TOOLS, create_harness
from circle.testing import ScriptedModel


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id,
                                              "type": "tool_call"}])


def test_explore_spec_carries_only_read_only_tools(tmp_path: Path, monkeypatch):
    seen: dict = {}
    real = harness_mod.create_deep_agent

    def spy(**kwargs):
        seen.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(harness_mod, "create_deep_agent", spy)
    create_harness(ScriptedModel(responses=[AIMessage(content="ok")]), root_dir=tmp_path,
                   home=tmp_path)
    explore = next(s for s in seen["subagents"] if s["name"] == "explore")
    names = {t.name for t in explore["tools"]}
    assert names <= {"webfetch", "websearch", "lsp", "skill"}
    assert not names & {"apply_patch", "question", "execute", "write_file", "edit_file"}
    (fs,) = [mw for mw in explore["middleware"] if type(mw).__name__ == "FilesystemMiddleware"]
    assert any(type(mw).__name__ == "EffectGateMiddleware" for mw in explore["middleware"])
    assert type(fs).__name__ == "FilesystemMiddleware"
    assert sorted(t.name for t in fs.tools) == sorted(EXPLORE_FS_TOOLS)
    assert explore["interrupt_on"] == {}


def test_write_inside_explore_never_reaches_disk(tmp_path: Path):
    target = tmp_path / "pwned.txt"
    model = ScriptedModel(responses=[
        _call("task", {"description": "look around", "subagent_type": "explore"}, "t1"),
        _call("write_file", {"file_path": "/pwned.txt", "content": "x"}, "w1"),
        AIMessage(content="explore finished"),
        AIMessage(content="main finished"),
    ])
    agent = create_harness(model, root_dir=tmp_path, home=tmp_path)
    cfg = {"configurable": {"thread_id": "ro"}}
    result = agent.invoke({"messages": [{"role": "user", "content": "go"}]}, config=cfg)
    assert not agent.get_state(cfg).interrupts
    assert not target.exists()
    task_result = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert task_result.name == "task" and "explore finished" in str(task_result.content)


def test_general_purpose_cannot_execute_unknown_effects_in_plan(tmp_path):
    def mutation() -> str:
        """Synthetic unknown-effect tool."""
        (tmp_path / "marker").write_text("executed")
        return "ok"
    tool = StructuredTool.from_function(mutation, name="unknown_effect")
    model = ScriptedModel(responses=[
        _call("task", {"description": "plan only", "subagent_type": "general-purpose"}, "t1"),
        _call("unknown_effect", {}, "m1"), AIMessage(content="child finished"), AIMessage(content="main finished")])
    graph = create_harness(model, root_dir=tmp_path, home=tmp_path / "home", plan_mode=True, extra_tools=[tool])
    config = {"configurable": {"thread_id": "plan-child"}}
    graph.invoke({"messages": [{"role": "user", "content": "plan only"}]}, config)
    assert not (tmp_path / "marker").exists()
    assert model.i == 4
