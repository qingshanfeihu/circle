"""Endpoint protocol probe — OpenAI-compatible then Anthropic.

Aligned with InfoTest demo probe_endpoint / resolve_llm_protocol semantics:
try GET {base}/models (Bearer), then GET {base}/v1/models (x-api-key).
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


FALLBACK_MODELS = ["claude-sonnet-4-5", "gpt-4.1", "gpt-4o"]


def _get(url: str, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return int(resp.status), resp.read()


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


def fallback_model_list() -> list[str]:
    return list(FALLBACK_MODELS)
