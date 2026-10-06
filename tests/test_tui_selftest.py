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
    assert "discovered 2 models (openai)" in body
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
    assert not project_agent_dir(ws).exists()  # trust writes nothing into the folder


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


def test_setup_is_honest_when_the_endpoint_lists_no_models(tmp_path: Path):
    home = tmp_path / "home"
    failed = ProbeResult(protocol="openai", models=[], inferred=True, status="failed",
                         detail="http 404")
    ctl = InitController(home=home, probe=lambda *_a: failed)
    ctl.submit_line("1")
    ctl.submit_line("https://gateway.example/v1")
    ctl.submit_line("sk-live")
    body = _snap(ctl.body_lines())
    assert "model discovery failed" in body and "http 404" in body
    assert "gpt-4.1" not in body, "no made-up model names"
    ctl.submit_line("1")  # openai
    assert "type the model id your endpoint uses" in _snap(ctl.body_lines())
    ctl.submit_line("step-3.7-flash")
    assert ctl.done and load_settings(home).auth.model == "step-3.7-flash"


def test_the_key_is_dots_while_it_is_typed(tmp_path: Path):
    from circle.ink.app import InkApp
    from circle.ink.components.prompt_input import PromptInput

    prompt = PromptInput(cursor_manager=InkApp(alt_screen=False).cursor, on_submit=lambda _t: None)
    for ch in "sk-secret":
        prompt.handle_key(ch, ch)
    prompt.masked = True
    shown = prompt.node.children[0].value if prompt.node.children else ""
    assert "sk-secret" not in shown and "•••••••••" in shown
    assert prompt.value == "sk-secret"


def test_trust_screen_names_the_real_data_folder(tmp_path: Path):
    from circle.settings import CircleSettings

    trust = TrustController(CircleSettings(), tmp_path, home=tmp_path / "data")
    body = _snap(trust.body_lines())
    assert str(tmp_path / "data" / "settings.json") in body and "~/.circle" not in body
