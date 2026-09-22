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
    assert select_session_prompt_name("gemini-2.5-pro") == "gemini"
    assert select_session_prompt_name("mystery-model") == "default"
    assert "anthropic" in available_session_prompts()
    assert "default" in available_session_prompts()


def test_load_session_and_tool_prompts():
    body = load_session_prompt("claude-sonnet-5")
    assert "Circle" in body
    assert "You are Circle" in body or "Circle" in body
    assert load_tool_prompt("read_file")
    assert load_tool_prompt("execute")
    assert load_command_prompt("initialize")
    assert "AGENTS.md" in (load_command_prompt("initialize") or "")


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
    assert "Current working directory:" in prompt


def test_discover_context_prefers_agents_override(tmp_path: Path):
    (tmp_path / "AGENTS.md").write_text("base", encoding="utf-8")
    (tmp_path / "AGENTS.override.md").write_text("override", encoding="utf-8")
    files = discover_context_files(tmp_path)
    names = [Path(p).name for p, _ in files]
    assert "AGENTS.override.md" in names
    assert "AGENTS.md" in names
