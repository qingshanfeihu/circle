"""Minimal pricing stubs so InfoTest FooterPane imports resolve."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def cost_currency(model: str) -> str:
    return "¥"


def cost_reference_basis(model: str) -> str:
    return ""


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
    return None


def format_usage_costs(
    *summaries: Mapping[str, Any],
    empty_model: str = "",
) -> str:
    return ""
