"""First-run init: API URL+KEY or OAuth, then protocol probe + model pick."""

from __future__ import annotations

import getpass
from pathlib import Path

from circle.oauth import OAuthNotConfiguredError, start_oauth_login
from circle.probe import fallback_model_list, probe_endpoint
from circle.settings import (
    CircleSettings,
    ModelAuth,
    save_credentials,
    save_settings,
)


def _prompt(label: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    raw = input(f"{label}{suffix}: ").strip()
    return raw or default


def _pick(label: str, options: list[str]) -> str:
    if not options:
        raise ValueError("no options to pick")
    print(label)
    for i, opt in enumerate(options, 1):
        print(f"  [{i}] {opt}")
    while True:
        raw = input("选择序号: ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            return options[int(raw) - 1]
        print("无效序号，请重试。")


def run_init(*, home: Path | None = None) -> CircleSettings:
    """Interactive init. Returns saved settings."""
    print("Circle 初始化")
    print("接入方式:")
    print("  [1] API URL + KEY（自动探测 OpenAI 兼容 / Anthropic）")
    print("  [2] OAuth 登录（Anthropic / OpenAI 账号）")
    mode_pick = _prompt("选择", "1")

    if mode_pick == "2":
        return _init_oauth(home=home)
    return _init_api_key(home=home)


def _init_api_key(*, home: Path | None) -> CircleSettings:
    base_url = _prompt("API URL")
    api_key = getpass.getpass("API KEY: ").strip()
    if not base_url or not api_key:
        raise SystemExit("URL 与 KEY 都是必填项")

    print("正在探测协议…")
    probed = probe_endpoint(base_url, api_key)
    if probed is None:
        print("无法探测端点，按 OpenAI 兼容处理，使用内置模型列表。")
        protocol = "openai"
        models = fallback_model_list()
    else:
        protocol = probed.protocol
        models = probed.models or fallback_model_list()
        label = "OpenAI 兼容" if protocol == "openai" else "Anthropic Messages"
        print(f"检测到 {label}，共 {len(models)} 个模型。")

    model = _pick("选择主模型:", models)
    settings = CircleSettings(
        initialized=True,
        auth=ModelAuth(
            mode="api_key",
            protocol=protocol,
            base_url=base_url.rstrip("/"),
            model=model,
        ),
    )
    save_credentials({"api_key": api_key}, home)
    save_settings(settings, home)
    print("已写入 ~/.circle/settings.json 与 credentials.json")
    return settings


def _init_oauth(*, home: Path | None) -> CircleSettings:
    provider = _pick("OAuth 提供方:", ["anthropic", "openai"])
    try:
        session = start_oauth_login(provider)
    except OAuthNotConfiguredError as exc:
        print(str(exc))
        print("回落到 API URL + KEY。")
        return _init_api_key(home=home)

    models = fallback_model_list()
    model = _pick("选择主模型:", models)
    settings = CircleSettings(
        initialized=True,
        auth=ModelAuth(
            mode="oauth",
            protocol="anthropic" if provider == "anthropic" else "openai",
            base_url=session.base_url,
            model=model,
            oauth_provider=provider,
            api_key_ref="oauth_access_token",
        ),
    )
    save_credentials(
        {
            "oauth_access_token": session.access_token,
            "oauth_refresh_token": session.refresh_token,
        },
        home,
    )
    save_settings(settings, home)
    print("已写入 ~/.circle/settings.json 与 credentials.json")
    return settings


def complete_api_key_init(
    *,
    base_url: str,
    api_key: str,
    model: str | None = None,
    home: Path | None = None,
    probe=probe_endpoint,
) -> CircleSettings:
    """Non-interactive init used by tests and scripted installs."""
    probed = probe(base_url, api_key)
    if probed is None:
        protocol = "openai"
        models = fallback_model_list()
    else:
        protocol = probed.protocol
        models = probed.models or fallback_model_list()
    chosen = model or (models[0] if models else fallback_model_list()[0])
    settings = CircleSettings(
        initialized=True,
        auth=ModelAuth(
            mode="api_key",
            protocol=protocol,
            base_url=base_url.rstrip("/"),
            model=chosen,
        ),
    )
    save_credentials({"api_key": api_key}, home)
    save_settings(settings, home)
    return settings
