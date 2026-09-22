"""User settings, trust gate, and project .agent/ bootstrap."""

from __future__ import annotations

from pathlib import Path

from circle.init_flow import complete_api_key_init
from circle.paths import credentials_path, project_agent_dir, settings_path
from circle.probe import ProbeResult
from circle.settings import is_folder_trusted, load_settings
from circle.trust import accept_trust, ensure_project_agent


def test_complete_api_key_init_writes_home(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CIRCLE_HOME", str(tmp_path / "home"))

    def fake_probe(base_url: str, api_key: str, **_kwargs):
        assert base_url.endswith("example.com")
        assert api_key == "sk-test"
        return ProbeResult(protocol="anthropic", models=["claude-test", "claude-other"])

    settings = complete_api_key_init(
        base_url="https://api.example.com",
        api_key="sk-test",
        home=tmp_path / "home",
        probe=fake_probe,
    )
    assert settings.is_ready()
    assert settings.auth.protocol == "anthropic"
    assert settings.auth.model == "claude-test"
    assert settings_path(tmp_path / "home").is_file()
    assert credentials_path(tmp_path / "home").is_file()
    reloaded = load_settings(tmp_path / "home")
    assert reloaded.auth.model == "claude-test"


def test_trust_creates_agent_dir_and_settings_entry(tmp_path: Path):
    home = tmp_path / "home"
    workspace = tmp_path / "proj"
    workspace.mkdir()
    settings = complete_api_key_init(
        base_url="https://api.example.com",
        api_key="sk-test",
        model="m1",
        home=home,
        probe=lambda *_a, **_k: ProbeResult(protocol="openai", models=["m1"]),
    )
    assert not is_folder_trusted(settings, workspace)
    updated = accept_trust(settings, workspace, home=home)
    assert is_folder_trusted(updated, workspace)
    agent = project_agent_dir(workspace)
    assert agent.is_dir()
    assert (agent / "settings.json").is_file()
    assert (agent / "README.md").is_file()
    # idempotent
    ensure_project_agent(workspace)
    reloaded = load_settings(home)
    assert is_folder_trusted(reloaded, workspace)
