import time
import threading
import sys
import os
import shlex
import subprocess
from pathlib import Path

from langchain_core.messages import AIMessage
from langchain_core.tools import StructuredTool
from unittest.mock import patch

from circle.harness import create_harness, sandbox_backend
from circle.session_service import SessionService
from circle.checkpoint_store import make_checkpointer
from circle.settings import CircleSettings, ModelAuth, save_credentials
from circle.testing import ScriptedModel
from circle.tui.session_app import CircleSessionApp
from tests.test_session_service import CapturingModel


def call(name, args):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": "c1", "type": "tool_call"}])


def idle(app):
    end = time.monotonic() + 8
    while app._bridge.is_running or app._is_loading:
        assert time.monotonic() < end
        time.sleep(0.02)


def app_at(tmp_path):
    ws, home = tmp_path / "ws", tmp_path / "home"
    ws.mkdir()
    settings = CircleSettings(initialized=True, auth=ModelAuth(base_url="http://invalid.example", model="audit"),
                              trusted_folders=[str(ws.resolve())])
    save_credentials({"api_key": "synthetic-placeholder"}, home)
    model = CapturingModel(responses=[AIMessage(content=f"a-{n}") for n in range(10)])
    return CircleSessionApp(settings, ws, home=home, model_override=model), model


def test_tui_undo_removes_message_from_next_request(tmp_path):
    app, model = app_at(tmp_path)
    app._on_submit("first")
    idle(app)
    app._on_submit("discard")
    idle(app)
    app._cmd_undo("")
    app._on_submit("alternative")
    idle(app)
    assert "discard" not in model.inputs[-1]
    assert "first" in model.inputs[-1]


def test_tui_restart_resume_restores_real_context(tmp_path):
    app, _ = app_at(tmp_path)
    app._on_submit("persistent")
    idle(app)
    sid = app._thread_id
    model = CapturingModel(responses=[AIMessage(content="done")])
    restarted = CircleSessionApp(app.settings, app.workspace, home=app.home, model_override=model)
    restarted._cmd_resume(sid)
    assert restarted._thread_id == sid
    restarted._on_submit("continue")
    idle(restarted)
    assert "persistent" in model.inputs[-1]


def test_tui_clone_retains_history_and_new_resets_tree(tmp_path):
    app, model = app_at(tmp_path)
    app._on_submit("persistent")
    idle(app)
    old = app._thread_id
    app._cmd_clone("")
    assert app._thread_id != old
    app._on_submit("clone continuation")
    idle(app)
    assert "persistent" in model.inputs[-1]
    app._cmd_new("")
    assert not app._session_tree.nodes


def test_tui_uses_registered_provider_from_shared_runtime(tmp_path):
    app, _ = app_at(tmp_path)
    extension = app.home / "extensions" / "provider"
    extension.mkdir(parents=True)
    (extension / "extension.py").write_text(
        "from circle.testing import ScriptedModel\n"
        "from langchain_core.messages import AIMessage\n"
        "def register(api):\n"
        "    api.register_provider('audit_provider', lambda auth: ScriptedModel(responses=[AIMessage(content='PROVIDER_OK')]))\n")
    app.settings.auth.provider = "audit_provider"
    app.model_override = None
    app._extensions = app._load_extensions()
    app._rebuild_agent()
    app._on_submit("test the custom provider")
    idle(app)
    assert "PROVIDER_OK" in app._last_assistant_plain


def test_tui_cannot_select_tree_node_while_a_turn_is_busy(tmp_path):
    app, _ = app_at(tmp_path)
    app._on_submit("first")
    idle(app)
    selected = app._session_tree.active_id
    previous = dict(app._sessions.get(app._thread_id)["ref"])
    target = next(node.id for node in app._session_tree.nodes.values() if node.role == "user")
    app._is_loading = True
    app._on_submit("/tree " + target)
    assert app._session_tree.active_id == selected
    assert app._sessions.get(app._thread_id)["ref"] == previous


def test_plan_blocks_external_same_basename(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    backend = sandbox_backend(ws, plan_mode=True)
    outside = tmp_path / "outside" / "plan.md"
    assert backend.write(str(outside), "forbidden").error
    assert not outside.exists()
    assert backend.write("/plan.md", "allowed").error is None


def test_provider_credentials_are_guarded_even_with_custom_patterns(tmp_path):
    from circle.approvals import default_policy
    from circle.input_files import prepare_content
    import pytest
    path = tmp_path / "provider-credentials.json"
    path.write_text("SYNTHETIC_CREDENTIAL")
    policy = default_policy(tmp_path / "home", ["*.custom-secret"])
    assert policy.review("execute", {"command": "cat provider-credentials.json"}).verdict == "DENY"
    with pytest.raises(ValueError, match="Credential"):
        prepare_content("@provider-credentials.json", tmp_path, credential_files=["*.custom-secret"])
    model = ScriptedModel(responses=[call("read_file", {"file_path": "/provider-credentials.json"}), AIMessage(content="done")])
    graph = create_harness(model, root_dir=tmp_path, home=tmp_path / "home", approvals=policy)
    state = graph.invoke({"messages": [{"role": "user", "content": "read it"}]},
                         {"configurable": {"thread_id": "credential-guard"}})
    assert all("SYNTHETIC_CREDENTIAL" not in str(message.content) for message in state["messages"])


def test_mcp_requires_approval_and_is_blocked_in_plan(tmp_path):
    def mutate(value: str) -> str:
        """Write an audit marker."""
        (tmp_path / "marker").write_text(value)
        return "done"
    tool = StructuredTool.from_function(mutate, name="audit_mcp")
    for plan in (False, True):
        with patch("circle.harness.load_mcp_tools_sync", return_value=[tool]):
            agent = create_harness(ScriptedModel(responses=[call(tool.name, {"value": "x"}), AIMessage(content="done")]),
                                   root_dir=tmp_path, home=tmp_path / "home", plan_mode=plan,
                                   mcp_servers=[{"name": "audit"}])
        cfg = {"configurable": {"thread_id": f"plan-{plan}"}}
        out = agent.invoke({"messages": [{"role": "user", "content": "test"}]}, cfg)
        assert not (tmp_path / "marker").exists()
        assert bool(agent.get_state(cfg).interrupts) is (not plan)
        if plan:
            assert any("blocked" in str(m.content) for m in out["messages"])


def test_cancel_kills_inflight_shell(tmp_path):
    import psutil
    app, _ = app_at(tmp_path)
    script = "from pathlib import Path; import time, os; Path('started').write_text(str(os.getpid())); time.sleep(2); Path('late').write_text('late')"
    args = [sys.executable, "-c", script]
    command = subprocess.list2cmdline(args) if os.name == "nt" else shlex.join(args)
    app.model_override = ScriptedModel(responses=[call("execute", {"command": command}),
                                                AIMessage(content="done")])
    app._rebuild_agent(model=app.model_override)
    app._cmd_yolo("on")
    app._on_submit("execute synthetic test")
    end = time.monotonic() + 5
    started = app.workspace / "started"
    while not started.exists() or not started.read_text().strip().isdigit():
        assert time.monotonic() < end
        time.sleep(0.02)
    process = psutil.Process(int(started.read_text()))
    app._bridge.cancel()
    end = time.monotonic() + 2
    while process.is_running():
        try:
            if process.status() == psutil.STATUS_ZOMBIE:
                break
        except psutil.NoSuchProcess:
            break
        assert time.monotonic() < end, "Cancelled shell child is still running"
        time.sleep(0.02)
    # Checkpoint/executor teardown has its own budget, after proving the shell
    # is dead and cannot perform the scheduled mutation.
    app._bridge._worker.join(timeout=8)
    assert not app._bridge.is_running
    assert not (app.workspace / "late").exists()


def test_steering_reaches_next_request_before_current_run_ends(tmp_path):
    app, _ = app_at(tmp_path)
    entered, release = threading.Event(), threading.Event()
    def pause() -> str:
        """Pause a synthetic read operation."""
        entered.set()
        assert release.wait(3)
        return "read result"
    tool = StructuredTool.from_function(pause, name="pause_read", metadata={"circle_read_only": True})
    model = CapturingModel(responses=[call("pause_read", {}), AIMessage(content="finished"), AIMessage(content="followup")])
    raw = create_harness(model, root_dir=app.workspace, home=app.home, checkpointer=app._checkpointer, extra_tools=[tool])
    app._agent = app._sessions.bind(raw)
    app._bridge = app._make_bridge()
    app._on_submit("initial")
    assert entered.wait(3)
    app._on_submit("STEERING")
    release.set()
    idle(app)
    assert "STEERING" in model.inputs[1]
    assert model.i == 2  # one run, not another task after it finishes


def test_steering_is_delivered_to_parent_after_child_returns(tmp_path):
    from circle.extensions import Extension, ExtensionAPI, ExtensionHost
    app, _ = app_at(tmp_path)
    entered, release = threading.Event(), threading.Event()
    def pause() -> str:
        """Pause a read inside a child agent."""
        entered.set()
        assert release.wait(4)
        return "read result"
    tool = StructuredTool.from_function(pause, name="pause_read", metadata={"circle_read_only": True})
    child = CapturingModel(responses=[call("pause_read", {}), AIMessage(content="child finished")])
    parent = CapturingModel(responses=[call("task", {"subagent_type": "researcher", "description": "read"}),
                                       AIMessage(content="parent finished")])
    host = ExtensionHost(home=app.home, workspace=app.workspace, trusted=True).load()
    extension = Extension("research", "user", tmp_path / "extension.py")
    ExtensionAPI(extension, set(), set()).register_subagent({
        "name": "researcher", "description": "research", "system_prompt": "read only", "model": child},
        tools=["pause_read"])
    host.extensions.append(extension)
    raw = create_harness(parent, root_dir=app.workspace, home=app.home, checkpointer=app._checkpointer,
                         extensions=host, extra_tools=[tool])
    app._agent = app._sessions.bind(raw)
    app._bridge = app._make_bridge()
    app._on_submit("initial")
    assert entered.wait(4)
    app._on_submit("MAIN_STEERING")
    release.set()
    idle(app)
    assert "MAIN_STEERING" in parent.inputs[-1]
    assert all("MAIN_STEERING" not in request for request in child.inputs)
    assert parent.i == child.i == 2


def test_cancel_native_model_request_before_server_response(tmp_path):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from langchain_openai import ChatOpenAI
    entered, release = threading.Event(), threading.Event()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            entered.set()
            release.wait(5)
            self.send_response(200)
            self.end_headers()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    app, _ = app_at(tmp_path)
    app.model_override = ChatOpenAI(model="gpt-4.1", api_key="synthetic-placeholder", streaming=True,
                                    base_url=f"http://127.0.0.1:{server.server_port}/v1", max_retries=0)
    app._rebuild_agent(model=app.model_override)
    try:
        app._on_submit("test pending native request")
        assert entered.wait(3)
        app._bridge.cancel()
        app._bridge._worker.join(timeout=2)
        assert not app._bridge.is_running
    finally:
        release.set()
        server.shutdown()
        server.server_close()


def test_input_during_cancel_teardown_starts_a_fresh_turn(tmp_path):
    import asyncio
    from circle.ink.parse_keypress import KeyPress
    entered, cancelling, release = threading.Event(), threading.Event(), threading.Event()
    class SlowCancellation(CapturingModel):
        async def _agenerate(self, messages, *args, **kwargs):
            if self.i == 0:
                self.i = 1
                entered.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancelling.set()
                    while not release.is_set():
                        await asyncio.sleep(0.02)
                    raise
            return self._generate(messages, *args, **kwargs)
    app, _ = app_at(tmp_path)
    model = SlowCancellation(responses=[AIMessage(content="unused"), AIMessage(content="fresh answer")])
    app.model_override = model
    app._rebuild_agent(model=model)
    app._on_submit("cancel this request")
    assert entered.wait(3)
    app._handle_key(KeyPress(key="ctrl+c", ctrl=True, char="c"))
    assert cancelling.wait(3)
    app._on_submit("FOLLOWUP_AFTER_CANCEL")
    try:
        assert app._msg_queue and not app._bridge._signals.steering
    finally:
        release.set()
    end = time.monotonic() + 8
    while app._msg_queue or app._bridge.is_running or app._is_loading:
        assert time.monotonic() < end
        time.sleep(0.02)
    assert "FOLLOWUP_AFTER_CANCEL" in model.inputs[-1]
    assert app._last_assistant_plain == "fresh answer"
