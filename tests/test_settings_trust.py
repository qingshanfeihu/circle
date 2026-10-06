"""User settings and the trust gate."""

from __future__ import annotations

from pathlib import Path

from circle.init_flow import complete_api_key_init
from circle.paths import credentials_path, project_agent_dir, settings_path
from circle.probe import ProbeResult
from circle.settings import is_folder_trusted, load_settings
from circle.trust import accept_trust


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


def test_trust_is_saved_in_settings_and_writes_nothing_into_the_folder(tmp_path: Path):
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
    # Trust is kept in the user's settings; the project gets no files of Circle's
    assert not project_agent_dir(workspace).exists()
    assert list(workspace.iterdir()) == []
    assert is_folder_trusted(accept_trust(updated, workspace, home=home), workspace)  # again
    reloaded = load_settings(home)
    assert is_folder_trusted(reloaded, workspace)


def test_setup_saves_the_url_the_probe_found(tmp_path: Path):
    from circle.tui.controllers import InitController

    found = ProbeResult(protocol="openai", models=["step-3.7-flash"],
                        base_url="https://api.example.com/step_plan/v1")
    settings = complete_api_key_init(base_url="https://api.example.com/step_plan",
                                     api_key="sk-test", home=tmp_path / "a",
                                     probe=lambda *_a, **_k: found)
    assert settings.auth.base_url == "https://api.example.com/step_plan/v1"

    screen = InitController(home=tmp_path / "b", probe=lambda *_a, **_k: found)
    screen.confirm()
    screen.submit_line("https://api.example.com/step_plan")
    screen.submit_line("sk-test")
    screen.confirm()
    assert screen.done
    assert load_settings(tmp_path / "b").auth.base_url == "https://api.example.com/step_plan/v1"


def test_line_setup_takes_a_typed_model_but_only_listed_providers(monkeypatch, capsys):
    from circle import init_flow

    answers = iter(["github", "1"])
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(answers))
    assert init_flow._pick("Sign in with:", ["anthropic", "openai"]) == "anthropic"
    assert "Pick one of the numbers." in capsys.readouterr().out
    answers = iter(["step-3.7-flash"])
    assert init_flow._pick("Model:", ["gpt-4o"], other=True) == "step-3.7-flash"


# ── setting up again (circle --init) ──────────────────────────────────────


def _set_up_once(home: Path, workspace: Path) -> None:
    import json

    first = ProbeResult(protocol="openai", models=["m1", "m2"], base_url="https://one.example/v1")
    settings = complete_api_key_init(base_url="https://one.example/v1", api_key="sk-first",
                                     model="m1", home=home, probe=lambda *_a, **_k: first)
    workspace.mkdir(exist_ok=True)
    settings = accept_trust(settings, workspace, home=home)
    raw = json.loads(settings_path(home).read_text())
    raw.update(theme="light", mcp_servers=[{"name": "docs", "url": "https://mcp.example"}],
               enabled_models=["m1", "m2"], my_own_note="keep me")
    settings_path(home).write_text(json.dumps(raw))


def test_setting_up_again_keeps_everything_but_the_connection(tmp_path: Path):
    import json

    from circle.tui.controllers import InitController

    home, workspace = tmp_path / "home", tmp_path / "proj"
    _set_up_once(home, workspace)
    other = ProbeResult(protocol="openai", models=["x1"], base_url="https://two.example/v1")
    screen = InitController(home=home, probe=lambda *_a, **_k: other)
    screen.confirm()
    screen.submit_line("https://two.example/v1")
    screen.submit_line("sk-second")
    screen.confirm()
    assert screen.done
    settings = load_settings(home)
    assert (settings.auth.base_url, settings.auth.model) == ("https://two.example/v1", "x1")
    assert is_folder_trusted(settings, workspace)
    assert settings.theme == "light" and settings.mcp_servers[0]["name"] == "docs"
    assert settings.enabled_models == []  # the old endpoint's models
    assert json.loads(settings_path(home).read_text())["my_own_note"] == "keep me"
    assert json.loads(credentials_path(home).read_text())["api_key"] == "sk-second"


def test_enter_keeps_the_saved_url_and_key(tmp_path: Path):
    import json

    from circle.tui.controllers import InitController, InitStep

    home, workspace = tmp_path / "home", tmp_path / "proj"
    _set_up_once(home, workspace)
    asked: list[tuple[str, str]] = []

    def probe(url: str, key: str) -> ProbeResult:
        asked.append((url, key))
        return ProbeResult(protocol="openai", models=["m2", "m1"], base_url=url)

    screen = InitController(home=home, probe=probe)
    screen.confirm()
    assert screen.step == InitStep.API_URL
    assert "enter keeps https://one.example/v1" in screen.body_lines()
    screen.submit_line("")
    assert screen.step == InitStep.API_KEY
    assert "enter keeps the saved key" in screen.body_lines()
    assert "sk-first" not in "\n".join(screen.body_lines())
    screen.submit_line("")
    assert asked == [("https://one.example/v1", "sk-first")]
    screen.confirm()
    settings = load_settings(home)
    assert settings.auth.model == "m2"
    assert settings.enabled_models == ["m1", "m2"]  # same endpoint: the ctrl+p list stays
    assert json.loads(credentials_path(home).read_text())["api_key"] == "sk-first"


def test_line_setup_keeps_the_saved_url_and_key(tmp_path: Path, monkeypatch, capsys):
    from circle import init_flow

    home, workspace = tmp_path / "home", tmp_path / "proj"
    _set_up_once(home, workspace)
    answers = iter(["", "2"])  # keep the URL; the second model
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(answers))
    monkeypatch.setattr(init_flow.getpass, "getpass", lambda _prompt="": "")
    monkeypatch.setattr(init_flow, "resolve_endpoint", lambda url, key, **_k: ProbeResult(
        protocol="openai", models=["m1", "m2"], base_url=url) if key == "sk-first" else None)
    settings = init_flow._init_api_key(home=home)
    assert (settings.auth.base_url, settings.auth.model) == ("https://one.example/v1", "m2")
    assert is_folder_trusted(load_settings(home), workspace)


def test_a_save_keeps_keys_circle_does_not_know(tmp_path: Path):
    import json

    from circle.settings import save_settings

    settings_path(tmp_path).parent.mkdir(parents=True, exist_ok=True)
    settings_path(tmp_path).write_text(json.dumps({"theme": "dark", "future_option": [1, 2]}))
    settings = load_settings(tmp_path)
    settings.theme = "light"
    save_settings(settings, tmp_path)
    raw = json.loads(settings_path(tmp_path).read_text())
    assert raw["theme"] == "light" and raw["future_option"] == [1, 2]


def test_enter_on_the_setup_screen_keeps_the_saved_url_and_key(tmp_path: Path):
    """The keys, not only the controller: enter on an empty box at the URL and key steps."""
    from circle.ink.parse_keypress import KeyPress
    from circle.tui.app import CircleApp
    from circle.tui.controllers import InitController, InitStep

    home, workspace = tmp_path / "home", tmp_path / "proj"
    _set_up_once(home, workspace)
    app = CircleApp(workspace=workspace, home=home, force_init=True)
    app.init = InitController(home=home, probe=lambda url, key: ProbeResult(
        protocol="openai", models=["m1"], base_url=url) if key == "sk-first" else None)
    app._rebuild()  # noqa: SLF001
    app._on_input(KeyPress(key="enter"))  # noqa: SLF001  API URL + KEY
    assert app.init.step == InitStep.API_URL
    app._on_input(KeyPress(key="enter"))  # noqa: SLF001
    assert app.init.step == InitStep.API_KEY and app.init.base_url == "https://one.example/v1"
    app._on_input(KeyPress(key="enter"))  # noqa: SLF001
    assert app.init.step == InitStep.PICK_MODEL


def test_enter_on_an_empty_box_at_first_setup_says_what_is_missing(tmp_path: Path):
    from circle.ink.parse_keypress import KeyPress
    from circle.tui.app import CircleApp
    from circle.tui.controllers import InitController, InitStep

    app = CircleApp(workspace=tmp_path, home=tmp_path / "home", force_init=True)
    app.init = InitController(home=tmp_path / "home")
    app._rebuild()  # noqa: SLF001
    app._on_input(KeyPress(key="enter"))  # noqa: SLF001
    app._on_input(KeyPress(key="enter"))  # noqa: SLF001
    assert app.init.step == InitStep.API_URL and app.init.error == "Enter a URL"


def test_esc_alone_leaves_the_setup_screen(tmp_path: Path):
    """Terminals send esc as a bare ESC, which also starts every escape sequence: after a
    short wait with nothing following, it is the esc key, and esc leaves setup."""
    import time

    from circle.tui.app import CircleApp
    from circle.tui.controllers import InitController

    app = CircleApp(workspace=tmp_path, home=tmp_path / "home", force_init=True)
    app.init = InitController(home=tmp_path / "home")
    app._ink._running = True  # noqa: SLF001  as if started
    assert app._ink._input_parser.feed("\x1b") == []  # noqa: SLF001  held: maybe a sequence
    deadline = time.monotonic() + 2
    while app._ink._running and time.monotonic() < deadline:  # noqa: SLF001
        time.sleep(0.02)
    assert not app._ink._running  # noqa: SLF001
