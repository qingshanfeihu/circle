"""Endpoint protocol probe — OpenAI-compatible then Anthropic.

Aligned with InfoTest demo probe_endpoint / resolve_llm_protocol semantics:
try GET {base}/models (Bearer), then GET {base}/v1/models (x-api-key).

When both probes miss (common on Anthropic-only gateways that omit /v1/models),
fall back using URL hints so ``…/apps/anthropic`` is not misclassified as OpenAI.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass


@dataclass(frozen=True)
class ProbeResult:
    protocol: str  # openai | anthropic
    models: list[str]
    inferred: bool = False  # True when URL hint used after both probes missed


FALLBACK_MODELS = ["claude-sonnet-4-5", "gpt-4.1", "gpt-4o"]


def _get(url: str, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return int(resp.status), resp.read()


def infer_protocol_hint(base_url: str) -> str | None:
    """Best-effort protocol from the gateway URL when /models probes fail."""
    u = (base_url or "").strip().lower()
    if not u:
        return None
    if "anthropic" in u:
        return "anthropic"
    if any(
        token in u
        for token in (
            "openai",
            "compatible-mode",
            "openrouter",
            "/v1/chat",
            "azure",
        )
    ):
        return "openai"
    return None


def probe_endpoint(
    base_url: str,
    api_key: str,
    *,
    timeout: float = 2.5,
) -> ProbeResult | None:
    base = base_url.rstrip("/")
    if not base or not api_key:
        return None

    attempts: tuple[tuple[str, str, dict[str, str]], ...] = (
        ("openai", "/models", {"Authorization": f"Bearer {api_key}"}),
        (
            "anthropic",
            "/v1/models",
            {"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        ),
    )
    for protocol, path, headers in attempts:
        try:
            status, body = _get(base + path, headers, timeout)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            continue
        if status != 200:
            continue
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        ids = [
            str(item.get("id"))
            for item in (payload.get("data") or [])
            if isinstance(item, dict) and item.get("id")
        ]
        if ids:
            return ProbeResult(protocol=protocol, models=ids)
        # 200 with empty list still counts as a hit
        return ProbeResult(protocol=protocol, models=list(FALLBACK_MODELS))
    return None


def resolve_endpoint(
    base_url: str,
    api_key: str,
    *,
    timeout: float = 2.5,
) -> ProbeResult:
    """Probe, then URL-hint fallback (never silently assume OpenAI for Anthropic URLs)."""
    probed = probe_endpoint(base_url, api_key, timeout=timeout)
    if probed is not None:
        return probed
    hint = infer_protocol_hint(base_url) or "openai"
    return ProbeResult(protocol=hint, models=list(FALLBACK_MODELS), inferred=True)


def fallback_model_list() -> list[str]:
    return list(FALLBACK_MODELS)
