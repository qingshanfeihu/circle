"""The provider-specific task override must expose the actual subagent catalog."""

from __future__ import annotations

import pytest

from circle.extensions import ExtensionHost
from circle.harness import BUILTIN_TOOL_NAMES, create_harness
from circle.model import build_chat_model
from circle.settings import CircleSettings, ModelAuth, save_credentials
from circle.system_prompt import build_system_prompt

_HELPER = '''
def register(api):
    schema = {"type": "object", "properties": {}}
    api.register_tool("inspect_ro", "Inspect read-only state.", schema,
                      lambda _args: "ok", read_only=True)
    api.register_subagent({
        "name": "auditor",
        "description": "Audits project state with inspect_ro.",
        "system_prompt": "Audit the project.",
    }, tools=["inspect_ro"])
'''


@pytest.mark.parametrize("protocol,model_name,model_class", [
    ("anthropic", "claude-sonnet-4-5", "GuardedChatAnthropic"),
    ("openai", "gpt-5.1", "GuardedChatOpenAI"),
])
def test_real_provider_task_description_lists_every_subagent(
        tmp_path, protocol, model_name, model_class):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    path = home / "extensions" / "helper" / "extension.py"
    path.parent.mkdir(parents=True)
    path.write_text(_HELPER, encoding="utf-8")
    save_credentials({"api_key": "sk-test"}, home)
    settings = CircleSettings(initialized=True, auth=ModelAuth(
        protocol=protocol, base_url="http://127.0.0.1:9", model=model_name))
    model = build_chat_model(settings, home=home)
    assert type(model).__name__ == model_class
    extensions = ExtensionHost(
        home=home, workspace=ws, trusted=True,
        reserved_tools=set(BUILTIN_TOOL_NAMES), reserved_commands=set(),
    ).load()
    agent = create_harness(
        model, root_dir=ws, home=home, model_id=model_name, protocol=protocol,
        extensions=extensions, ask_user=True,
    )
    description = agent.nodes["tools"].bound.tools_by_name["task"].description
    assert "- general-purpose:" in description
    assert "access to all tools as the main agent" in description
    assert "- explore:" in description and "Read-only" in description
    assert "- auditor: Audits project state with inspect_ro." in description
    assert "read_file, glob, or grep" in description
    assert "{available_agents}" not in description
    assert "task_id" not in description
    assert "background" not in description

    prompt = build_system_prompt(cwd=ws, model_id=model_name, protocol=protocol)
    assert "task: delegate to a listed subagent (general-purpose" in prompt
