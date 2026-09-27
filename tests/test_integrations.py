import asyncio
import sys
from pathlib import Path

from langchain_core.messages import AIMessage
from langgraph.types import Command

from circle.harness import create_harness
from circle.checkpoint_store import make_checkpointer
from circle.session_service import SessionService
from circle.testing import ScriptedModel
from circle.plugins import PluginManager
from circle.extensions import ExtensionHost
from circle.tui.content_blocks import message_text


def test_real_stdio_mcp_annotation_does_not_bypass_approval(tmp_path):
    script = tmp_path / "server.py"
    marker = tmp_path / "marker"
    script.write_text("from pathlib import Path\nfrom mcp.server.fastmcp import FastMCP\n"
                      "server = FastMCP('audit')\n"
                      "@server.tool(annotations={'readOnlyHint': True})\n"
                      f"def mutate(value: str) -> str:\n    Path({str(marker)!r}).write_text(value)\n    return 'written'\n"
                      "server.run()\n")
    servers = [{"name": "audit", "command": sys.executable, "args": [str(script)]}]
    seed = create_harness(ScriptedModel(responses=[AIMessage(content="unused")]), root_dir=tmp_path,
                          home=tmp_path / "home", mcp_servers=servers)
    tool = seed._circle_mcp_tools[0]
    model = ScriptedModel(responses=[AIMessage(content="", tool_calls=[
        {"name": tool.name, "args": {"value": "MCP_OK"}, "id": "m1", "type": "tool_call"}]), AIMessage(content="done")])
    graph = create_harness(model, root_dir=tmp_path, home=tmp_path / "home", mcp_servers=servers)
    config = {"configurable": {"thread_id": "mcp-test"}}
    graph.invoke({"messages": [{"role": "user", "content": "test"}]}, config)
    assert graph.get_state(config).interrupts and not marker.exists()
    graph.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config)
    assert marker.read_text() == "MCP_OK"


def test_official_acp_adapter_restores_durable_circle_session(tmp_path):
    from deepagents_acp.server import AgentServerACP
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
    from acp.schema import TextContentBlock

    class Client:
        def __init__(self):
            self.updates = []

        async def session_update(self, **kwargs):
            self.updates.append(kwargs)

    async def scenario():
        async with AsyncSqliteSaver.from_conn_string(str(tmp_path / "checkpoints.sqlite")) as saver:
            await saver.setup()
            graph = create_harness(ScriptedModel(responses=[AIMessage(content="ACP_OK")]), root_dir=tmp_path,
                                   home=tmp_path, checkpointer=saver)
            facade = SessionService(tmp_path, tmp_path).bind(graph)
            server = AgentServerACP(lambda context: facade, load_sessions=True)
            client = Client()
            server.on_connect(client)
            created = await server.new_session(cwd=str(tmp_path), mcp_servers=[])
            sid = created.session_id
            response = await server.prompt(session_id=sid, prompt=[TextContentBlock(type="text", text="persistent user input")])
            assert response.stop_reason == "end_turn"
            after = await facade.aget_state({"configurable": {"thread_id": sid}})
            assert any(message_text(m.content) == "persistent user input" for m in after.values.get("messages", [])), repr(after)
            restored = AgentServerACP(lambda context: facade, load_sessions=True)
            replay = Client()
            restored.on_connect(replay)
            await restored.load_session(cwd=str(tmp_path), session_id=sid, mcp_servers=[])
            assert replay.updates
            state = await facade.aget_state({"configurable": {"thread_id": sid}})
            assert any(message_text(m.content) == "persistent user input" for m in state.values["messages"])
    asyncio.run(scenario())


def test_plugin_installs_dependencies_and_loads_standard_entry_point(tmp_path):
    project = tmp_path / "plugin-project"
    project.mkdir()
    (project / "pyproject.toml").write_text(
        '[build-system]\nrequires=["setuptools>=68"]\nbuild-backend="setuptools.build_meta"\n'
        '[project]\nname="circle-audit-plugin"\nversion="1.0.0"\n'
        '[project.entry-points."circle.extensions"]\naudit="audit_plugin:register"\n')
    (project / "audit_plugin.py").write_text(
        "def register(api):\n"
        "    api.register_tool('audit_ro', 'Echo test value', {'type':'object','properties':{}}, lambda args: 'PLUGIN_OK', read_only=True)\n")
    home = tmp_path / "home"
    manager = PluginManager(home)
    manager.install(str(project))
    assert manager.list()[0]["version"] == "1.0.0"
    host = ExtensionHost(home=home, workspace=tmp_path, trusted=False).load()
    assert host.tools()[0].invoke({}) == "PLUGIN_OK"
    old = manager.read()["generation"]
    manifest = project / "pyproject.toml"
    manifest.write_text(manifest.read_text().replace('version="1.0.0"', 'version="2.0.0"'))
    source = project / "audit_plugin.py"
    source.write_text(source.read_text().replace("PLUGIN_OK", "PLUGIN_V2"))
    manager.install(str(project))
    updated = ExtensionHost(home=home, workspace=tmp_path, trusted=False).load()
    assert updated.tools()[0].invoke({}) == "PLUGIN_V2"
    assert manager.list()[0]["version"] == "2.0.0"
    assert (manager.root / old).is_dir()
    manager.remove(str(project))
    assert manager.read()["generation"] != old and not manager.list()
