"""CLI gate behaviour without entering the interactive main loop."""

from __future__ import annotations

from pathlib import Path

from circle.cli import main
from circle.init_flow import complete_api_key_init
from circle.probe import ProbeResult
from circle.trust import accept_trust


def test_version_and_print_home(tmp_path: Path, monkeypatch, capsys):
    monkeypatch.setenv("CIRCLE_HOME", str(tmp_path))
    assert main(["--version"]) == 0
    assert "0.1.0" in capsys.readouterr().out
    assert main(["--print-home"]) == 0
    assert str(tmp_path.resolve()) in capsys.readouterr().out


def test_non_tty_uninitialized_exits_2(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CIRCLE_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CIRCLE_NO_TUI", "1")
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    monkeypatch.setattr("sys.stdout.isatty", lambda: False)
    assert main(["--line", str(tmp_path)]) == 2


def test_non_tty_untrusted_exits_2(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    workspace.mkdir()
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    monkeypatch.setenv("CIRCLE_NO_TUI", "1")
    complete_api_key_init(
        base_url="https://api.example.com",
        api_key="sk",
        model="m1",
        home=home,
        probe=lambda *_a, **_k: ProbeResult(protocol="openai", models=["m1"]),
    )
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    monkeypatch.setattr("sys.stdout.isatty", lambda: False)
    assert main(["--line", str(workspace)]) == 2


def test_trusted_workspace_reaches_main(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    workspace = tmp_path / "ws"
    workspace.mkdir()
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    monkeypatch.setenv("CIRCLE_NO_TUI", "1")
    settings = complete_api_key_init(
        base_url="https://api.example.com",
        api_key="sk",
        model="m1",
        home=home,
        probe=lambda *_a, **_k: ProbeResult(protocol="openai", models=["m1"]),
    )
    accept_trust(settings, workspace, home=home)

    called: dict[str, object] = {}

    def fake_main(settings_arg, workspace_arg, *, home=None):
        called["settings"] = settings_arg
        called["workspace"] = workspace_arg
        return 0

    monkeypatch.setattr("circle.main_session.run_main", fake_main)
    assert main(["--line", str(workspace)]) == 0
    assert Path(called["workspace"]) == workspace.resolve()
