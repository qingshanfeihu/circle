"""A project's .circle/settings.json sets a few things for that folder, as pi's
.pi/settings.json: in memory only, and never the endpoint, MCP servers or extensions."""

from __future__ import annotations

import json

import pytest

from circle.settings import (
    CircleSettings,
    ModelAuth,
    apply_project_settings,
    load_settings,
    without_project_settings,
)
from tests.test_plan_and_turns import _fake_session


def _project(folder, values):
    (folder / ".circle").mkdir(parents=True, exist_ok=True)
    (folder / ".circle" / "settings.json").write_text(json.dumps(values), encoding="utf-8")


def test_the_project_overlays_and_saving_writes_yours_back(tmp_path):
    _project(tmp_path, {"model": "m2", "default_thinking": "high",
                        "credential_files": ["*.pem"], "mcp_servers": [{"name": "x"}]})
    settings = CircleSettings(auth=ModelAuth(model="m1"), credential_files=[".env"])
    changed, problems = apply_project_settings(settings, tmp_path)
    assert (settings.auth.model, settings.default_thinking) == ("m2", "high")
    assert settings.credential_files == [".env", "*.pem"], "added to yours, never narrowed"
    assert settings.mcp_servers == [] and "'mcp_servers' is not a project setting" in problems[0]
    mine = without_project_settings(settings, changed)
    assert (mine.auth.model, mine.default_thinking, mine.credential_files) == ("m1", "", [".env"])
    settings.default_thinking = "low"  # changed during the session: that stays
    assert without_project_settings(settings, changed).default_thinking == "low"


def test_the_session_uses_them_and_keeps_your_file(tmp_path, monkeypatch):
    real_mkdir = type(tmp_path).mkdir

    def mkdir(self, *args, **kwargs):  # the fake session makes ws; it is there already
        real_mkdir(self, *args, **{**kwargs, "exist_ok": True})

    _project(tmp_path / "ws", {"double_escape": "fork", "hide_thinking": True, "theme": "light"})
    with pytest.MonkeyPatch.context() as only_here:
        only_here.setattr(type(tmp_path), "mkdir", mkdir)
        app = _fake_session(tmp_path, monkeypatch)
    assert app.settings.double_escape == "fork" and app._show_thinking is False  # noqa: SLF001
    app._dispatch_slash("themes", "dark")  # noqa: SLF001
    saved = load_settings(app.home)
    assert saved.theme == "dark", "what you choose is saved as yours"
    assert saved.double_escape == "tree" and not saved.hide_thinking, "the project's stay out"
