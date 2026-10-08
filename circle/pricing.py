"""What a model call costs, priced as it arrives.

Prices are models.dev's pay-as-you-go ones for the connected endpoint
(``circle.model_catalog``), in US dollars per million tokens: a reference, not a bill. Each
call is priced once when its usage arrives and only summed after that, so switching models
never re-prices earlier calls. Receipts written by older versions in ¥ still add up under
their own currency.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Any

from circle import model_catalog

_CURRENCY_SYMBOL = {"USD": "$", "RMB": "¥"}
_TIER_INPUT = 200_000


def _rates(prices: Mapping[str, Any]) -> dict[str, float] | None:
    """models.dev prices → the four rates a call is charged at. A missing or zero cache
    price is charged as input: models.dev writes 0 where a provider lists no separate price."""
    try:
        base = float(prices["input"])
        out = float(prices["output"])
    except (KeyError, TypeError, ValueError):
        return None
    read = float(prices.get("cache_read") or 0) or base
    write = float(prices.get("cache_write") or 0) or base
    return {"input_miss": base, "input_hit": read, "output": out, "cache_write": write}


def _row_for(model: str) -> dict[str, Any] | None:
    facts = model_catalog.facts(model)
    if not facts.rates:
        return None
    row: dict[str, Any] | None = _rates(facts.rates)
    if row is None:
        return None
    tier = facts.rates.get(model_catalog.TIER_KEY)
    tier_rates = _rates(tier) if isinstance(tier, Mapping) else None
    if tier_rates:
        row["over_200k"] = tier_rates
    row["currency"] = "USD"
    row["reference_basis"] = (f"models.dev {facts.price_provider} pay-as-you-go price "
                              "for reference, not a bill")
    return row


def context_window_for(model: str) -> int:
    """The context window the footer and the automatic compaction share: the setting, else
    models.dev, else 128,000."""
    return model_catalog.facts(model).context_window


def context_window_known(model: str) -> bool:
    """False when the window is only the 128,000 fallback (the footer shows ``N/A``)."""
    return model_catalog.facts(model).window_known


def cost_currency(model: str) -> str:
    return "$" if _row_for(model) else ""


def cost_reference_basis(model: str) -> str:
    """Where the price comes from; it says nothing about the account or region billed."""
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
    tiered: bool = True,
) -> float | None:
    """Dollars for one call's tokens, or ``None`` when the model has no price. A call with more
    than 200k input tokens is charged at the model's long-context rates when models.dev lists
    them (``tiered=False`` for sums of several calls). ``cache_mode`` is accepted for older
    callers; models.dev has one cache-read price."""
    row = _row_for(model)
    if not row:
        return None
    if cache_mode not in {None, "implicit", "explicit"}:
        return None
    write = max(input_write, 0)
    total = max(input_miss, 0) + max(input_hit, 0) + write
    rates = row["over_200k"] if tiered and total > _TIER_INPUT and "over_200k" in row else row
    return (
        input_miss * float(rates["input_miss"]) / 1_000_000
        + input_hit * float(rates["input_hit"]) / 1_000_000
        + write * float(rates["cache_write"]) / 1_000_000
        + output * float(rates["output"]) / 1_000_000
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
    return {"model": model, "currency": str(row.get("currency") or "USD") if row else "",
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
        return "N/A"
    currency = cost_currency(empty_model)
    return f"{currency}0.0000" if currency else "N/A"
