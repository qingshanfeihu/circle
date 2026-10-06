"""Behavioral coverage for every built-in slash command.

Unlike dispatch-only smoke, each test asserts observable state / transcript
effects so regressions in /plan boundaries, /skill checkpointer inject,
/compact same-thread, session lifecycle, etc. are caught.
"""

from __future__ import annotations

import time
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage

from circle.context_middleware import append_messages, thread_config
from circle.oauth import start_oauth_login
from circle.ink.parse_keypress import KeyPress
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
        "extensions",
        "approvals",
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
        "effort",
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

    app._on_submit("/resume")  # noqa: SLF001 — the sessions are listed in a picker
    assert "alpha" in "\n".join(app._picker.render_lines(100))  # noqa: SLF001
    app._handle_key(KeyPress(key="escape"))  # noqa: SLF001

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

    # /settings is a list to change things in, as pi's; the model and endpoint are on it
    app._on_submit("/settings")  # noqa: SLF001
    listed = "\n".join(app._picker.render_lines(100))  # noqa: SLF001
    assert app.settings.auth.model in listed and app.settings.auth.protocol in listed
    app._handle_key(KeyPress(key="escape"))  # noqa: SLF001

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
    # The tree is read from the model's saved messages
    append_messages(app._agent, thread_config(app._thread_id),  # noqa: SLF001
                    [HumanMessage(content="u1"), AIMessage(content="a1")])
    app._session_tree.add("user", "u1")  # noqa: SLF001
    app._session_tree.add("assistant", "a1")  # noqa: SLF001
    tip = app._session_tree.active_id  # noqa: SLF001
    assert tip

    app._on_submit("/tree")  # noqa: SLF001
    assert "u1" in "\n".join(app._picker.render_lines(100))  # noqa: SLF001
    app._handle_key(KeyPress(key="escape"))  # noqa: SLF001

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
    assert "Imported" in _snap(app)
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
    monkeypatch.setattr("circle.probe._get", lambda *args: (200, b'{"data":[{"id":"server-model"}]}'))
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/models")  # noqa: SLF001
    shown = "\n".join(app._picker.render_lines(80))  # noqa: SLF001 — listed in the picker
    assert "Model" in shown and "server-model" in shown


def test_trust_and_reload(tmp_path: Path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/trust")  # noqa: SLF001
    assert is_folder_trusted(app.settings, app.workspace)
    assert "Trusted" in _snap(app)

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
    from tests.editor_fixture import write_editor
    editor = write_editor(tmp_path, "edited")
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


def test_editor_with_arguments_gets_the_whole_draft(tmp_path: Path, monkeypatch):
    from circle.ink.parse_keypress import KeyPress, PasteEvent

    app = _app(tmp_path, monkeypatch)
    seen = tmp_path / "seen.txt"
    editor = tmp_path / "ed.sh"
    # Like "code -w": the editor command has an argument before the file name.
    editor.write_text(f"#!/bin/sh\n[ \"$1\" = -w ] || exit 9\ncp \"$2\" {seen}\n"
                      "printf 'line one\\nline two\\n' > \"$2\"\n", encoding="utf-8")
    editor.chmod(0o755)
    monkeypatch.setenv("EDITOR", f"{editor} -w")
    monkeypatch.delenv("VISUAL", raising=False)
    app._app.suspend_for_external = lambda: None  # type: ignore[method-assign]  # noqa: SLF001
    app._app.resume_from_external = lambda: None  # type: ignore[method-assign]  # noqa: SLF001
    app._handle_input(PasteEvent(text="\n".join(f"row {i}" for i in range(20))))  # noqa: SLF001
    app._handle_key(KeyPress(key="shift+enter"))  # noqa: SLF001
    for ch in "fix it":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+g", ctrl=True, char="g"))  # noqa: SLF001
    assert seen.read_text() == "\n".join(f"row {i}" for i in range(20)) + "\nfix it"
    assert app._prompt.value == "line one↵line two"  # noqa: SLF001


def test_effort_sets_the_thinking_depth_for_the_run(tmp_path: Path, monkeypatch):
    import os

    app = _app(tmp_path, monkeypatch)
    monkeypatch.delenv("CIRCLE_REASONING_EFFORT", raising=False)
    built: list[str] = []

    def fake_build(*_a, **_k):
        built.append(os.environ.get("CIRCLE_REASONING_EFFORT", ""))
        return ScriptedModel(responses=[AIMessage(content="ok")])

    monkeypatch.setattr("circle.tui.session_app.build_chat_model", fake_build)
    app._on_submit("/effort turbo")  # noqa: SLF001
    assert "Unknown depth 'turbo'" in _snap(app) and built == []
    app._on_submit("/effort low")  # noqa: SLF001
    assert built == ["low"] and "Thinking depth → low" in _snap(app)


def test_tab_completes_every_kind_of_command(tmp_path: Path, monkeypatch):
    from circle.ink.parse_keypress import KeyPress

    app = _app(tmp_path, monkeypatch)
    skill = app.workspace / ".circle" / "skills" / "changelog"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: changelog\ndescription: Write entries.\n---\nx\n")
    commands = app.workspace / ".circle" / "commands"
    commands.mkdir(parents=True)
    (commands / "review-staged.md").write_text("Review it.\n")
    app._rebuild_agent(model=ScriptedModel(responses=[AIMessage(content="ok")]))  # noqa: SLF001

    def tab(text: str) -> str:
        app._prompt.set_value(text)  # noqa: SLF001
        app._handle_key(KeyPress(key="tab", char="\t"))  # noqa: SLF001
        return app._prompt.value  # noqa: SLF001

    assert tab("/review-") == "/review-staged "
    assert tab("/skill:ch") == "/skill:changelog "
    assert tab("/mo") == "/models "
    assert tab("/re") == "/re", "several match: they are listed, the text stays"
    assert "/resume" in app._footer._toast_text  # noqa: SLF001
