"""Model builder must respect Circle protocol, not name heuristics."""

from __future__ import annotations

from pathlib import Path

from circle.model import build_chat_model
from circle.settings import CircleSettings, ModelAuth, save_credentials, save_settings


def test_grok_name_uses_settings_protocol_not_xai(tmp_path: Path, monkeypatch):
    home = tmp_path / "home"
    settings = CircleSettings(
        initialized=True,
        auth=ModelAuth(
            mode="api_key",
            protocol="anthropic",
            base_url="https://dm-fox.rjj.cc/grok",
            model="grok-4.7",
        ),
    )
    save_settings(settings, home)
    save_credentials({"api_key": "sk-test"}, home)

    captured: dict = {}

    def fake_init(model_name, **kwargs):
        captured["model"] = model_name
        captured["kwargs"] = kwargs

        class _M:
            pass

        return _M()

    monkeypatch.setattr("circle.model.init_chat_model", fake_init)
    build_chat_model(settings, home=home)
    assert captured["model"] == "grok-4.7"
    assert captured["kwargs"]["model_provider"] == "anthropic"
    assert captured["kwargs"]["base_url"] == "https://dm-fox.rjj.cc/grok"
    assert captured["kwargs"]["api_key"] == "sk-test"
