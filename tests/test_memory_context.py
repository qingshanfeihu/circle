"""Memory + context fusion: deepagents memory=, compact tool, boundaries."""

from __future__ import annotations

from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage

from circle.checkpoint_store import make_checkpointer, make_store
from circle.context_middleware import (
    compact_prompt,
    inject_thread_message,
    plan_boundary_message,
    skill_boundary_message,
    thread_config,
)
from circle.harness import create_harness
from circle.memory_sources import memory_source_paths
from circle.testing import ScriptedModel


def test_memory_source_paths_discovers_agents_md(tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    (home / "AGENTS.md").write_text("# Home memory\nBe terse.\n", encoding="utf-8")
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "AGENTS.md").write_text("# Workspace memory\nPrefer tests.\n", encoding="utf-8")
    paths = memory_source_paths(ws, home)
    assert any(p.endswith("AGENTS.md") for p in paths)
    assert str((home / "AGENTS.md").resolve()) in paths
    assert str((ws / "AGENTS.md").resolve()) in paths


def test_create_harness_wires_memory_and_compact_tool(tmp_path: Path):
    (tmp_path / "AGENTS.md").write_text("# Agent\nPrefer terse replies.\n", encoding="utf-8")
    model = ScriptedModel(responses=[AIMessage(content="ok")])
    agent = create_harness(model, root_dir=tmp_path, home=tmp_path)
    tools_node = agent.get_graph().nodes["tools"].data
    names = set(tools_node.tools_by_name.keys())
    assert "compact_conversation" in names
    cfg = thread_config("mem-test")
    agent.invoke(
        {"messages": [{"role": "user", "content": "say hi"}]},
        config=cfg,
    )
    st = agent.get_state(cfg)
    assert st.values.get("messages")


def test_inject_plan_and_skill_boundaries(tmp_path: Path):
    model = ScriptedModel(responses=[AIMessage(content="ack")])
    agent = create_harness(model, root_dir=tmp_path, home=tmp_path)
    tid = "boundary-1"
    inject_thread_message(agent, tid, plan_boundary_message(enabled=True))
    inject_thread_message(
        agent,
        tid,
        skill_boundary_message(name="demo", body="Always say DEMO_OK.", args="x"),
    )
    st = agent.get_state(thread_config(tid))
    msgs = st.values.get("messages") or []
    texts = [str(getattr(m, "content", "")) for m in msgs]
    assert any("Plan mode is now ON" in t for t in texts)
    assert any("Skill `demo`" in t for t in texts)
    assert any("DEMO_OK" in t for t in texts)


def test_sqlite_checkpointer_roundtrip(tmp_path: Path):
    cp = make_checkpointer(tmp_path)
    assert cp is not None
    model = ScriptedModel(responses=[AIMessage(content="pong")])
    agent = create_harness(
        model,
        root_dir=tmp_path,
        home=tmp_path,
        checkpointer=cp,
        store=make_store(),
    )
    tid = "sqlite-1"
    agent.invoke(
        {"messages": [{"role": "user", "content": "ping"}]},
        config=thread_config(tid),
    )
    st = agent.get_state(thread_config(tid))
    msgs = st.values.get("messages") or []
    assert len(msgs) >= 2


def test_compact_prompt_mentions_tool():
    p = compact_prompt(hint="keep paths")
    assert "compact_conversation" in p
    assert "keep paths" in p
