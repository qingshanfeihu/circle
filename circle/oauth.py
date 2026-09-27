"""OAuth login skeleton + mock provider for selftest / CIRCLE_OAUTH_MOCK=1."""

from __future__ import annotations

import os
import webbrowser
from pathlib import Path
from dataclasses import dataclass, field

SUPPORTED_OAUTH_PROVIDERS = ("anthropic", "openai", "github-copilot", "kimi-coding", "meta", "openrouter", "radius", "xai")


@dataclass(frozen=True)
class OAuthSession:
    provider: str
    access_token: str
    refresh_token: str = ""
    base_url: str = ""
    models: tuple[str, ...] = field(default_factory=tuple)
    engine: str = "langchain"
    provider_id: str = ""


class OAuthNotConfiguredError(RuntimeError):
    """Raised until a provider OAuth client is wired for this build."""


def start_oauth_login(provider: str, *, home: Path | None = None, on_prompt=None, on_event=None) -> OAuthSession:
    provider = provider.strip().lower()
    if provider not in SUPPORTED_OAUTH_PROVIDERS:
        raise ValueError(
            f"unsupported oauth provider {provider!r}; "
            f"expected one of {', '.join(SUPPORTED_OAUTH_PROVIDERS)}"
        )
    if os.environ.get("CIRCLE_OAUTH_MOCK", "").strip() in {"1", "true", "yes"}:
        models = (
            ("claude-mock-opus", "claude-mock-sonnet")
            if provider == "anthropic"
            else ("gpt-mock-4.1", "gpt-mock-4o")
        )
        return OAuthSession(
            provider=provider,
            access_token=f"mock-{provider}-token",
            refresh_token="mock-refresh",
            base_url=(
                "https://api.anthropic.com"
                if provider == "anthropic"
                else "https://api.openai.com/v1"
            ),
            models=models,
        )
    from circle.provider_bridge import bridge_events
    provider_id = "openai-codex" if provider == "openai" else provider
    try:
        for record in bridge_events("login", {"provider": provider_id}, home=home, timeout=600, on_prompt=on_prompt):
            if record.get("method") == "auth_event":
                event = record["params"]["event"]
                if on_event:
                    on_event(event)
                if event.get("type") == "auth_url":
                    webbrowser.open(event["url"])
            if "result" in record:
                result = record["result"]
                return OAuthSession(provider, "", models=tuple(result["models"]), engine="pi", provider_id=provider_id)
    except RuntimeError as exc:
        raise OAuthNotConfiguredError(str(exc)) from exc
    raise OAuthNotConfiguredError("Provider login returned no result")
