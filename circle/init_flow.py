"""First-run init: API URL+KEY or OAuth, then protocol probe + model pick."""

from __future__ import annotations

import getpass
from pathlib import Path

from circle.oauth import OAuthNotConfiguredError, start_oauth_login
from circle.probe import normalize_base_url, resolve_endpoint
from circle.settings import (
    CircleSettings,
    ModelAuth,
    load_credentials,
    load_settings,
    save_credentials,
    save_settings,
    with_connection,
)


def _prompt(label: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    raw = input(f"{label}{suffix}: ").strip()
    return raw or default


def _pick(label: str, options: list[str], *, other: bool = False) -> str:
    """One of ``options`` by number; with ``other``, any text typed instead (a model id)."""
    if not options:
        raise ValueError("no options to pick")
    print(label)
    for i, opt in enumerate(options, 1):
        print(f"  [{i}] {opt}")
    while True:
        raw = input("number, or a model id: " if other else "number: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return options[int(raw) - 1]
        if other and raw and not raw.isdigit():
            return raw
        print("Pick one of the numbers.")


def _pick_model(models: list[str]) -> str:
    if models:
        print("Model (a number, or any model id; an id that is not listed is not checked):")
    else:
        print("Model id (the endpoint listed none, so it is not checked):")
    for i, model in enumerate(models, 1):
        print(f"  [{i}] {model}")
    while True:
        raw = input("model: ").strip()
        if raw.isdigit() and models:
            if 1 <= int(raw) <= len(models):
                return models[int(raw) - 1]
        elif raw:
            return raw
        print("Type a model id, or one of the numbers.")


def run_init(*, home: Path | None = None) -> CircleSettings:
    """Interactive init. Returns saved settings."""
    print("Set up Circle")
    print("How does Circle reach your model?")
    print("  [1] API URL + KEY (OpenAI-style or Anthropic-style API)")
    print("  [2] OAuth sign-in (not available yet)")
    mode_pick = _prompt("choose", "1")

    if mode_pick == "2":
        return _init_oauth(home=home)
    return _init_api_key(home=home)


def _saved_connection(home: Path | None) -> tuple[str, str]:
    """The URL and key setup ran with before, to keep when nothing new is typed."""
    try:
        previous = load_settings(home)
        if previous.initialized and previous.auth.mode == "api_key":
            key = load_credentials(home).get(previous.auth.api_key_ref or "api_key", "")
            return previous.auth.base_url, key
    except (OSError, ValueError):
        pass
    return "", ""


def _init_api_key(*, home: Path | None) -> CircleSettings:
    saved_url, saved_key = _saved_connection(home)
    base_url = _prompt("API URL", saved_url)
    api_key = getpass.getpass("API KEY (enter keeps the saved one): " if saved_key
                              else "API KEY: ").strip() or saved_key
    if not base_url or not api_key:
        raise SystemExit("Both the URL and the key are needed.")

    try:
        base_url = normalize_base_url(base_url, "openai")
    except ValueError as exc:
        raise SystemExit(f"Not an API URL: {exc}") from exc
    print("Asking the endpoint for its models…")
    probed = resolve_endpoint(base_url, api_key)
    protocol = probed.protocol
    print(probed.summary())
    if probed.inferred or probed.status == "failed":
        protocol = _pick("Which kind of API is it?", ["openai", "anthropic"])
    base_url = normalize_base_url(probed.base_url or base_url, protocol)
    model = _pick_model(probed.models)
    settings = with_connection(ModelAuth(
        mode="api_key",
        protocol=protocol,
        base_url=base_url.rstrip("/"),
        model=model,
    ), home)
    save_credentials({"api_key": api_key}, home)
    save_settings(settings, home)
    print("Saved settings.json and credentials.json in the data folder.")
    return settings


def _init_oauth(*, home: Path | None) -> CircleSettings:
    provider = _pick("Sign in with:", ["anthropic", "openai"])
    try:
        session = start_oauth_login(provider)
    except OAuthNotConfiguredError as exc:
        print(str(exc))
        print("Using an API URL and key instead.")
        return _init_api_key(home=home)

    model = _pick_model(list(session.models))
    settings = with_connection(ModelAuth(
        mode="oauth",
        protocol="anthropic" if provider == "anthropic" else "openai",
        base_url=session.base_url,
        model=model,
        oauth_provider=provider,
        api_key_ref="oauth_access_token",
    ), home)
    save_credentials(
        {
            "oauth_access_token": session.access_token,
            "oauth_refresh_token": session.refresh_token,
        },
        home,
    )
    save_settings(settings, home)
    print("Saved settings.json and credentials.json in the data folder.")
    return settings


def complete_api_key_init(
    *,
    base_url: str,
    api_key: str,
    model: str | None = None,
    home: Path | None = None,
    protocol: str | None = None,
    probe=None,
) -> CircleSettings:
    """Non-interactive init used by tests and scripted installs."""
    if not api_key.strip():
        raise ValueError("API key is required")
    base_url = normalize_base_url(base_url, protocol or "openai")
    probed = resolve_endpoint(base_url, api_key, protocol=protocol) if probe is None else probe(base_url, api_key)
    if probed is None or probed.inferred or probed.status == "failed":
        if not protocol or not model or not model.strip():
            raise ValueError("discovery failed; specify both protocol and model for manual configuration")
        models = []
    else:
        if protocol and probed.protocol != protocol:
            raise ValueError("discovered protocol does not match requested protocol")
        protocol = probed.protocol
        models = probed.models
        base_url = probed.base_url or base_url
    chosen = (model or "").strip() or (models[0] if models else "")
    if not chosen:
        raise ValueError("no models discovered; specify a model id for manual configuration")
    base_url = normalize_base_url(base_url, protocol)
    settings = with_connection(ModelAuth(
        mode="api_key",
        protocol=protocol,
        base_url=base_url.rstrip("/"),
        model=chosen,
    ), home)
    save_credentials({"api_key": api_key}, home)
    save_settings(settings, home)
    return settings
