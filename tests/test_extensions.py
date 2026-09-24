"""Extension API (C1): discovery and trust, isolation, tools through the real harness,
approval, subagents, middleware order, settings round-trip, and the session wiring
(/extensions, commands, renderers, events). The last test loads the real compile-excel
extension installed by its own installer, when a compile-excel-skills checkout is nearby."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from circle.extensions import ExtensionError, ExtensionHost
from circle.harness import BUILTIN_TOOL_NAMES, create_harness
from circle.oauth import start_oauth_login
from circle.settings import CircleSettings, load_settings, save_settings
from circle.system_prompt import build_system_prompt
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, TrustController
from circle.tui.session_app import CircleSessionApp

SAMPLE = '''
def register(api):
    def echo(args):
        return {"ok": True, "echo": args}

    def fails(args):
        raise api.ToolError("boom: " + str(args.get("why", "")))

    def write(args):
        return "written"

    obj = {"type": "object", "properties": {"why": {"type": "string"}, "x": {"type": "integer"}}}
    api.register_tool("echo_ro", "Echo the arguments back. Read-only.", obj, echo, read_only=True)
    api.register_tool("always_fails", "Fails on purpose.", obj, fails, read_only=True)
    api.register_tool("writer", "Changes something.", obj, write)
'''


def _ext(root: Path, name: str, body: str) -> Path:
    path = root / name / "extension.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


def _host(home: Path, ws: Path, *, trusted: bool = True, settings=None) -> ExtensionHost:
    return ExtensionHost(home=home, workspace=ws, trusted=trusted, settings=settings,
                         reserved_tools=set(BUILTIN_TOOL_NAMES),
                         reserved_commands={"help", "mcp"}).load()


def _call(name: str, args: dict, call_id: str = "c1") -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id,
                                              "type": "tool_call"}])


def _run(agent, text: str = "go", thread: str = "t1"):
    cfg = {"configurable": {"thread_id": thread}}
    result = agent.invoke({"messages": [{"role": "user", "content": text}]}, config=cfg)
    return result, agent.get_state(cfg)


def test_discovery_respects_trust_and_settings(tmp_path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    _ext(home / "extensions", "user_ext", SAMPLE)
    _ext(ws / ".circle" / "extensions", "proj_ext", "def register(api):\n    pass\n")
    untrusted = _host(home, ws, trusted=False)
    assert [e.name for e in untrusted.extensions] == ["user_ext"]
    trusted = _host(home, ws, trusted=True)
    assert sorted(e.name for e in trusted.extensions) == ["proj_ext", "user_ext"]
    assert {e.name: e.source for e in trusted.extensions}["proj_ext"] == "project"
    off = _host(home, ws, settings={"user_ext": {"enabled": False}})
    assert [t.name for t in off.tool_specs()] == []
    assert any("已关闭" in line for line in off.describe())


def test_register_failure_drops_everything_that_extension_registered(tmp_path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    _ext(home / "extensions", "bad", '''
        def register(api):
            api.register_tool("half", "d", {"type": "object", "properties": {}}, lambda a: 1)
            raise RuntimeError("crashed midway")
    ''')
    _ext(home / "extensions", "good", SAMPLE)
    host = _host(home, ws)
    bad = next(e for e in host.extensions if e.name == "bad")
    assert "crashed midway" in bad.error and bad.tools == []
    assert {t.name for t in host.tool_specs()} == {"echo_ro", "always_fails", "writer"}


def test_name_clashes_are_refused(tmp_path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    _ext(home / "extensions", "a_first", SAMPLE)
    _ext(home / "extensions", "b_dup_tool", '''
        def register(api):
            api.register_tool("echo_ro", "dup", {"type": "object", "properties": {}}, lambda a: 1)
    ''')
    _ext(home / "extensions", "c_builtin_tool", '''
        def register(api):
            api.register_tool("execute", "shadow", {"type": "object", "properties": {}}, lambda a: 1)
    ''')
    _ext(home / "extensions", "d_builtin_cmd", '''
        def register(api):
            api.register_command("help", "shadow", lambda args, ctx: None)
    ''')
    host = _host(home, ws)
    errors = {e.name: e.error for e in host.extensions}
    assert errors["a_first"] == ""
    assert "already exists" in errors["b_dup_tool"]
    assert "already exists" in errors["c_builtin_tool"]
    assert "already exists" in errors["d_builtin_cmd"]


def test_extension_tools_run_through_the_harness(tmp_path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    _ext(home / "extensions", "sample", SAMPLE)
    host = _host(home, ws)
    model = ScriptedModel(responses=[_call("echo_ro", {"x": 7}), _call("always_fails", {"why": "test"}, "c2"),
                                     AIMessage(content="done")])
    agent = create_harness(model, root_dir=ws, home=home, extensions=host)
    names = set(agent.get_graph().nodes["tools"].data.tools_by_name)
    assert {"echo_ro", "always_fails", "writer"} <= names
    result, _ = _run(agent)
    tool_msgs = {m.name: m for m in result["messages"] if isinstance(m, ToolMessage)}
    assert json.loads(tool_msgs["echo_ro"].content) == {"ok": True, "echo": {"x": 7}}
    assert tool_msgs["echo_ro"].status == "success"
    assert tool_msgs["always_fails"].status == "error"
    assert "boom: test" in tool_msgs["always_fails"].content


def test_state_changing_extension_tools_wait_for_approval(tmp_path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    _ext(home / "extensions", "sample", SAMPLE)
    host = _host(home, ws)
    assert host.interrupt_on() == {"writer": True}
    model = ScriptedModel(responses=[_call("writer", {"x": 1}), AIMessage(content="done")])
    agent = create_harness(model, root_dir=ws, home=home, extensions=host)
    _, state = _run(agent)
    assert state.interrupts, "writer must stop for approval before it runs"
    requests = state.interrupts[0].value["action_requests"]
    assert requests[0]["name"] == "writer"


def test_subagent_tool_whitelist_and_middleware_order(tmp_path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    _ext(home / "extensions", "sample", SAMPLE + '''
    api.register_subagent({"name": "helper", "description": "d", "system_prompt": "p"},
                          tools=["echo_ro"])
    api.register_subagent({"name": "broken", "description": "d", "system_prompt": "p"},
                          tools=["no_such_tool"])
    api.register_middleware("late", slot="after_model")
    api.register_middleware("early", slot="model_call")
''')
    host = _host(home, ws)
    tools = host.tools()
    subs = host.subagents(tools)
    assert [s["name"] for s in subs] == ["helper"]
    assert [t.name for t in subs[0]["tools"]] == ["echo_ro"]
    assert host.middleware() == ["early", "late"]
    assert any("no_such_tool" in line for line in host.describe())
    with pytest.raises(ExtensionError):
        from circle.extensions import Extension, ExtensionAPI

        ExtensionAPI(Extension("x", "user", ws), set(), set()).register_middleware("m", slot="nope")


def test_settings_keep_the_extensions_key(tmp_path):
    settings = CircleSettings(extensions={"sample": {"enabled": False}})
    save_settings(settings, tmp_path)
    assert load_settings(tmp_path).extensions == {"sample": {"enabled": False}}


def test_system_prompt_lists_extension_tools():
    prompt = build_system_prompt(extension_tools=[("echo_ro", "Echo the arguments back")])
    assert "Extension tools:\n- echo_ro: Echo the arguments back" in prompt


def _app(tmp_path: Path, monkeypatch, responses) -> CircleSessionApp:
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    TrustController(init.settings, ws, home=home).confirm()
    model = ScriptedModel(responses=responses)
    return CircleSessionApp(init.settings, ws, home=home, model_override=model)


def _wait_idle(app: CircleSessionApp, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    time.sleep(0.2)
    while (app._bridge.is_running or app._is_loading) and time.time() < deadline:  # noqa: SLF001
        time.sleep(0.05)


def test_session_wires_commands_renderers_and_events(tmp_path, monkeypatch):
    home = tmp_path / "home"
    log = tmp_path / "events.log"
    _ext(home / "extensions", "sample", SAMPLE + f'''
    def on_event(payload):
        with open({str(log)!r}, "a", encoding="utf-8") as f:
            f.write(sorted(payload)[0] + "\\n")
    api.on("turn_start", on_event)
    api.on("tool_result", on_event)
    api.register_renderer("tool_result:echo_ro", lambda update: ["ECHO-CARD " + update.tool_name])
    api.register_command("hello", "Say hello", lambda args, ctx: ctx.toast("hello " + args))
''')
    app = _app(tmp_path, monkeypatch, [_call("echo_ro", {"x": 1}), AIMessage(content="done")])
    snapshot = lambda: "\n".join(app._transcript.snapshot())  # noqa: E731, SLF001

    app._on_submit("/extensions")  # noqa: SLF001
    assert "sample（用户）— 工具 3 · 命令 1" in snapshot()
    app._on_submit("/hello world")  # noqa: SLF001
    assert "hello world" in snapshot()
    app._on_submit("/help")  # noqa: SLF001
    assert "/hello" in snapshot()

    app._on_submit("run the echo")  # noqa: SLF001
    _wait_idle(app)
    assert "ECHO-CARD echo_ro" in snapshot()
    assert log.read_text(encoding="utf-8").split() == ["text", "output"]

    (home / "extensions" / "sample" / "extension.py").write_text(
        "def register(api):\n    pass\n", encoding="utf-8")
    app._on_submit("/extensions reload")  # noqa: SLF001
    assert "扩展已重载，工具 0 个" in snapshot()


def test_loading_a_skill_no_longer_runs_its_scripts(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, [AIMessage(content="ok")])
    marker = tmp_path / "ran"
    skill = tmp_path / "ws" / ".circle" / "skills" / "linky"
    (skill / "scripts").mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: linky\ndescription: test skill\n---\nbody\n",
                                    encoding="utf-8")
    (skill / "scripts" / "link_status.py").write_text(
        f"open({str(marker)!r}, 'w').write('x')\n", encoding="utf-8")
    app._on_submit("/skill linky")  # noqa: SLF001
    time.sleep(1.0)
    assert "已加载 skill `linky`" in "\n".join(app._transcript.snapshot())  # noqa: SLF001
    assert not marker.exists(), "skills must not execute bundled scripts on load"


def _skills_root() -> Path | None:
    root = Path(os.environ.get("CEX_SKILLS_ROOT")
                or Path(__file__).resolve().parents[2] / "compile-excel-skills")
    return root if (root / "install.py").is_file() else None


def test_real_compile_excel_extension_through_its_installer(tmp_path):
    skills = _skills_root()
    if skills is None:
        pytest.skip("no compile-excel-skills checkout next to circle (set CEX_SKILLS_ROOT)")
    home = tmp_path / "home"
    env = {k: v for k, v in os.environ.items() if k not in ("CEX_HOME", "CEX_WORKSPACE")}
    env.update(HOME=str(home), CIRCLE_HOME=str(home / ".circle"), CEX_PYTHON=sys.executable)
    proc = subprocess.run([sys.executable, str(skills / "install.py"), "--harness", "circle"],
                          capture_output=True, text=True, timeout=600, env=env)
    report = json.loads(proc.stdout)
    assert report["harnesses"]["circle"]["ok"], report
    ws = tmp_path / "project"
    ws.mkdir()
    host = _host(home / ".circle", ws)
    names = {t.name for t in host.tool_specs()}
    specs = json.loads((skills / "cex_client" / "tool_specs.json").read_text(encoding="utf-8"))
    assert names == {t["name"] for t in specs["tools"]}
    assert "cex_status" not in host.interrupt_on() and host.interrupt_on()["cex_init"] is True

    model = ScriptedModel(responses=[_call("cex_status", {"workspace": str(ws)}),
                                     AIMessage(content="done")])
    agent = create_harness(model, root_dir=ws, home=home / ".circle", extensions=host)
    result, _ = _run(agent)
    msg = next(m for m in result["messages"] if isinstance(m, ToolMessage))
    assert msg.name == "cex_status" and msg.status == "error"
    assert "No workspace here" in msg.content
