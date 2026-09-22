"""Prompt-backed harness features (explore, tools, compact, plan, skills)."""

from __future__ import annotations

from pathlib import Path

from langchain_core.messages import AIMessage

from circle.harness import create_harness
from circle.prompt_features import (
    build_extra_tools,
    collect_tool_description_overrides,
    compact_messages,
    explore_subagent_spec,
    plan_mode_append,
    skill_source_dirs,
    title_messages,
)
from circle.system_prompt import build_system_prompt, load_agent_prompt
from circle.testing import ScriptedModel


def test_tool_description_overrides_cover_builtins():
    overrides = collect_tool_description_overrides()
    for name in ("read_file", "execute", "task", "write_todos", "glob", "grep"):
        assert name in overrides
        assert overrides[name].strip()


def test_explore_subagent_is_coding_agent_style():
    spec = explore_subagent_spec()
    assert spec["name"] == "explore"
    assert "read-only" in spec["description"].lower() or "Read-only" in spec["description"]
    prompt = spec["system_prompt"]
    assert "file search" in prompt.lower() or "glob" in prompt.lower()
    # Not InfoTest domain voice
    assert "IST" not in prompt
    assert "测例" not in prompt
    assert load_agent_prompt("explore")


def test_extra_tools_webfetch_and_question():
    tools = {t.name: t for t in build_extra_tools()}
    assert "webfetch" in tools
    assert "question" in tools
    q = tools["question"].invoke(
        {
            "questions": [
                {"question": "Which API?", "options": ["REST", "gRPC"], "multiple": False}
            ]
        }
    )
    assert "USER_QUESTIONS" in q
    assert "Which API?" in q
    assert "REST" in q


def test_webfetch_blocks_localhost():
    tools = {t.name: t for t in build_extra_tools()}
    out = tools["webfetch"].invoke({"url": "http://127.0.0.1/secret"})
    assert "refusing" in out.lower()


def test_skill_source_dirs(tmp_path: Path):
    project = tmp_path / "ws"
    home = tmp_path / "home"
    (project / ".agent" / "skills").mkdir(parents=True)
    (home / "skills").mkdir(parents=True)
    dirs = skill_source_dirs(project, home)
    assert len(dirs) == 2
    assert any("skills" in d for d in dirs)
    assert skill_source_dirs(project, None) == [str((project / ".agent" / "skills").resolve())]


def test_compact_and_title_messages_use_agent_prompts():
    msgs = compact_messages(transcript="user: hi\nassistant: hello", hint="keep paths")
    assert msgs[0]["role"] == "system"
    assert "Goal" in msgs[1]["content"] or "summary" in msgs[0]["content"].lower()
    assert "keep paths" in msgs[1]["content"]
    title = title_messages(user_text="Fix the sandbox path bug")
    assert title[0]["role"] == "system"
    assert "Fix the sandbox" in title[1]["content"]


def test_plan_mode_append_is_circle_style():
    text = plan_mode_append()
    assert "Plan mode" in text
    assert "/plan.md" in text
    assert "system-reminder" not in text
    assert "${planInfo}" not in text
    full = build_system_prompt(cwd=Path.cwd(), append=text)
    assert "Plan mode" in full
    assert "webfetch" in full
    assert "question" in full


def test_create_harness_wires_explore_and_extra_tools(tmp_path: Path):
    model = ScriptedModel(responses=[AIMessage(content="ok")])
    (tmp_path / ".agent" / "skills").mkdir(parents=True)
    agent = create_harness(
        model,
        root_dir=tmp_path,
        home=tmp_path / "circle-home",
        model_id="claude-sonnet-5",
        protocol="anthropic",
    )
    assert agent is not None
    assert hasattr(agent, "invoke")
    # Subagent + extra tools are registered at build time; smoke via node names.
    nodes = set(getattr(agent, "nodes", {}) or {})
    assert "model" in nodes
    assert "tools" in nodes


def test_create_harness_plan_mode_appends_prompt(tmp_path: Path):
    model = ScriptedModel(responses=[AIMessage(content="ok")])
    agent = create_harness(
        model,
        root_dir=tmp_path,
        model_id="gpt-5",
        protocol="openai",
        plan_mode=True,
    )
    assert agent is not None
    assert hasattr(agent, "invoke")
