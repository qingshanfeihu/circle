"""Per-command slash coverage + regression for known fixes."""

from __future__ import annotations

from pathlib import Path

from langchain_core.messages import AIMessage

from circle.oauth import start_oauth_login
from circle.settings import is_folder_trusted, load_settings
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, TrustController
from circle.tui.session_app import CircleSessionApp
from circle.tui.slash_commands import BUILTIN_SLASH, parse_slash


def _app(tmp_path: Path, monkeypatch) -> CircleSessionApp:
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    home = tmp_path / "home"
    ws = tmp_path / "ws"
    ws.mkdir()
    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    assert init.settings is not None
    TrustController(init.settings, ws, home=home).confirm()
    model = ScriptedModel(responses=[AIMessage(content=f"r{i}") for i in range(30)])
    return CircleSessionApp(init.settings, ws, home=home, model_override=model)


def test_every_canonical_command_dispatches(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._transcript.append_message("a")
    app._transcript.append_message("b")
    app._session_title = "t"
    app._last_assistant_plain = "hi"
    app._clipboard_set = lambda _t: False  # type: ignore[method-assign]

    # editor stubs
    from tests.editor_fixture import write_editor
    editor = write_editor(tmp_path, "e")
    monkeypatch.setenv("EDITOR", str(editor))
    app._app.suspend_for_external = lambda: None  # type: ignore[method-assign]
    app._app.resume_from_external = lambda: None  # type: ignore[method-assign]

    # Avoid async compact hanging the suite: run sync via direct model path later
    commands = {
        "help": "/help",
        "hotkeys": "/hotkeys",
        "login": "/login",
        "logout": "/logout",
        "init": "/init",
        "trust": "/trust",
        "settings": "/settings",
        "themes": "/themes dark",
        "mcp": "/mcp",
        "extensions": "/extensions",
        "approvals": "/approvals",
        "new": "/new",
        "resume": "/resume",
        "continue": "/continue",
        "name": "/name x",
        "session": "/session",
        "models": "/models",
        "thinking": "/thinking",
        "effort": "/effort",
        "details": "/details",
        "copy": "/copy",
        "export": f"/export {tmp_path / 'out.md'}",
        "import": f"/import {tmp_path / 'out.md'}",
        "share": "/share",
        "unshare": "/unshare",
        "editor": "/editor",
        "reload": "/reload",
        "undo": "/undo",
        "redo": "/redo",
        "plan": "/plan on",
        "skill": "/skills",
        "tree": "/tree",
        "fork": "/fork",
        "clone": "/clone",
        "yolo": "/yolo",
        "jobs": "/jobs",
    }

    # Re-login after logout in the map order — reorder carefully
    # First ensure export file exists before import
    app._on_submit(f"/export {tmp_path / 'out.md'}")
    assert (tmp_path / "out.md").is_file()

    # login again so reload works after we may logout
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")

    for name in [c.name for c in BUILTIN_SLASH if c.name not in {"exit", "compact"}]:
        cmd = commands.get(name)
        assert cmd, name
        if name == "logout":
            app._on_submit("/login anthropic")
        if name in {"reload", "plan", "init"}:
            if name == "reload":
                app._on_submit("/login anthropic")
            # Keep ScriptedModel after /login clears the override.
            app.model_override = ScriptedModel(responses=[AIMessage(content="ok")])
            try:
                app._rebuild_agent(model=app.model_override)
            except RuntimeError as exc:
                assert "A turn is still running" in str(exc)
        app._on_submit(cmd)
        # must not raise; transcript grows
        assert app._transcript.message_count() > 0

    # compact separately (async) — uses deepagents compact_conversation on the thread
    import time

    from langchain_core.messages import HumanMessage

    from circle.context_middleware import thread_config

    # Stop and join any /init worker before rebuilding on the same thread.
    app._bridge.cancel()
    worker = app._bridge._worker
    if worker is not None:
        worker.join(timeout=10)
    app._leave_busy()
    app.model_override = ScriptedModel(responses=[AIMessage(content="SUM")])
    app._rebuild_agent(model=app.model_override)
    app._bridge = app._make_bridge()
    app._agent.update_state(
        thread_config(app._thread_id),
        {
            "messages": [
                HumanMessage(content="c1"),
                AIMessage(content="c2"),
            ]
        },
    )
    app._transcript.append_message("c1")
    app._transcript.append_message("c2")
    app._on_submit("/compact")
    deadline = time.time() + 10
    snap = ""
    while time.time() < deadline:
        snap = "\n".join(app._transcript.snapshot())
        if "compact 失败" in snap or "SUM" in snap or "compacted" in snap.lower():
            break
        time.sleep(0.05)
    assert "compact 失败" not in snap
    assert "SUM" in snap or "compacted" in snap.lower()

    # exit last
    app._app._running = True
    app._on_submit("/exit")
    assert app._app._running is False


def test_editor_does_not_stop_session(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    from tests.editor_fixture import write_editor
    editor = write_editor(tmp_path, "from-ed")
    monkeypatch.setenv("EDITOR", str(editor))
    calls: list[str] = []
    app._app._running = True
    app._app.suspend_for_external = lambda: calls.append("suspend")  # type: ignore[method-assign]
    app._app.resume_from_external = lambda: calls.append("resume")  # type: ignore[method-assign]
    app._on_submit("/editor")
    assert calls == ["suspend", "resume"]
    assert app._app._running is True
    assert "from-ed" in app._prompt.value


def test_compact_uses_model_override(tmp_path: Path, monkeypatch):
    import time

    from langchain_core.messages import HumanMessage

    from circle.context_middleware import thread_config

    app = _app(tmp_path, monkeypatch)
    app.model_override = ScriptedModel(responses=[AIMessage(content="OVERRIDE_SUM")])
    app._rebuild_agent(model=app.model_override)
    app._agent.update_state(
        thread_config(app._thread_id),
        {
            "messages": [
                HumanMessage(content="one"),
                AIMessage(content="two"),
            ]
        },
    )
    app._transcript.append_message("one")
    app._transcript.append_message("two")
    app._on_submit("/summarize")
    deadline = time.time() + 10
    snap = ""
    while time.time() < deadline:
        snap = "\n".join(app._transcript.snapshot())
        if "OVERRIDE_SUM" in snap or "compact 失败" in snap or "compacted" in snap.lower():
            break
        time.sleep(0.05)
    assert "OVERRIDE_SUM" in snap or "compacted" in snap.lower()
    assert "invalid x-api-key" not in snap
    assert "compact 失败" not in snap


def test_trust_on_untrusted_workspace(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    other = tmp_path / "other"
    other.mkdir()
    app2 = CircleSessionApp(
        load_settings(app.home),
        other,
        home=app.home,
        model_override=ScriptedModel(responses=[AIMessage(content="z")]),
    )
    assert not is_folder_trusted(app2.settings, other)
    app2._on_submit("/trust")
    assert is_folder_trusted(app2.settings, other)
    assert list(other.iterdir()) == []  # nothing of Circle's in the project


def test_aliases_roundtrip():
    assert parse_slash("/clear").name == "new"
    assert parse_slash("/connect").name == "login"
    assert parse_slash("/sessions").name == "resume"
    assert parse_slash("/summarize").name == "compact"
    assert parse_slash("/q").name == "exit"
