"""Behavioral coverage for every built-in slash command.

Unlike dispatch-only smoke, each test asserts observable state / transcript
effects so regressions in /plan boundaries, /skill checkpointer inject,
/compact same-thread, session lifecycle, etc. are caught.
"""

from __future__ import annotations

import time
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage

from circle.context_middleware import thread_config
from circle.oauth import start_oauth_login
from circle.settings import is_folder_trusted, load_credentials, load_settings
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, TrustController
from circle.tui.session_app import CircleSessionApp
from circle.tui.slash_commands import BUILTIN_SLASH, ALIAS_TO_CANONICAL, parse_slash


def _app(tmp_path: Path, monkeypatch, *, responses: list | None = None) -> CircleSessionApp:
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
    model = ScriptedModel(
        responses=responses or [AIMessage(content=f"r{i}") for i in range(40)]
    )
    return CircleSessionApp(init.settings, ws, home=home, model_override=model)


def _snap(app: CircleSessionApp) -> str:
    return "\n".join(app._transcript.snapshot())  # noqa: SLF001


def _wait_idle(app: CircleSessionApp, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not app._is_loading and not app._bridge.is_running:  # noqa: SLF001
            return
        time.sleep(0.05)


def test_builtin_slash_inventory_complete():
    """Every canonical name + alias is parseable and listed in help."""
    names = {c.name for c in BUILTIN_SLASH}
    assert names == {
        "help",
        "hotkeys",
        "login",
        "logout",
        "init",
        "trust",
        "settings",
        "themes",
        "mcp",
        "new",
        "resume",
        "continue",
        "name",
        "session",
        "models",
        "compact",
        "plan",
        "skill",
        "tree",
        "fork",
        "clone",
        "undo",
        "redo",
        "thinking",
        "details",
        "copy",
        "export",
        "import",
        "share",
        "unshare",
        "editor",
        "reload",
        "exit",
        "yolo",
    }
    for alias, canon in ALIAS_TO_CANONICAL.items():
        p = parse_slash(f"/{alias}")
        assert p is not None and p.name == canon


def test_help_and_hotkeys(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/help")  # noqa: SLF001
    snap = _snap(app)
    for needle in ("/plan", "/skill", "/tree", "/fork", "/compact", "/mcp", "/import"):
        assert needle in snap
    app._on_submit("/hotkeys")  # noqa: SLF001
    assert "ctrl+c" in _snap(app).lower() or "Keyboard" in _snap(app)


def test_session_lifecycle_new_resume_continue(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._session_title = "alpha"  # noqa: SLF001
    app._transcript.append_message("hello-alpha")  # noqa: SLF001
    tid1 = app._thread_id  # noqa: SLF001

    app._on_submit("/new")  # noqa: SLF001
    tid2 = app._thread_id  # noqa: SLF001
    assert tid2 != tid1
    assert "hello-alpha" not in _snap(app)

    app._on_submit("/resume")  # noqa: SLF001
    assert "会话" in _snap(app) or tid1 in _snap(app) or "alpha" in _snap(app)

    app._on_submit(f"/resume {tid1}")  # noqa: SLF001
    assert app._thread_id == tid1  # noqa: SLF001
    assert "hello-alpha" in _snap(app)

    app._on_submit("/continue")  # noqa: SLF001
    # continue resumes previous when archived
    assert app._thread_id in {tid1, tid2}  # noqa: SLF001


def test_name_session_settings_themes(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/name live-title")  # noqa: SLF001
    assert app._session_title == "live-title"  # noqa: SLF001

    app._on_submit("/session")  # noqa: SLF001
    snap = _snap(app)
    assert app._thread_id in snap  # noqa: SLF001
    assert "live-title" in snap

    app._on_submit("/settings")  # noqa: SLF001
    assert "model=" in _snap(app) or "protocol=" in _snap(app)

    app._on_submit("/themes")  # noqa: SLF001
    assert "主题" in _snap(app) or "theme" in _snap(app).lower()
    app._on_submit("/themes dark")  # noqa: SLF001
    assert app.settings.theme == "dark"
    assert load_settings(app.home).theme == "dark"


def test_thinking_details_toggles(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    before_t = app._show_thinking  # noqa: SLF001
    app._on_submit("/thinking")  # noqa: SLF001
    assert app._show_thinking is not before_t  # noqa: SLF001
    before_d = app._tool_outputs_expanded  # noqa: SLF001
    app._on_submit("/details")  # noqa: SLF001
    assert app._tool_outputs_expanded is not before_d  # noqa: SLF001


def test_plan_injects_checkpointer_boundary(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app.model_override = ScriptedModel(responses=[AIMessage(content="ok")])
    app._rebuild_agent(model=app.model_override)  # noqa: SLF001

    assert app._plan_mode is False  # noqa: SLF001
    app._on_submit("/plan on")  # noqa: SLF001
    assert app._plan_mode is True  # noqa: SLF001
    st = app._agent.get_state(thread_config(app._thread_id))  # noqa: SLF001
    texts = [str(getattr(m, "content", "")) for m in (st.values.get("messages") or [])]
    assert any("Plan mode is now ON" in t for t in texts)

    app._on_submit("/plan off")  # noqa: SLF001
    assert app._plan_mode is False  # noqa: SLF001
    st = app._agent.get_state(thread_config(app._thread_id))  # noqa: SLF001
    texts = [str(getattr(m, "content", "")) for m in (st.values.get("messages") or [])]
    assert any("Plan mode is now OFF" in t for t in texts)


def test_skill_list_and_load_into_checkpointer(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    skill_dir = app.workspace / ".agents" / "skills" / "slash-demo"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: slash-demo\ndescription: demo\n---\n\n# Demo\nSay SLASH_SKILL_OK\n",
        encoding="utf-8",
    )

    app._on_submit("/skill")  # noqa: SLF001
    assert "slash-demo" in _snap(app)

    app._on_submit("/skill:slash-demo arg1")  # noqa: SLF001
    assert "已加载" in _snap(app) or "slash-demo" in _snap(app)
    st = app._agent.get_state(thread_config(app._thread_id))  # noqa: SLF001
    texts = [str(getattr(m, "content", "")) for m in (st.values.get("messages") or [])]
    assert any("Skill `slash-demo`" in t for t in texts)
    assert any("SLASH_SKILL_OK" in t for t in texts)
    assert any("arg1" in t for t in texts)


def test_tree_fork_clone(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._session_tree.add("user", "u1")  # noqa: SLF001
    app._session_tree.add("assistant", "a1")  # noqa: SLF001
    tip = app._session_tree.active_id  # noqa: SLF001
    assert tip

    app._on_submit("/tree")  # noqa: SLF001
    assert tip in _snap(app) or "u1" in _snap(app)

    tid_before = app._thread_id  # noqa: SLF001
    app._on_submit("/clone")  # noqa: SLF001
    assert "clone" in _snap(app).lower()
    assert app._thread_id != tid_before  # noqa: SLF001

    tip2 = app._session_tree.active_id  # noqa: SLF001
    tid_mid = app._thread_id  # noqa: SLF001
    app._on_submit(f"/fork {tip2}")  # noqa: SLF001
    assert "fork" in _snap(app).lower()
    assert app._thread_id != tid_mid  # noqa: SLF001


def test_export_import_share_unshare_copy(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._transcript.append_message("export-me")  # noqa: SLF001
    app._last_assistant_plain = "copy-me"  # noqa: SLF001
    copied: list[str] = []
    app._clipboard_set = lambda t: copied.append(t) or True  # type: ignore[method-assign]  # noqa: SLF001

    out = tmp_path / "roundtrip.md"
    app._on_submit(f"/export {out}")  # noqa: SLF001
    assert out.is_file()
    assert "export-me" in out.read_text(encoding="utf-8")

    app._on_submit("/copy")  # noqa: SLF001
    assert copied and "copy-me" in copied[-1]

    app._on_submit("/share")  # noqa: SLF001
    assert app._share_path is not None and app._share_path.is_file()  # noqa: SLF001
    share = app._share_path  # noqa: SLF001
    app._on_submit("/unshare")  # noqa: SLF001
    assert app._share_path is None  # noqa: SLF001
    assert not share.is_file()

    app._on_submit(f"/import {out}")  # noqa: SLF001
    assert "已导入" in _snap(app)
    st = app._agent.get_state(thread_config(app._thread_id))  # noqa: SLF001
    texts = [str(getattr(m, "content", "")) for m in (st.values.get("messages") or [])]
    assert any("Imported prior transcript" in t for t in texts)


def test_undo_redo(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._push_undo_checkpoint()  # noqa: SLF001
    app._transcript.append_message("after-checkpoint")  # noqa: SLF001
    app._on_submit("/undo")  # noqa: SLF001
    assert "after-checkpoint" not in _snap(app)
    app._on_submit("/redo")  # noqa: SLF001
    assert "after-checkpoint" in _snap(app)


def test_mcp_list_and_reload(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app.model_override = ScriptedModel(responses=[AIMessage(content="ok")])
    app._on_submit("/mcp")  # noqa: SLF001
    assert "MCP" in _snap(app) or "mcp" in _snap(app).lower() or "server" in _snap(app).lower()
    app._rebuild_agent(model=app.model_override)  # noqa: SLF001
    app._on_submit("/mcp reload")  # noqa: SLF001
    assert "重载" in _snap(app) or "MCP" in _snap(app)


def test_models_list(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/models")  # noqa: SLF001
    assert "模型" in _snap(app) or "model" in _snap(app).lower()


def test_trust_and_reload(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/trust")  # noqa: SLF001
    assert is_folder_trusted(app.settings, app.workspace)
    assert "信任" in _snap(app)

    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    app._on_submit("/login anthropic")  # noqa: SLF001
    app.model_override = ScriptedModel(responses=[AIMessage(content="ok")])
    app._rebuild_agent(model=app.model_override)  # noqa: SLF001
    app._on_submit("/reload")  # noqa: SLF001
    assert "重新加载" in _snap(app) or "reload" in _snap(app).lower()


def test_login_logout(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/login anthropic")  # noqa: SLF001
    assert load_credentials(app.home).get("oauth_access_token")
    app._on_submit("/logout")  # noqa: SLF001
    assert load_credentials(app.home) == {}


def test_compact_same_thread(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app.model_override = ScriptedModel(responses=[AIMessage(content="COMPACT_OK")])
    app._rebuild_agent(model=app.model_override)  # noqa: SLF001
    tid = app._thread_id  # noqa: SLF001
    app._agent.update_state(  # noqa: SLF001
        thread_config(tid),
        {"messages": [HumanMessage(content="a"), AIMessage(content="b")]},
    )
    app._on_submit("/compact")  # noqa: SLF001
    deadline = time.time() + 8
    while time.time() < deadline:
        if "compacted" in _snap(app).lower() or "COMPACT_OK" in _snap(app):
            break
        time.sleep(0.05)
    assert app._thread_id == tid  # noqa: SLF001  — same thread, no DIY wipe
    assert "compacted" in _snap(app).lower() or "COMPACT_OK" in _snap(app)


def test_exit(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._app._running = True  # noqa: SLF001
    app._on_submit("/exit")  # noqa: SLF001
    assert app._app._running is False  # noqa: SLF001


def test_editor(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    editor = tmp_path / "ed.sh"
    editor.write_text("#!/bin/sh\nprintf 'edited\\n' > \"$1\"\n", encoding="utf-8")
    editor.chmod(0o755)
    monkeypatch.setenv("EDITOR", str(editor))
    app._app.suspend_for_external = lambda: None  # type: ignore[method-assign]  # noqa: SLF001
    app._app.resume_from_external = lambda: None  # type: ignore[method-assign]  # noqa: SLF001
    app._on_submit("/editor")  # noqa: SLF001
    assert "edited" in app._prompt.value  # noqa: SLF001


def test_init_starts_agent_turn(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/init")  # noqa: SLF001
    # initialize template is submitted as a user turn
    assert "AGENTS.md" in _snap(app)
    _wait_idle(app)
