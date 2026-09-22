"""Protocol probe unit tests with a fake HTTP layer."""

from __future__ import annotations

import json

import circle.probe as probe


def test_probe_prefers_openai_when_models_ok(monkeypatch):
    calls: list[str] = []

    def fake_get(url: str, headers: dict, timeout: float):
        calls.append(url)
        if url.endswith("/models") and not url.endswith("/v1/models"):
            body = json.dumps({"data": [{"id": "gpt-test"}]}).encode()
            return 200, body
        raise OSError("should not reach anthropic")

    monkeypatch.setattr(probe, "_get", fake_get)
    result = probe.probe_endpoint("https://gateway.example", "sk")
    assert result is not None
    assert result.protocol == "openai"
    assert result.models == ["gpt-test"]
    assert calls == ["https://gateway.example/models"]


def test_probe_falls_through_to_anthropic(monkeypatch):
    def fake_get(url: str, headers: dict, timeout: float):
        if url.endswith("/v1/models"):
            assert headers.get("x-api-key") == "sk"
            body = json.dumps({"data": [{"id": "claude-test"}]}).encode()
            return 200, body
        raise OSError("openai miss")

    monkeypatch.setattr(probe, "_get", fake_get)
    result = probe.probe_endpoint("https://gateway.example", "sk")
    assert result is not None
    assert result.protocol == "anthropic"
    assert result.models == ["claude-test"]


def test_probe_returns_none_when_both_fail(monkeypatch):
    monkeypatch.setattr(probe, "_get", lambda *_a, **_k: (_ for _ in ()).throw(OSError("nope")))
    assert probe.probe_endpoint("https://x", "sk") is None
