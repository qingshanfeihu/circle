"""OAuth login skeleton + mock provider for selftest / CIRCLE_OAUTH_MOCK=1."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

SUPPORTED_OAUTH_PROVIDERS = ("anthropic", "openai")


@dataclass(frozen=True)
class OAuthSession:
    provider: str
    access_token: str
    refresh_token: str = ""
    base_url: str = ""
    models: tuple[str, ...] = field(default_factory=tuple)


class OAuthNotConfiguredError(RuntimeError):
    """Raised until a provider OAuth client is wired for this build."""


def start_oauth_login(provider: str) -> OAuthSession:
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
    raise OAuthNotConfiguredError(
        f"{provider} OAuth client is not wired in this build yet; "
        "use API URL + KEY, or set CIRCLE_OAUTH_MOCK=1 for selftest"
    )
