
from __future__ import annotations

import math
import json
from collections.abc import Mapping
from typing import Any


# 官方参考刊例，每百万 tokens；不识别实际账户、地域、渠道折扣或结算时段，不代表账单。
# 每行保留参考范围供说明与诊断读取；页脚仅显示金额，改价先核官方页。
# cache_write = 显式缓存创建价（Anthropic 5m 写 / 百炼显式创建）；缺省时写按 input_miss 计。
# cache_write_1h = Anthropic 1h TTL 写价；缺省时按 cache_write 计。
# currency 缺省 RMB（¥）；官方仅有美元价的标 "USD"（$）。
PRICING: dict[str, dict[str, float | str]] = {
    # mimo.mi.com/docs/zh-CN/price/pay-as-you-go 国内定价，2026-09-21 核对；缓存写限时免费
    "mimo-v2.5":     {"input_miss": 1.0, "input_hit": 0.02,  "output": 2.0, "cache_write": 0.0,
                     "reference_basis": "MiMo国内刊例，缓存创建限免"},
    "mimo-v2.5-pro": {"input_miss": 3.0, "input_hit": 0.025, "output": 6.0, "cache_write": 0.0,
                     "reference_basis": "MiMo国内刊例，缓存创建限免"},
    # api-docs.deepseek.com/quick_start/pricing 高峰价，2026-09-21 核对（空闲时段半价，未分时段按高峰估）；自动缓存无写费
    "deepseek-flash":    {"input_miss": 0.30, "input_hit": 0.006, "output": 1.20, "currency": "USD",
                         "reference_basis": "DeepSeek高峰刊例，非高峰半价"},
    "deepseek-v4-flash": {"input_miss": 0.30, "input_hit": 0.006, "output": 1.20, "currency": "USD",
                         "reference_basis": "DeepSeek高峰刊例，非高峰半价"},  # 旧名仍受理，按 Flash 价
    "deepseek-v4-pro":   {"input_miss": 1.32, "input_hit": 0.044, "output": 3.96, "currency": "USD",
                         "reference_basis": "DeepSeek高峰刊例，非高峰半价"},
    # help.aliyun.com/zh/model-studio/qwen3-8-flash 中国站按量，2026-09-21 核对（2026-08-27 调价后）
    "qwen3.8-flash": {"input_miss": 0.8, "input_hit": 0.1, "output": 2.7, "cache_write": 1.25,
                     "reference_basis": "中国站北京刊例"},
    # https://help.aliyun.com/zh/model-studio/qwen3-8-max，2026-09-21 核对；显/隐式读价不同。
    "qwen3.8-max":   {"input_miss": 12.0, "input_hit": 1.5, "input_hit_explicit": 1.0,
                     "output": 36.0, "cache_write": 15.0, "reference_basis": "中国站北京刊例"},
    # Anthropic Sonnet 刊例：$3 / $15 每百万，缓存读 0.1×、5 分钟写 1.25×。网关别名按此参考，不是账单。
    "claude-sonnet-5": {"input_miss": 3.0, "input_hit": 0.30, "output": 15.0,
                        "cache_write": 3.75, "currency": "USD",
                        "reference_basis": "Claude Sonnet 刊例参考，非账单"},
    "claude-sonnet-4-5": {"input_miss": 3.0, "input_hit": 0.30, "output": 15.0,
                          "cache_write": 3.75, "currency": "USD",
                          "reference_basis": "Claude Sonnet 刊例参考，非账单"},
    "claude-sonnet-4": {"input_miss": 3.0, "input_hit": 0.30, "output": 15.0,
                        "cache_write": 3.75, "currency": "USD",
                        "reference_basis": "Claude Sonnet 刊例参考，非账单"},
}

_CURRENCY_SYMBOL = {"RMB": "¥", "USD": "$"}


def _row_for(model: str) -> dict[str, float | str] | None:
    return PRICING.get(model) or PRICING.get(model.rpartition("/")[-1])


_CONTEXT_WINDOWS = {
    "claude-sonnet-5": 200_000,
    "claude-sonnet-4-5": 200_000,
    "claude-sonnet-4": 200_000,
    "qwen3.8-flash": 1_000_000,
    "qwen3.8-max": 262_144,
}


def context_window_for(model: str) -> int:
    """Context window used for the footer rate. Override with CIRCLE_MODEL_CTX."""
    import os

    raw = (os.environ.get("CIRCLE_MODEL_CTX") or "").strip()
    if raw.isdigit():
        return max(1, int(raw))
    name = (model or "").strip().rpartition("/")[-1]
    if name in _CONTEXT_WINDOWS:
        return _CONTEXT_WINDOWS[name]
    low = name.lower()
    if any(token in low for token in ("sonnet", "opus", "haiku")):
        return 200_000
    return 128_000


def cost_currency(model: str) -> str:
    row = _row_for(model)
    if row is None:
        return ""
    return _CURRENCY_SYMBOL.get(str(row.get("currency") or "RMB"), "¥")


def cost_reference_basis(model: str) -> str:
    """参考价的适用域；不是从模型名推断实际请求的地域或账户币种。"""
    return str((_row_for(model) or {}).get("reference_basis") or "")


def compute_cost(
    model: str,
    *,
    input_miss: int,
    input_hit: int,
    output: int,
    input_write: int = 0,
    input_write_1h: int = 0,
    cache_mode: str | None = None,
) -> float | None:
    """按模型价格表计算；未指定模式时用该行默认读价，不据此声明实际缓存模式。"""
    row = _row_for(model)
    if not row:
        return None
    if cache_mode not in {None, "implicit", "explicit"}:
        return None
    hit_rate = float(row["input_hit"])
    explicit_hit_rate = float(row.get("input_hit_explicit", hit_rate))
    if cache_mode == "explicit":
        hit_rate = explicit_hit_rate
    write_rate = float(row["cache_write"]) if "cache_write" in row else float(row["input_miss"])
    write_1h_rate = float(row["cache_write_1h"]) if "cache_write_1h" in row else write_rate
    write_1h = min(max(input_write_1h, 0), max(input_write, 0))
    write_short = max(input_write, 0) - write_1h
    return (
        input_miss * float(row["input_miss"]) / 1_000_000
        + input_hit * hit_rate / 1_000_000
        + write_short * write_rate / 1_000_000
        + write_1h * write_1h_rate / 1_000_000
        + output * float(row["output"]) / 1_000_000
    )


def callback_model_name(serialized: Any = None, *, metadata: Any = None,
                        invocation_params: Any = None, fallback: str = "") -> str:
    """读取本次调用身份；框架类名不是模型名，不能用于计价。"""
    serial = serialized if isinstance(serialized, Mapping) else {}
    for source, keys in (
        (invocation_params, ("model", "model_name")),
        (metadata, ("ls_model_name",)),
        (serial.get("kwargs"), ("model", "model_name")),
    ):
        if isinstance(source, Mapping):
            for key in keys:
                value = source.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return str(fallback or "")


def response_model_name(response: Any, *, fallback: str = "") -> str:
    message = response
    generations = getattr(response, "generations", None)
    if generations and generations[0]:
        message = getattr(generations[0][0], "message", None)
    for source in (getattr(message, "response_metadata", None),
                   getattr(response, "llm_output", None)):
        if isinstance(source, Mapping):
            for key in ("model_name", "model"):
                value = source.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return str(fallback or "")


def price_call(model: str, usage: Mapping[str, Any]) -> dict[str, Any]:
    """每次 provider 用量到达时冻结金额，之后只求和，不按当前模型重估旧调用。"""
    def count(key: str) -> int:
        value = usage.get(key)
        return value if type(value) is int and value >= 0 else 0

    model = str(model or "")
    total = count("input_tokens")
    hit = min(count("prompt_cache_hit_tokens"), total)
    write = min(count("prompt_cache_write_tokens"), total - hit)
    write_1h = min(count("prompt_cache_write_1h_tokens"), write)
    counts = {"input_miss": total - hit - write, "input_hit": hit,
              "input_write": write, "input_write_1h": write_1h,
              "output": count("output_tokens")}
    row = _row_for(model)
    mode = usage.get("cache_mode")
    rates = dict(row) if row else {}
    try:
        amount = (compute_cost(model, **counts, cache_mode=mode)
                  if mode is None or isinstance(mode, str) else None)
        if type(amount) not in (int, float) or not math.isfinite(amount) or amount < 0:
            amount = None
        json.dumps(rates, allow_nan=False)
    except (KeyError, TypeError, ValueError, OverflowError):
        # 计价配置异常不能中断原有 token 结算，更不能把 NaN 写进耐久账。
        amount, rates = None, {}
    return {"model": model, "currency": str(row.get("currency") or "RMB") if row else "",
            "amount": amount, "tokens": counts, "rates": rates}


class UsageCostTotals:
    """调用方在与 token 同一把锁内累计；未定价调用不抹掉已有金额。"""

    def __init__(self) -> None:
        self.amounts: dict[str, float] = {}
        self.calls = 0
        self.unpriced_calls = 0

    def add(self, receipt: Any) -> None:
        self.calls += 1
        amount = receipt.get("amount") if isinstance(receipt, Mapping) else None
        currency = receipt.get("currency") if isinstance(receipt, Mapping) else None
        if (type(amount) not in (int, float) or not math.isfinite(amount)
                or amount < 0 or not isinstance(currency, str) or currency not in _CURRENCY_SYMBOL):
            self.unpriced_calls += 1
            return
        self.amounts[currency] = self.amounts.get(currency, 0.0) + amount

    def snapshot(self) -> dict[str, Any]:
        return {"amounts": dict(self.amounts), "calls": self.calls,
                "unpriced_calls": self.unpriced_calls}


def format_usage_costs(*summaries: Mapping[str, Any], empty_model: str = "",
                       has_settled_tokens: bool = False) -> str:
    amounts: dict[str, float] = {}
    calls = unpriced = 0
    for summary in summaries:
        if not isinstance(summary, Mapping):
            continue
        calls += max(0, summary["calls"]) if type(summary.get("calls")) is int else 0
        unpriced += max(0, summary["unpriced_calls"]) if type(summary.get("unpriced_calls")) is int else 0
        rows = summary.get("amounts")
        for currency, amount in (rows.items() if isinstance(rows, Mapping) else ()):
            if (currency in _CURRENCY_SYMBOL and type(amount) in (int, float)
                    and math.isfinite(amount) and amount >= 0):
                amounts[currency] = amounts.get(currency, 0.0) + amount
    if amounts:
        # 币种分别显示，不按一个模型重估，也不自行换汇；+ 表示还有未定价调用。
        return " + ".join(
            f"{_CURRENCY_SYMBOL[currency]}{amounts[currency]:.4f}"
            for currency in _CURRENCY_SYMBOL if currency in amounts
        ) + ("+" if unpriced else "")
    if calls or has_settled_tokens:
        return "—"
    currency = cost_currency(empty_model)
    return f"{currency}0.0000" if currency else "—"
