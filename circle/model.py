"""Build a chat model from Circle settings — never infer provider from model name.

Bare names like ``grok-4.7`` would otherwise resolve to ChatXAI via
``init_chat_model`` heuristics. Circle always uses the probed protocol
(openai | anthropic) plus the saved base_url / credentials.

Thinking depth (``CIRCLE_REASONING_EFFORT``, default ``xhigh`` on the Anthropic
protocol) is fitted to the model family by ``apply_reasoning``; the built model is
wrapped by ``circle.model_guard`` (retries, dropped parameters, stall and repetition
guards). Circle never turns thinking off, so models that cannot disable it (Opus 5.5
and later) need no special case.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from langchain.chat_models import init_chat_model
from langchain_core.language_models.chat_models import BaseChatModel

from circle.model_guard import guard_model
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


def reasoning_effort_of(model: Any) -> str:
    """Configured thinking strength, if the client actually set one."""
    if model is None:
        return (os.environ.get("CIRCLE_REASONING_EFFORT") or "").strip()
    effort = getattr(model, "reasoning_effort", None)
    if effort:
        return str(effort)
    output_config = getattr(model, "output_config", None)
    if isinstance(output_config, dict) and output_config.get("effort"):
        return str(output_config["effort"])
    extra = getattr(model, "extra_body", None)
    if isinstance(extra, dict):
        if extra.get("reasoning_effort"):
            return str(extra["reasoning_effort"])
        thinking = extra.get("thinking")
        if isinstance(thinking, dict) and thinking.get("type"):
            return str(thinking["type"])
    return (os.environ.get("CIRCLE_REASONING_EFFORT") or "").strip()


_EFFORT_ORDER = ("minimal", "low", "medium", "high", "xhigh", "max")
# budget 族（目录里有、但不声明 effort 档位的老 Claude）：档位 → thinking.budget_tokens
_BUDGET_BY_EFFORT = {"minimal": 1024, "low": 2048, "medium": 8192, "high": 16000,
                     "xhigh": 16000, "max": 31999}


def _clamp_effort(requested: str, levels: list[str]) -> str:
    """Highest supported level not above the request; the lowest one if all are above."""
    rank = {name: i for i, name in enumerate(_EFFORT_ORDER)}
    want = rank.get(requested, len(_EFFORT_ORDER))
    known = sorted((lvl for lvl in levels if lvl in rank), key=rank.__getitem__)
    below = [lvl for lvl in known if rank[lvl] <= want]
    return (below or known or [requested])[-1 if below else 0]


def apply_reasoning(model: Any, effort: str, protocol: str) -> Any:
    """Fit the requested thinking depth to what the model family accepts.

    Anthropic protocol, judged from the provider's model catalog (``model.profile``):
    a model that lists effort levels gets the closest level not above the request; a
    catalogued Claude without levels (the thinking-budget generation) gets a thinking
    budget instead; a Claude name the catalog does not know yet is newer than it and
    gets adaptive thinking plus effort; other models get the effort as asked. Whatever
    the endpoint still rejects is dropped by the model guard. OpenAI protocol: effort is
    sent only when ``CIRCLE_REASONING_EFFORT`` is set.
    """
    if not effort or not isinstance(model, BaseChatModel):
        return model
    if protocol != "anthropic":
        if (os.environ.get("CIRCLE_REASONING_EFFORT") or "").strip() and hasattr(
                model, "reasoning_effort"):
            model.reasoning_effort = effort
        return model
    name = str(getattr(model, "model", "") or "").rsplit("/", 1)[-1].lower()
    profile = getattr(model, "profile", None) or {}
    levels = profile.get("reasoning_effort_levels") if isinstance(profile, dict) else None
    claude = name.startswith("claude")
    if levels:
        model.reasoning_effort = _clamp_effort(effort, list(levels))
    elif claude and profile:
        model.reasoning_effort = None
        budget = _BUDGET_BY_EFFORT.get(effort, _BUDGET_BY_EFFORT["high"])
        if int(getattr(model, "max_tokens", 0) or 0) <= budget:
            model.max_tokens = budget + 8192
        model.thinking = {"type": "enabled", "budget_tokens": budget}
    elif claude:
        model.reasoning_effort = effort
        model.thinking = {"type": "adaptive"}
        # 目录不认识的名字拿到的是 SDK 的 4096 缺省，思考会吃掉大半输出额度
        if int(getattr(model, "max_tokens", 0) or 0) <= 4096:
            model.max_tokens = 32000
    else:
        model.reasoning_effort = effort
        # 目录外的非 Claude 模型同样拿到 SDK 的 4096 缺省：思考先把额度吃光，回合以空回答结束
        if int(getattr(model, "max_tokens", 0) or 0) <= 4096:
            model.max_tokens = 32000
    return model


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
    effort = (os.environ.get("CIRCLE_REASONING_EFFORT") or "xhigh").strip()
    kwargs: dict[str, Any] = {
        "model_provider": "anthropic" if auth.protocol == "anthropic" else "openai",
        "api_key": api_key,
        "streaming": True,
        "timeout": timeout,
        # 重试交给 circle.model_guard 按错误类型分预算做；SDK 再重试会让次数相乘
        "max_retries": 0,
    }
    if auth.protocol == "anthropic" and effort:
        kwargs["reasoning_effort"] = effort
    if auth.base_url:
        kwargs["base_url"] = auth.base_url

    model = init_chat_model(model_name, **kwargs)
    apply_reasoning(model, effort, auth.protocol)
    return guard_model(model)
