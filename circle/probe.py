"""Discover endpoint models without substituting an unverified model catalog."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class ProbeResult:
    protocol: str
    models: list[str]
    inferred: bool = False
    base_url: str = ""
    status: str = "discovered"  # discovered | empty | failed
    detail: str = ""

    def summary(self) -> str:
        if self.status == "failed" or self.inferred:
            return "model discovery failed" + (
                "; protocol is unverified" if self.inferred else ""
            ) + (
                f" ({self.detail})" if self.detail else ""
            )
        if not self.models:
            return f"endpoint returned an empty model list ({self.protocol})"
        return f"discovered {len(self.models)} models ({self.protocol})"


def _get(url: str, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return int(resp.status), resp.read()


def infer_protocol_hint(base_url: str) -> str | None:
    u = (base_url or "").strip().lower()
    if "anthropic" in u:
        return "anthropic"
    if any(token in u for token in ("openai", "compatible-mode", "openrouter", "/v1/chat", "azure")):
        return "openai"
    return None


def normalize_base_url(base_url: str, protocol: str) -> str:
    """Keep the supplied host and gateway prefix; Anthropic SDK adds /v1 itself."""
    if protocol not in {"openai", "anthropic"}:
        raise ValueError("protocol must be openai or anthropic")
    try:
        parts = urlsplit(base_url.strip())
        valid = parts.scheme in {"http", "https"} and parts.hostname and parts.port != 0
    except ValueError:
        valid = False
    if not valid or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("use an http(s) API base URL without credentials, query or fragment")
    path = parts.path.rstrip("/")
    if protocol == "anthropic" and path.endswith("/v1"):
        path = path[:-3]
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def _discover(base_url: str, api_key: str, timeout: float, protocol: str | None) -> ProbeResult:
    preferred = protocol or infer_protocol_hint(base_url) or "openai"
    try:
        base = normalize_base_url(base_url, "openai")
    except ValueError:
        return ProbeResult(preferred, [], protocol is None, status="failed", detail="invalid API base URL")
    if not api_key:
        return ProbeResult(preferred, [], protocol is None, base, "failed", "missing API key")
    protocols = [protocol] if protocol else [preferred, "anthropic" if preferred == "openai" else "openai"]
    empty = None
    failures: list[str] = []
    for candidate in protocols:
        if candidate == "openai":
            bases = [base]
            # A supplied version is authoritative; retain custom gateway prefixes.
            if not re.search(r"/v\d+(?:beta\d*)?$", urlsplit(base).path):
                bases.append(base + "/v1")
            headers = {"Authorization": f"Bearer {api_key}"}
        else:
            bases = [normalize_base_url(base, "anthropic")]
            headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
        for resolved_base in bases:
            url = resolved_base + ("/models" if candidate == "openai" else "/v1/models")
            try:
                status, body = _get(url, headers, timeout)
            except urllib.error.HTTPError as exc:
                failures.append(f"http {exc.code}")
                continue
            except (urllib.error.URLError, TimeoutError, ValueError, OSError):
                failures.append("connection failed")
                continue
            if status != 200:
                failures.append(f"http {status}")
                continue
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                failures.append("invalid JSON")
                continue
            data = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(data, list) or any(
                not isinstance(item, dict) or not isinstance(item.get("id"), str)
                or not item["id"].strip() for item in data
            ):
                failures.append("invalid model list")
                continue
            ids = list(dict.fromkeys(item["id"] for item in data))
            result = ProbeResult(candidate, ids, base_url=resolved_base,
                                 status="discovered" if ids else "empty")
            if ids:
                return result
            if empty is None:
                empty = result
    if empty is not None:
        return empty
    return ProbeResult(preferred, [], protocol is None, base, "failed", ", ".join(dict.fromkeys(failures)))


def probe_endpoint(base_url: str, api_key: str, *, timeout: float = 2.5,
                   protocol: str | None = None) -> ProbeResult | None:
    """Return a validated list (possibly empty), or None when discovery fails."""
    result = resolve_endpoint(base_url, api_key, timeout=timeout, protocol=protocol)
    return None if result.status == "failed" else result


def resolve_endpoint(base_url: str, api_key: str, *, timeout: float = 2.5,
                     protocol: str | None = None) -> ProbeResult:
    if protocol is not None and protocol not in {"openai", "anthropic"}:
        raise ValueError("protocol must be openai or anthropic")
    return _discover(base_url, api_key, timeout, protocol)
