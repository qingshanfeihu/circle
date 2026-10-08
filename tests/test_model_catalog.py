"""models.dev as the source of a model's window and price (circle.model_catalog), the setting
that overrides the window, and what the footer and the compaction make of them."""

from __future__ import annotations

import gzip
import json
import os
import time

import pytest

from circle import model_catalog
from circle.ink.components.footer import FooterPane
from circle.pricing import format_usage_costs, price_call

# A trimmed catalog in the shape models.dev's api.json has (circle.model_catalog.slim reads it)
RAW = {
    "zhipuai": {"api": "https://open.bigmodel.cn/api/paas/v4", "models": {
        "glm-5.3": {"limit": {"context": 1_000_000, "output": 131_072},
                    "cost": {"input": 1.4, "output": 4.4, "cache_read": 0.26, "cache_write": 0}}}},
    "zhipuai-coding-plan": {"api": "https://open.bigmodel.cn/api/coding/paas/v4", "models": {
        "glm-5.3": {"limit": {"context": 1_000_000, "output": 131_072},
                    "cost": {"input": 0, "output": 0}}}},
    "alibaba-cn": {"api": "https://dashscope.aliyuncs.com/compatible-mode/v1", "models": {
        "qwen3.8-flash": {"limit": {"context": 1_000_000, "output": 131_072},
                          "cost": {"input": 0.11875, "output": 0.40073, "cache_read": 0.01187,
                                   "cache_write": 0.14844}}}},
    "alibaba-token-plan-cn": {"api": "https://token-plan.cn-beijing.maas.aliyuncs.com/v1",
                              "models": {"qwen3.8-flash": {
                                  "limit": {"context": 1_000_000}, "cost": {"input": 0, "output": 0}}}},
    "tencent-coding-plan": {"api": "https://api.lkeap.cloud.tencent.com/v1", "models": {
        "hy-2": {"limit": {"context": 256_000}, "cost": {"input": 0, "output": 0}}}},
    "lmstudio": {"api": "http://127.0.0.1:1234/v1", "models": {
        "local-7b": {"limit": {"context": 32_768}, "cost": {"input": 0, "output": 0}}}},
    "anthropic": {"models": {
        "claude-sonnet-5": {"limit": {"context": 1_000_000, "output": 128_000},
                            "cost": {"input": 2, "output": 10, "cache_read": 0.2, "cache_write": 2.5,
                                     "context_over_200k": {"input": 4, "output": 15}}}}},
    "broken": "not a provider",
    "empty": {"api": "https://x.example", "models": {"m": {"name": "no limits, no cost"}}},
}


@pytest.fixture
def catalog():
    data = model_catalog.slim(RAW)
    model_catalog.set_catalog(data)
    return data


def test_slim_keeps_windows_prices_and_long_context_rates(catalog):
    providers = catalog["providers"]
    assert set(providers) == {"zhipuai", "zhipuai-coding-plan", "alibaba-cn",
                              "alibaba-token-plan-cn", "tencent-coding-plan", "lmstudio",
                              "anthropic"}
    assert providers["anthropic"]["api"] == ""
    sonnet = providers["anthropic"]["models"]["claude-sonnet-5"]
    assert sonnet["context"] == 1_000_000 and sonnet["output"] == 128_000
    assert sonnet["cost"]["context_over_200k"] == {"input": 4.0, "output": 15.0}


@pytest.mark.parametrize("base_url,protocol,model,window,provider,price_provider", [
    # the pay-as-you-go entry, not the subscription on the same host
    ("https://open.bigmodel.cn/api/anthropic", "anthropic", "glm-5.3", 1_000_000,
     "zhipuai", "zhipuai"),
    # only a subscription at this host: window from it, price from the vendor's pay-as-you-go
    ("https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic", "anthropic",
     "qwen3.8-flash", 1_000_000, "alibaba-token-plan-cn", "alibaba-cn"),
    # no API address in models.dev: the SDK's own host
    ("https://api.anthropic.com", "anthropic", "claude-sonnet-5", 1_000_000,
     "anthropic", "anthropic"),
    # no base URL at all (OAuth sign-in): the protocol's host
    ("", "anthropic", "claude-sonnet-5", 1_000_000, "anthropic", "anthropic"),
    # a free local server is priced at the 0 models.dev gives it
    ("http://127.0.0.1:1234/v1", "openai", "local-7b", 32_768, "lmstudio", "lmstudio"),
])
def test_the_entry_follows_the_endpoint_host(catalog, base_url, protocol, model, window,
                                             provider, price_provider):
    model_catalog.bind_endpoint(base_url, protocol)
    facts = model_catalog.facts(model)
    assert (facts.context_window, facts.window_known, facts.window_source) == (
        window, True, "models.dev")
    assert (facts.provider, facts.price_provider) == (provider, price_provider)
    assert facts.rates is not None


def test_a_subscription_without_a_pay_as_you_go_twin_has_no_price(catalog):
    model_catalog.bind_endpoint("https://api.lkeap.cloud.tencent.com/v1", "openai")
    facts = model_catalog.facts("hy-2")
    assert facts.context_window == 256_000 and facts.rates is None


def test_an_unknown_endpoint_falls_back_to_128k_and_no_price(catalog):
    model_catalog.bind_endpoint("https://gateway.example.internal/v1", "openai")
    facts = model_catalog.facts("glm-5.3")
    assert (facts.context_window, facts.window_known, facts.window_source) == (
        128_000, False, "fallback")
    assert facts.rates is None and facts.provider == ""


def test_the_setting_overrides_the_window_only(catalog):
    model_catalog.bind_endpoint("https://open.bigmodel.cn/api/anthropic", "anthropic",
                                {"glm-5.3": 200_000})
    facts = model_catalog.facts("glm-5.3")
    assert (facts.context_window, facts.window_known, facts.window_source) == (
        200_000, True, "settings")
    assert facts.price_provider == "zhipuai", "the price still comes from models.dev"
    model_catalog.bind_endpoint("https://gateway.example.internal/v1", "openai",
                                {"glm-5.3": 500_000})
    assert model_catalog.facts("glm-5.3").window_known, "a set window is known anywhere"
    assert model_catalog.window_overrides({"a": {"context_window": 9}, "b": {"context_window": "9"},
                                           "c": {"context_window": 0}, "d": 5}) == {"a": 9}


def test_settings_bind_the_endpoint_and_the_overrides(catalog):
    from circle.settings import CircleSettings, ModelAuth, load_settings_from_dict

    settings = load_settings_from_dict({"auth": {"protocol": "anthropic",
                                                 "base_url": "https://open.bigmodel.cn/api/anthropic",
                                                 "model": "glm-5.3"},
                                        "models": {"glm-5.3": {"context_window": 300_000},
                                                   "bad": "x"}})
    assert settings.models == {"glm-5.3": {"context_window": 300_000}}
    model_catalog.bind(settings)
    assert model_catalog.facts("glm-5.3").context_window == 300_000
    assert CircleSettings().models == {}
    assert isinstance(ModelAuth().base_url, str)


def test_prices_are_dollars_with_cache_and_long_context_rates(catalog):
    model_catalog.bind_endpoint("https://open.bigmodel.cn/api/anthropic", "anthropic")
    receipt = price_call("glm-5.3", {"input_tokens": 1_000_000, "output_tokens": 1_000_000,
                                     "prompt_cache_hit_tokens": 400_000,
                                     "prompt_cache_write_tokens": 100_000})
    # 500k new at $1.4, 400k cached at $0.26, 100k written at the input price (models.dev: 0),
    # 1M out at $4.4
    assert receipt["currency"] == "USD"
    assert receipt["amount"] == pytest.approx(0.5 * 1.4 + 0.4 * 0.26 + 0.1 * 1.4 + 4.4)
    model_catalog.bind_endpoint("", "anthropic")
    long = price_call("claude-sonnet-5", {"input_tokens": 300_000, "output_tokens": 1_000})
    short = price_call("claude-sonnet-5", {"input_tokens": 100_000, "output_tokens": 1_000})
    assert long["amount"] == pytest.approx(0.3 * 4 + 0.001 * 15), "over 200k: the long rates"
    assert short["amount"] == pytest.approx(0.1 * 2 + 0.001 * 10)
    model_catalog.bind_endpoint("https://gateway.example.internal/v1", "openai")
    unknown = price_call("glm-5.3", {"input_tokens": 10, "output_tokens": 10})
    assert unknown["amount"] is None and unknown["currency"] == ""


def test_unknown_window_and_price_read_n_a(catalog):
    model_catalog.bind_endpoint("https://gateway.example.internal/v1", "openai")
    footer = FooterPane()
    footer.update(model="glm-5.3", input_tokens=12_000, context_input_tokens=12_000,
                  output_tokens=300)
    text = footer._session_summary(colored=True)
    assert "ctx 12.0k/N/A" in text and "%" not in text.split("ctx")[1]
    assert format_usage_costs({"amounts": {}, "calls": 1, "unpriced_calls": 1}) == "N/A"
    assert format_usage_costs(empty_model="glm-5.3") == "N/A"
    model_catalog.bind_endpoint("https://open.bigmodel.cn/api/anthropic", "anthropic")
    assert format_usage_costs(empty_model="glm-5.3") == "$0.0000"
    footer.update(model="glm-5.3")
    assert "ctx 12.0k/1.0M (1%)" in footer._session_summary()
    footer.shutdown()


def test_the_built_model_carries_the_window_the_footer_shows(catalog, tmp_path):
    from circle.model import build_chat_model
    from circle.settings import CircleSettings, ModelAuth

    (tmp_path / "credentials.json").write_text('{"api_key": "sk-test"}', encoding="utf-8")
    settings = CircleSettings(initialized=True, auth=ModelAuth(
        protocol="anthropic", base_url="https://open.bigmodel.cn/api/anthropic", model="glm-5.3"))
    model = build_chat_model(settings, home=tmp_path)
    assert model.profile["max_input_tokens"] == 1_000_000
    assert model.profile["max_output_tokens"] == 131_072
    settings.models = {"glm-5.3": {"context_window": 64_000}}
    assert build_chat_model(settings, home=tmp_path).profile["max_input_tokens"] == 64_000
    settings.auth.base_url = "https://gateway.example.internal/v1"
    settings.models = {}
    assert build_chat_model(settings, home=tmp_path).profile["max_input_tokens"] == 128_000


def test_the_answer_keeps_to_a_quarter_of_the_window(catalog, tmp_path):
    """The request and the answer share the window: deepagents keeps a request under 95% of it
    less ``max_tokens``. A window too small for Circle's 32,000-token answer gives it a quarter;
    a larger window gives the 32,000 back."""
    from circle.model import apply_context_window, build_chat_model
    from circle.settings import CircleSettings, ModelAuth

    (tmp_path / "credentials.json").write_text('{"api_key": "sk-test"}', encoding="utf-8")
    settings = CircleSettings(initialized=True, auth=ModelAuth(
        protocol="anthropic", base_url="https://open.bigmodel.cn/api/anthropic", model="glm-5.3"))
    model = build_chat_model(settings, home=tmp_path)
    assert model.max_tokens == 32_000, "a 1M window leaves the answer what it asked for"
    settings.models = {"glm-5.3": {"context_window": 20_000}}
    apply_context_window(model, settings, "glm-5.3")
    assert model.max_tokens == 5_000
    settings.models = {}
    apply_context_window(model, settings, "glm-5.3")
    assert model.max_tokens == 32_000


def test_a_thinking_budget_stays_under_the_smaller_answer(catalog):
    from langchain_anthropic import ChatAnthropic

    from circle.model import apply_context_window
    from circle.settings import CircleSettings, ModelAuth

    settings = CircleSettings(initialized=True, auth=ModelAuth(protocol="anthropic", model="claude-x"),
                              models={"claude-x": {"context_window": 40_000}})
    model = ChatAnthropic(model="claude-x", api_key="sk-test", max_tokens=24_192,
                          thinking={"type": "enabled", "budget_tokens": 16_000})
    apply_context_window(model, settings, "claude-x")
    assert model.max_tokens == 10_000
    assert model.thinking == {"type": "enabled", "budget_tokens": 5_000}


def test_the_shipped_snapshot_is_readable():
    data = json.loads(gzip.decompress(model_catalog.SNAPSHOT.read_bytes()).decode("utf-8"))
    assert data["schema"] == model_catalog.SCHEMA and len(data["providers"]) > 50
    model_catalog.set_catalog(None)
    assert model_catalog.source() in ("snapshot", "cache")


def test_refresh_keeps_a_copy_and_runs_only_when_it_is_a_day_old(tmp_path, monkeypatch):
    monkeypatch.setattr(model_catalog, "fetch", lambda timeout=20.0: RAW)
    assert model_catalog.refresh(tmp_path)
    copy = model_catalog.cache_path(tmp_path)
    assert json.loads(copy.read_text(encoding="utf-8"))["providers"]["zhipuai"]
    assert model_catalog.source() == "cache"

    monkeypatch.delenv("CIRCLE_NO_MODELS_REFRESH", raising=False)
    assert model_catalog.refresh_in_background(tmp_path) is None, "fresh: nothing to do"
    stale = time.time() - model_catalog.REFRESH_AFTER_S - 60
    os.utime(copy, (stale, stale))
    done: list[bool] = []
    thread = model_catalog.refresh_in_background(tmp_path, on_refreshed=lambda: done.append(True))
    assert thread is not None
    thread.join(5)
    assert done == [True]
    monkeypatch.setenv("CIRCLE_NO_MODELS_REFRESH", "1")
    os.utime(copy, (stale, stale))
    assert model_catalog.refresh_in_background(tmp_path) is None


def test_a_failed_refresh_keeps_what_is_there(tmp_path, monkeypatch):
    def offline(timeout=20.0):
        raise OSError("no network")

    model_catalog.set_catalog(model_catalog.slim(RAW))
    monkeypatch.setattr(model_catalog, "fetch", offline)
    assert model_catalog.refresh(tmp_path) is False
    assert not model_catalog.cache_path(tmp_path).exists()
    model_catalog.bind_endpoint("", "anthropic")
    assert model_catalog.facts("claude-sonnet-5").window_known
