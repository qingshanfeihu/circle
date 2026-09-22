"""Build a chat model from Circle settings — never infer provider from model name.

Bare names like ``grok-4.7`` would otherwise resolve to ChatXAI via
``init_chat_model`` heuristics. Circle always uses the probed protocol
(openai | anthropic) plus the saved base_url / credentials.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from langchain.chat_models import init_chat_model
from langchain_core.language_models.chat_models import BaseChatModel

from circle.settings import CircleSettings, load_credentials

# Hard ceiling so a dead gateway cannot leave the TUI on "深度思考中" for minutes.
_DEFAULT_TIMEOUT_S = 45.0


def _request_timeout_s() -> float:
    raw = (os.environ.get("CIRCLE_LLM_TIMEOUT") or "").strip()
    if raw:
        try:
            return max(5.0, float(raw))
        except ValueError:
            pass
    return _DEFAULT_TIMEOUT_S


def build_chat_model(
    settings: CircleSettings,
    *,
    home: Path | None = None,
    model_override: str | BaseChatModel | None = None,
) -> BaseChatModel:
    if isinstance(model_override, BaseChatModel):
        return model_override

    auth = settings.auth
    model_name = model_override if isinstance(model_override, str) else auth.model
    if not model_name:
        raise ValueError("no model name in settings; re-run circle --init")

    creds = load_credentials(home)
    api_key = (
        creds.get(auth.api_key_ref)
        or creds.get("api_key")
        or creds.get("oauth_access_token")
        or ""
    )
    if not api_key:
        raise ValueError(
            "missing API key in ~/.circle/credentials.json; re-run circle --init"
        )

    timeout = _request_timeout_s()
    kwargs: dict[str, Any] = {
        "model_provider": "anthropic" if auth.protocol == "anthropic" else "openai",
        "api_key": api_key,
        "streaming": True,
        "timeout": timeout,
        "max_retries": 1,
    }
    if auth.base_url:
        kwargs["base_url"] = auth.base_url

    return init_chat_model(model_name, **kwargs)
