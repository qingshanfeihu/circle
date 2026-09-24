"""Cut old tool outputs to a short head once the recent ones fill a protected window.

Walking from the newest message backwards, tool outputs are counted against
``CIRCLE_PRUNE_PROTECT_TOKENS`` (default 40k); everything older than the window is
replaced by its first 160 characters plus a note — but only when that frees at least
20k tokens, so short sessions are never touched. Complete JSON documents and the
``question``/``skill`` results are kept verbatim (they are small and load-bearing).
Only the request sent to the model changes; the stored conversation is untouched.
``CIRCLE_PRUNE_TOOL_OUTPUTS=0`` turns it off.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Awaitable, Callable

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ModelResponse

logger = logging.getLogger(__name__)

_DEFAULT_PROTECT_TOKENS = 40_000
_HEAD_KEEP_CHARS = 160
_PRUNE_MINIMUM_TOKENS = 20_000
_PROTECTED_TOOLS = frozenset({"question", "skill"})
_CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x2A6DF))


def _enabled() -> bool:
    return (os.environ.get("CIRCLE_PRUNE_TOOL_OUTPUTS") or "1").strip().lower() not in (
        "0", "false", "no", "off")


def _protect_budget() -> int:
    try:
        return int(os.environ.get("CIRCLE_PRUNE_PROTECT_TOKENS") or _DEFAULT_PROTECT_TOKENS)
    except (TypeError, ValueError):
        return _DEFAULT_PROTECT_TOKENS


def token_len(text: str) -> int:
    """Rough count: one token per CJK character, four characters per token otherwise."""
    cjk = other = 0
    for ch in text:
        code = ord(ch)
        if any(lo <= code <= hi for lo, hi in _CJK_RANGES):
            cjk += 1
        else:
            other += 1
    return cjk + max(0, (other + 3) // 4)


def _is_complete_json_document(text: str) -> bool:
    if not text.lstrip().startswith(("{", "[")):
        return False
    try:
        payload = json.loads(text)
    except (TypeError, ValueError, RecursionError):
        return False
    return isinstance(payload, (dict, list))


def _content_str(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text", "")) if isinstance(b, dict) else str(b) for b in content)
    return str(content or "")


def prune_messages(messages: list) -> list:
    budget = _protect_budget()
    accumulated = 0
    prune_idx: list[int] = []
    sizes: dict[int, int] = {}
    for i in range(len(messages) - 1, -1, -1):
        message = messages[i]
        if getattr(message, "type", "") != "tool":
            continue
        if (getattr(message, "name", "") or "") in _PROTECTED_TOOLS:
            continue
        text = _content_str(message)
        if _is_complete_json_document(text):
            continue
        sizes[i] = token_len(text)
        accumulated += sizes[i]
        if accumulated > budget:
            prune_idx.append(i)
    if not prune_idx:
        return messages
    prunable = sum(sizes[i] for i in prune_idx)
    if prunable < _PRUNE_MINIMUM_TOKENS:
        return messages
    out = list(messages)
    for i in prune_idx:
        text = _content_str(out[i])
        stub = (f"{text[:_HEAD_KEEP_CHARS]}\n…[older tool output pruned to free context: "
                f"{len(text)} characters originally. Call the tool again if you need the full "
                "text.]")
        try:
            out[i] = out[i].model_copy(update={"content": stub})
        except Exception:  # noqa: BLE001 — not a pydantic message; leave it as is
            continue
    logger.info("tool_result_prune: pruned %d old tool results (~%d tokens)", len(prune_idx), prunable)
    return out


class ToolResultPruneMiddleware(AgentMiddleware):
    def _pruned(self, request: ModelRequest) -> ModelRequest:
        if not _enabled():
            return request
        try:
            messages = list(getattr(request, "messages", None) or [])
            out = prune_messages(messages)
            return request if out is messages else request.override(messages=out)
        except Exception:  # noqa: BLE001 — pruning must never break the turn
            logger.debug("tool_result_prune failed; sending the original messages", exc_info=True)
            return request

    def wrap_model_call(self, request: ModelRequest,
                        handler: Callable[[ModelRequest], ModelResponse]) -> ModelResponse:
        return handler(self._pruned(request))

    async def awrap_model_call(self, request: ModelRequest,
                               handler: Callable[[ModelRequest], Awaitable[ModelResponse]]
                               ) -> ModelResponse:
        return await handler(self._pruned(request))
