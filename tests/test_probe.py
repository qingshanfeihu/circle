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
        if url.endswith("/v1/models") and "x-api-key" in headers:
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


def test_infer_protocol_hint_anthropic_url():
    assert (
        probe.infer_protocol_hint(
            "https://dashscope.aliyuncs.com/apps/anthropic"
        )
        == "anthropic"
    )


def test_infer_protocol_hint_openaiish_url():
    assert probe.infer_protocol_hint("https://api.openai.com/v1") == "openai"
    assert (
        probe.infer_protocol_hint(
            "https://dashscope.aliyuncs.com/compatible-mode/v1"
        )
        == "openai"
    )


def test_resolve_endpoint_uses_url_hint_when_probe_misses(monkeypatch):
    monkeypatch.setattr(probe, "_get", lambda *_a, **_k: (_ for _ in ()).throw(OSError("nope")))
    result = probe.resolve_endpoint(
        "https://dashscope.aliyuncs.com/apps/anthropic",
        "sk",
    )
    assert result.protocol == "anthropic"
    assert result.inferred is True
    assert result.models == []
    assert result.status == "failed"


def test_resolve_endpoint_defaults_openai_without_hint(monkeypatch):
    monkeypatch.setattr(probe, "_get", lambda *_a, **_k: (_ for _ in ()).throw(OSError("nope")))
    result = probe.resolve_endpoint("https://llm.example/gateway", "sk")
    assert result.protocol == "openai"
    assert result.inferred is True


def _stepfun_like(calls: list[tuple[str, str]]):
    """An OpenAI-style API documented as ``…/step_plan`` whose routes live under /v1."""
    def fake_get(url: str, headers: dict, timeout: float):
        style = "bearer" if "Authorization" in headers else "x-api-key"
        calls.append((url, style))
        if url == "https://api.example.com/step_plan/v1/models" and style == "bearer":
            return 200, json.dumps({"data": [{"id": "step-3.7-flash"}, {"id": "step-5"}]}).encode()
        raise OSError(f"{url} → 404 or 401")
    return fake_get


def test_probe_finds_an_openai_api_under_v1(monkeypatch):
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(probe, "_get", _stepfun_like(calls))
    result = probe.resolve_endpoint("https://api.example.com/step_plan/", "sk")
    assert result.protocol == "openai" and result.inferred is False
    assert result.models == ["step-3.7-flash", "step-5"]
    assert result.base_url == "https://api.example.com/step_plan/v1", "saved with /v1"
    assert calls == [("https://api.example.com/step_plan/models", "bearer"),
                     ("https://api.example.com/step_plan/v1/models", "bearer")]


def test_probe_keeps_the_given_url_when_it_answers(monkeypatch):
    monkeypatch.setattr(probe, "_get", lambda url, headers, timeout: (
        200, json.dumps({"data": [{"id": "gpt-test"}]}).encode()))
    assert probe.probe_endpoint("https://gateway.example/v1", "sk").base_url == \
        "https://gateway.example/v1"


def test_probe_does_not_add_v1_for_anthropic_or_v1_urls(monkeypatch):
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(probe, "_get", _stepfun_like(calls))
    assert probe.probe_endpoint("https://dashscope.aliyuncs.com/apps/anthropic", "sk") is None
    assert probe.probe_endpoint("https://gateway.example/v1", "sk") is None
    assert not any("/v1/v1" in url for url, _style in calls)
    # An Anthropic URL is asked as Anthropic first
    assert calls[0] == ("https://dashscope.aliyuncs.com/apps/anthropic/v1/models", "x-api-key")
