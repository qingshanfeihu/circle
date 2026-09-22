"""Headless selftest: OAuth, API URL+KEY, TUI screens, sandbox permission."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from circle.harness import sandbox_backend
from circle.oauth import start_oauth_login
from circle.paths import project_agent_dir, settings_path
from circle.probe import ProbeResult
from circle.settings import load_settings
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, InitStep, TrustController
from circle.tui.session import MainController, _message_text


def _snap(lines: list[str]) -> str:
    return "\n".join(lines)


def _wait_phase(main: MainController, *phases: str, timeout: float = 5.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if main.phase in phases:
            if main._worker is not None:  # noqa: SLF001
                main._worker.join(timeout=max(0.0, deadline - time.time()))
            return
        time.sleep(0.02)
    raise AssertionError(f"phase still {main.phase!r}, want one of {phases}")


def test_api_key_init_flow_renders_and_saves(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("CIRCLE_HOME", str(home))

    def fake_probe(url: str, key: str):
        assert url == "https://gateway.example"
        assert key == "sk-live"
        return ProbeResult(protocol="openai", models=["gpt-test-a", "gpt-test-b"])

    ctl = InitController(home=home, probe=fake_probe)
    assert "API URL + KEY" in _snap(ctl.body_lines())

    ctl.submit_line("1")
    assert ctl.step == InitStep.API_URL
    ctl.submit_line("https://gateway.example")
    assert ctl.step == InitStep.API_KEY
    ctl.submit_line("sk-live")
    assert ctl.step == InitStep.PICK_MODEL
    body = _snap(ctl.body_lines())
    assert "检测到" in body
    assert "gpt-test-a" in body
    ctl.move(1)
    ctl.confirm()
    assert ctl.done
    assert ctl.settings is not None
    assert ctl.settings.auth.model == "gpt-test-b"
    assert settings_path(home).is_file()
    reloaded = load_settings(home)
    assert reloaded.auth.base_url == "https://gateway.example"
    assert reloaded.auth.protocol == "openai"


def test_oauth_init_flow_with_mock(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")

    ctl = InitController(home=home, oauth_login=start_oauth_login)
    ctl.submit_line("2")
    assert ctl.step == InitStep.OAUTH_PROVIDER
    assert "OAuth" in _snap(ctl.body_lines())
    ctl.confirm()
    assert ctl.step == InitStep.PICK_MODEL
    body = _snap(ctl.body_lines())
    assert "claude-mock" in body
    ctl.confirm()
    assert ctl.done
    assert ctl.settings is not None
    assert ctl.settings.auth.mode == "oauth"
    assert ctl.settings.auth.oauth_provider == "anthropic"
    assert ctl.settings.auth.model.startswith("claude-mock")


def test_trust_screen_creates_agent_and_renders(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    ws = tmp_path / "project"
    ws.mkdir()
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")

    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    assert init.settings is not None

    trust = TrustController(init.settings, ws, home=home)
    body = _snap(trust.body_lines())
    assert "Trust" in body
    assert str(ws.resolve()) in body
    trust.confirm()
    assert trust.accepted
    assert project_agent_dir(ws).is_dir()
    assert (project_agent_dir(ws) / "settings.json").is_file()


def test_main_controller_io_and_exit(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")

    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    settings = init.settings
    assert settings is not None
    TrustController(settings, ws, home=home).confirm()

    model = ScriptedModel(responses=[AIMessage(content="hello from circle")])
    main = MainController(settings, ws, home=home, model_override=model)
    assert "Circle" in _snap(main.body_lines())
    main.submit_user("hi")
    _wait_phase(main, "idle", "exited")
    body = _snap(main.body_lines())
    assert "hi" in body
    assert "hello from circle" in body
    main.submit_user("/exit")
    assert main.phase == "exited"


def test_sandbox_path_guard_still_enforced(tmp_path: Path):
    backend = sandbox_backend(tmp_path)
    written = backend.write("/note.txt", "ok")
    assert written.error is None
    with pytest.raises(ValueError, match="Path traversal"):
        backend.read("/../note.txt")


def test_permission_interrupt_approve_writes_file(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")

    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    settings = init.settings
    assert settings is not None
    TrustController(settings, ws, home=home).confirm()

    tool_call = {
        "name": "write_file",
        "args": {"file_path": "/sandbox.txt", "content": "trusted"},
        "id": "call_write_1",
        "type": "tool_call",
    }
    model = ScriptedModel(
        responses=[
            AIMessage(content="", tool_calls=[tool_call]),
            AIMessage(content="wrote sandbox.txt"),
        ]
    )
    main = MainController(settings, ws, home=home, model_override=model)
    main.submit_user("please write a file")
    _wait_phase(main, "approval")

    assert main.phase == "approval"
    assert main.approval is not None
    body = _snap(main.body_lines())
    assert "Permission" in body or "write_file" in body
    approval_lines = main.approval.render_lines()
    assert any("Allow once" in ln for ln in approval_lines)

    main.confirm_approval()
    _wait_phase(main, "idle")
    assert (ws / "sandbox.txt").read_text(encoding="utf-8") == "trusted"
    final = _snap(main.body_lines())
    assert "批准" in final
    assert "wrote sandbox.txt" in final
    assert main.phase == "idle"


def test_message_text_strips_thinking_blocks():
    content = [
        {
            "type": "thinking",
            "thinking": "secret chain",
            "signature": "sig",
        },
        {"type": "text", "text": "Hi. What do you want to work on?"},
    ]
    assert _message_text(content) == "Hi. What do you want to work on?"
