"""Extension-defined general-purpose agents replace Circle's bundled spec."""

from __future__ import annotations

from langchain_core.messages import AIMessage

import circle.harness as harness_mod
from circle.extensions import ExtensionHost
from circle.harness import BUILTIN_TOOL_NAMES, create_harness
from circle.oauth import start_oauth_login
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, TrustController
from circle.tui.session_app import CircleSessionApp


def test_extension_general_purpose_replaces_builtin_and_session_starts(tmp_path, monkeypatch):
    home, workspace = tmp_path / "home", tmp_path / "workspace"
    workspace.mkdir()
    extension = home / "extensions" / "custom_gp" / "extension.py"
    extension.parent.mkdir(parents=True)
    extension.write_text('''
def register(api):
    api.register_tool("inspect_ro", "Inspect the project.",
                      {"type": "object", "properties": {}},
                      lambda _args: "inspected", read_only=True)
    api.register_subagent({
        "name": "general-purpose",
        "description": "Extension-defined project inspector.",
        "system_prompt": "Use inspect_ro for project checks.",
    }, tools=["inspect_ro"])
''', encoding="utf-8")
    host = ExtensionHost(
        home=home, workspace=workspace, trusted=True,
        reserved_tools=set(BUILTIN_TOOL_NAMES), reserved_commands=set(),
    ).load()
    captured: dict = {}
    original = harness_mod.create_deep_agent

    def captured_create(**kwargs):
        captured.update(kwargs)
        return original(**kwargs)

    monkeypatch.setattr(harness_mod, "create_deep_agent", captured_create)
    agent = create_harness(ScriptedModel(responses=[AIMessage(content="ok")]),
                           root_dir=workspace, home=home, extensions=host)
    specs = captured["subagents"]
    assert [spec["name"] for spec in specs] == ["general-purpose", "explore"]
    custom = specs[0]
    assert custom["description"] == "Extension-defined project inspector."
    assert custom["system_prompt"] == "Use inspect_ro for project checks."
    assert [tool.name for tool in custom["tools"]] == ["inspect_ro"]
    assert any(type(mw).__name__ == "CancellationMiddleware" for mw in custom["middleware"])
    task_description = agent.nodes["tools"].bound.tools_by_name["task"].description
    assert task_description.count("- general-purpose:") == 1
    assert "- general-purpose: Extension-defined project inspector." in task_description
    assert "- explore:" in task_description

    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    TrustController(init.settings, workspace, home=home).confirm()
    app = CircleSessionApp(init.settings, workspace, home=home,
                           model_override=ScriptedModel(responses=[AIMessage(content="ok")]))
    app._on_submit("/extensions reload")
    reloaded_description = app._agent.nodes["tools"].bound.tools_by_name["task"].description
    assert "- general-purpose: Extension-defined project inspector." in reloaded_description
