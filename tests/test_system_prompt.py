"""System prompt assembly."""

from __future__ import annotations

from pathlib import Path

from circle.system_prompt import (
    available_session_prompts,
    build_system_prompt,
    discover_context_files,
    load_command_prompt,
    load_session_prompt,
    load_tool_prompt,
    select_session_prompt_name,
)


def test_session_prompt_family_mapping():
    assert select_session_prompt_name("claude-sonnet-5") == "anthropic"
    assert select_session_prompt_name("gpt-5") == "gpt"
    assert select_session_prompt_name("gpt-4.1") == "gpt"
    assert select_session_prompt_name("o3-mini") == "gpt"
    assert select_session_prompt_name("gemini-2.5-pro") == "gemini"
    assert select_session_prompt_name("mystery-model") == "default"
    assert "anthropic" in available_session_prompts()
    assert "default" in available_session_prompts()


def test_load_session_normalizes_tool_names_and_placeholders():
    body = load_session_prompt("claude-sonnet-5")
    assert "Circle" in body
    assert "write_todos" in body or "Circle" in body
    assert "TodoWrite" not in body
    assert load_tool_prompt("read_file")
    execute = load_tool_prompt("execute") or ""
    assert execute
    assert "${intro}" not in execute
    assert load_command_prompt("initialize")
    assert "AGENTS.md" in (load_command_prompt("initialize") or "")
    meta = load_session_prompt("muse-1")
    assert "{{MODEL_NAME}}" not in meta
    assert "Meta MSL" not in meta


def test_build_includes_paths_env_and_agents(tmp_path: Path):
    (tmp_path / "AGENTS.md").write_text("# Project\nUse pytest.\n", encoding="utf-8")
    prompt = build_system_prompt(
        cwd=tmp_path,
        model_id="claude-sonnet-5",
        protocol="anthropic",
    )
    assert "Paths (Circle)" in prompt or "Host absolute paths" in prompt
    assert "<env>" in prompt
    assert "Working directory:" in prompt
    assert "<project_context>" in prompt
    assert "Use pytest." in prompt
    assert "read_file" in prompt
    assert "execute: run a shell command in the workspace (macOS: use python3 not python)" in prompt
    assert ".venv311" not in prompt
    assert "Current working directory:" in prompt


def test_discover_context_prefers_agents_override(tmp_path: Path):
    (tmp_path / "AGENTS.md").write_text("base", encoding="utf-8")
    (tmp_path / "AGENTS.override.md").write_text("override", encoding="utf-8")
    files = discover_context_files(tmp_path)
    names = [Path(p).name for p, _ in files]
    assert "AGENTS.override.md" in names
    assert "AGENTS.md" in names


def test_one_file_under_two_names_is_read_once(tmp_path):
    import os

    (tmp_path / "AGENTS.md").write_text("only once", encoding="utf-8")
    # One file, two names: what AGENTS.md and AGENTS.MD are on a case-insensitive disk
    os.link(tmp_path / "AGENTS.md", tmp_path / "CLAUDE.md")
    files = discover_context_files(tmp_path)
    assert [content for _path, content in files] == ["only once"]


def test_project_instructions_are_not_also_memory(tmp_path):
    import json

    from langchain_core.messages import AIMessage

    from circle.harness import create_harness
    from circle.testing import ScriptedModel

    (tmp_path / "AGENTS.md").write_text("Prefer TABS-NOT-SPACES.", encoding="utf-8")
    seen = []

    class Rec(ScriptedModel):
        def _generate(self, messages, stop=None, run_manager=None, **kw):
            seen.append(messages)
            return super()._generate(messages, stop, run_manager, **kw)

    agent = create_harness(Rec(responses=[AIMessage(content="ok")]), root_dir=tmp_path,
                           home=tmp_path / "home")
    agent.invoke({"messages": [{"role": "user", "content": "hi"}]},
                 config={"configurable": {"thread_id": "t"}})
    system = seen[0][0].content
    text = system if isinstance(system, str) else json.dumps(system)
    assert text.count("TABS-NOT-SPACES") == 1


def test_the_guidelines_ask_for_real_test_runs_and_no_cd_into_the_workspace(tmp_path):
    from circle.system_prompt import build_system_prompt

    prompt = build_system_prompt(cwd=tmp_path, context_files=[])
    assert "run the project's test runner" in prompt
    assert "do not say tests pass unless the output shows them passing" in prompt
    assert "do not start them with `cd <working directory> &&`" in prompt
