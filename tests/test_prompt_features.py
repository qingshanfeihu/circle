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
    title_messages,
)
from circle.skills import skill_source_dirs
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


def test_question_secret_never_enters_result(tmp_path: Path):
    """secret 提问：值写入目标文件，tool result 只有脱敏确认。"""
    import threading
    import time

    from circle import secret_prompt

    home = tmp_path / "home"
    target = tmp_path / "env.d" / "env"
    tools = {t.name: t for t in build_extra_tools(home=home)}
    secret_value = "jump-root-pw-不许进对话"

    def answer_later() -> None:
        answered: set[str] = set()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and len(answered) < 2:
            for req in secret_prompt.list_pending(home):
                if req["id"] in answered:
                    continue
                value = (
                    secret_value
                    if req["key"] == "JUMPHOST_PASS"
                    else "apv-secret-value"
                )
                secret_prompt.submit_answer(home, req["id"], value)
                answered.add(req["id"])
            time.sleep(0.05)

    threading.Thread(target=answer_later, daemon=True).start()
    result = tools["question"].invoke(
        {
            "questions": [
                {
                    "question": "跳接机密码？",
                    "secret": True,
                    "key": "JUMPHOST_PASS",
                    "target_file": str(target),
                }
            ]
        }
    )
    assert secret_value not in result
    assert "JUMPHOST_PASS" in result
    assert str(target) in result
    assert f"JUMPHOST_PASS={secret_value}" in target.read_text(encoding="utf-8")
    # 与明文 question 混用时普通问题照常列出、secret 值同样不落对话
    mixed = tools["question"].invoke(
        {
            "questions": [
                {"question": "Which API?", "secret": False},
                {
                    "question": "APV 密码？",
                    "secret": True,
                    "key": "APV_PASSWORD",
                    "target_file": str(target),
                },
            ]
        }
    )
    assert "USER_QUESTIONS" in mixed and "Which API?" in mixed
    assert "apv-secret-value" not in mixed
    assert "APV_PASSWORD" in mixed
    content = target.read_text(encoding="utf-8")
    assert f"APV_PASSWORD=apv-secret-value" in content


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
    assert len(dirs) >= 2
    assert any("skills" in d for d in dirs)
    assert str((project / ".agent" / "skills").resolve()) in dirs


def test_extra_tools_include_skill(tmp_path: Path):
    home = tmp_path / "home"
    ws = tmp_path / "ws"
    uh = tmp_path / "uhome"
    uh.mkdir()
    d = home / "skills" / "alpha"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        "---\nname: alpha\ndescription: Alpha skill\n---\n\n# Alpha\n",
        encoding="utf-8",
    )
    tools = {t.name: t for t in build_extra_tools(ws, home, user_home=uh)}
    assert "skill" in tools
    out = tools["skill"].invoke({"name": "alpha"})
    assert "skill_content" in out
    assert "Alpha" in out


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
