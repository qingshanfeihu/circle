"""Slash command registry."""

from __future__ import annotations

from pathlib import Path

from langchain_core.messages import AIMessage

from circle.oauth import start_oauth_login
from circle.settings import load_credentials, load_settings
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, TrustController
from circle.tui.session_app import CircleSessionApp
from circle.tui.slash_commands import (
    ALIAS_TO_CANONICAL,
    BUILTIN_SLASH,
    help_text,
    parse_slash,
)


def test_parse_aliases():
    assert parse_slash("/clear").name == "new"
    assert parse_slash("/summarize").name == "compact"
    assert parse_slash("/model gpt").name == "models"
    assert parse_slash("/connect").name == "login"
    assert parse_slash("/sessions").name == "resume"
    assert parse_slash("/q").name == "exit"
    assert parse_slash("hello") is None


def test_help_lists_canonical_commands():
    text = help_text()
    for cmd in BUILTIN_SLASH:
        assert f"/{cmd.name}" in text


def test_alias_map_covers_coding_agent_surface():
    expected = {
        "help",
        "hotkeys",
        "login",
        "connect",
        "logout",
        "init",
        "trust",
        "settings",
        "themes",
        "mcp",
        "new",
        "clear",
        "resume",
        "sessions",
        "continue",
        "name",
        "session",
        "models",
        "model",
        "compact",
        "summarize",
        "plan",
        "plan-mode",
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
        "quit",
        "q",
    }
    assert expected <= set(ALIAS_TO_CANONICAL)
    # InfoTest-only stay out
    for banned in ("yolo", "approvals", "kms", "footprint", "engine-debt"):
        assert banned not in ALIAS_TO_CANONICAL


def _ready_session(tmp_path: Path, monkeypatch) -> CircleSessionApp:
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
    model = ScriptedModel(responses=[AIMessage(content="ok")])
    return CircleSessionApp(init.settings, ws, home=home, model_override=model)


def test_slash_core_flows(tmp_path: Path, monkeypatch):
    app = _ready_session(tmp_path, monkeypatch)
    old_tid = app._thread_id  # noqa: SLF001
    app._transcript.append_message("user said hi")  # noqa: SLF001
    app._session_title = "hi"  # noqa: SLF001

    app._on_submit("/help")  # noqa: SLF001
    snap = "\n".join(app._transcript.snapshot())  # noqa: SLF001
    assert "/share" in snap and "/undo" in snap and "/trust" in snap

    app._on_submit("/name demo")  # noqa: SLF001
    assert app._session_title == "demo"  # noqa: SLF001

    app._on_submit("/session")  # noqa: SLF001
    app._on_submit("/settings")  # noqa: SLF001
    app._on_submit("/mcp")  # noqa: SLF001
    app._on_submit("/hotkeys")  # noqa: SLF001

    app._on_submit("/share")  # noqa: SLF001
    assert app._share_path is not None and app._share_path.is_file()  # noqa: SLF001
    app._on_submit("/unshare")  # noqa: SLF001
    assert app._share_path is None  # noqa: SLF001

    app._on_submit("/init")  # noqa: SLF001
    # /init feeds the initialize template to the agent turn.
    snap = "\n".join(app._transcript.snapshot())  # noqa: SLF001
    assert "AGENTS.md" in snap
    assert "Create or update" in snap or "initialize" in snap.lower() or "investigate" in snap.lower()
    # Wait for the /init agent turn to settle before meta commands that mutate session.
    import time

    for _ in range(100):
        if not app._is_loading and not app._bridge.is_running:  # noqa: SLF001
            break
        time.sleep(0.05)

    app._on_submit("/export")  # noqa: SLF001
    exports = list((app.home / "exports").glob("*.md"))
    assert exports

    app._push_undo_checkpoint()  # noqa: SLF001
    app._transcript.append_message("later")  # noqa: SLF001
    app._on_submit("/undo")  # noqa: SLF001
    assert "later" not in "\n".join(app._transcript.snapshot())  # noqa: SLF001

    app._on_submit("/clear")  # noqa: SLF001
    assert app._thread_id != old_tid  # noqa: SLF001

    app._on_submit("/login")  # noqa: SLF001
    app._on_submit("/login anthropic")  # noqa: SLF001
    assert load_credentials(app.home).get("oauth_access_token")
    assert load_settings(app.home).auth.oauth_provider == "anthropic"

    app._on_submit("/logout")  # noqa: SLF001
    assert load_credentials(app.home) == {}
