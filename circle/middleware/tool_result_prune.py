"""Batch old tool-output pruning decisions in checkpoint state.

Raw ToolMessages remain available to the TUI and resume history. Once at least
20k tokens of unpruned output lie beyond the recent 40k-token window, their
message IDs are recorded together. Model requests always project those same
IDs to short stubs. Each batch also records the IDs of the already-existing AI
messages whose thinking blocks were invalidated by that batch.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, NotRequired

from langchain.agents.middleware.types import (
    AgentMiddleware,
    AgentState,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage, ToolMessage

logger = logging.getLogger(__name__)

_DEFAULT_PROTECT_TOKENS = 40_000
_HEAD_KEEP_CHARS = 160
_PRUNE_MINIMUM_TOKENS = 20_000
_PROTECTED_TOOLS = frozenset({"question", "skill"})
_CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF), (0x20000, 0x2A6DF))
_PRUNED_IDS = "_circle_pruned_tool_ids"
_STRIP_IDS = "_circle_strip_thinking_ids"
_THINKING_TYPES = frozenset({"thinking", "redacted_thinking"})


class PruneState(AgentState):
    _circle_pruned_tool_ids: NotRequired[list[str]]
    _circle_strip_thinking_ids: NotRequired[list[str]]


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


def _visible_raw_messages(state: Mapping[str, Any]) -> list[Any]:
    messages = list(state.get("messages") or [])
    event = state.get("_summarization_event")
    if isinstance(event, Mapping) and isinstance(event.get("cutoff_index"), int):
        return messages[max(0, event["cutoff_index"]):]
    return messages


def _new_prune_ids(messages: list[Any], old_ids: set[str]) -> list[str]:
    """Collect one batch outside the window; do not move an old boundary."""
    call_names = {
        call.get("id"): call.get("name")
        for msg in messages if isinstance(msg, AIMessage)
        for call in msg.tool_calls
    }

    def tool_name(message: ToolMessage) -> str:
        return message.name or call_names.get(message.tool_call_id) or ""

    latest_todos = next((m for m in reversed(messages)
                         if isinstance(m, ToolMessage) and tool_name(m) == "write_todos"), None)
    accumulated = 0
    candidates: list[tuple[str, int]] = []
    for message in reversed(messages):
        if not isinstance(message, ToolMessage) or not message.id or message.id in old_ids:
            continue
        if tool_name(message) in _PROTECTED_TOOLS or message is latest_todos:
            continue
        content = _content_str(message)
        if _is_complete_json_document(content):
            continue
        size = token_len(content)
        accumulated += size
        if accumulated > _protect_budget():
            candidates.append((message.id, size))
    if sum(size for _id, size in candidates) < _PRUNE_MINIMUM_TOKENS:
        return []
    return [id_ for id_, _size in reversed(candidates)]


def prune_messages(messages: list[Any], *, pruned_ids: set[str] | frozenset[str],
                   strip_thinking_ids: set[str] | frozenset[str] = frozenset()) -> list[Any]:
    """Project a persisted decision without changing any stored message."""
    if not pruned_ids and not strip_thinking_ids:
        return messages
    out = list(messages)
    for i, message in enumerate(messages):
        if isinstance(message, ToolMessage) and message.id in pruned_ids:
            text = _content_str(message)
            stub = (f"{text[:_HEAD_KEEP_CHARS]}\n…[older tool output pruned to free context: "
                    f"{len(text)} characters originally. Call the tool again if you need the "
                    "full text.]")
            out[i] = message.model_copy(update={"content": stub})
        elif (isinstance(message, AIMessage) and message.id in strip_thinking_ids
              and isinstance(message.content, list)):
            blocks = [b for b in message.content
                      if not (isinstance(b, dict) and b.get("type") in _THINKING_TYPES)]
            if len(blocks) != len(message.content):
                out[i] = message.model_copy(update={"content": blocks})
    return out


class ToolResultPruneMiddleware(AgentMiddleware):
    state_schema = PruneState

    def before_model(self, state: Mapping[str, Any], runtime: Any) -> dict[str, Any] | None:
        if not _enabled():
            return None
        old_ids = list(state.get(_PRUNED_IDS) or [])
        messages = _visible_raw_messages(state)
        new_ids = _new_prune_ids(messages, set(old_ids))
        if not new_ids:
            return None
        ids = {msg.id for msg in messages if msg.id in new_ids}
        first_index = next(i for i, msg in enumerate(messages) if msg.id in ids)
        newly_invalid = [msg.id for msg in messages[first_index + 1:]
                         if isinstance(msg, AIMessage) and msg.id]
        old_strip_ids = list(state.get(_STRIP_IDS) or [])
        logger.info("tool_result_prune: pruned %d old tool results", len(new_ids))
        return {_PRUNED_IDS: [*old_ids, *new_ids],
                _STRIP_IDS: list(dict.fromkeys([*old_strip_ids, *newly_invalid]))}

    async def abefore_model(self, state: Mapping[str, Any], runtime: Any) -> dict[str, Any] | None:
        return self.before_model(state, runtime)

    def _pruned(self, request: ModelRequest) -> ModelRequest:
        # The switch prevents future decisions. Existing checkpointed decisions
        # must keep projecting the same bytes even if the setting changes.
        state = request.state if isinstance(request.state, Mapping) else {}
        ids = frozenset(state.get(_PRUNED_IDS) or ())
        strip_ids = frozenset(state.get(_STRIP_IDS) or ())
        if not ids and not strip_ids:
            return request
        try:
            messages = prune_messages(request.messages, pruned_ids=ids,
                                      strip_thinking_ids=strip_ids)
            return request.override(messages=messages)
        except Exception:
            logger.debug("tool_result_prune failed; sending original messages", exc_info=True)
            return request

    def wrap_model_call(self, request: ModelRequest,
                        handler: Callable[[ModelRequest], ModelResponse]) -> ModelResponse:
        return handler(self._pruned(request))

    async def awrap_model_call(self, request: ModelRequest,
                               handler: Callable[[ModelRequest], Awaitable[ModelResponse]]
                               ) -> ModelResponse:
        return await handler(self._pruned(request))
