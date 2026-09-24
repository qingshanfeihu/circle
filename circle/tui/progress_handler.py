"""LangChain callback handler that turns an agent run into bus events for the screen.

Ported from InfoTest's ``_MainAgentProgressHandler`` (``main/ist_core/graph.py``) with
the compile-engine hooks left out:

- each model round goes through ``TypedDisplayStreamNormalizer``, so reasoning and
  answer text arrive as separate channels with the round clock and a title when the
  reasoning opens with ``**…**``;
- usage is extracted once per call (OpenAI and Anthropic shapes) and priced;
- tool results carry ``ToolMessage.status`` and the recoverable flag, so the screen
  can tell a real failure from one the model can fix;
- ``write_todos`` updates become ``todo_list`` events;
- events from a subagent carry ``parent_subagent`` (from ``lc_agent_name``);
- model calls marked internal by middleware (summarization, ``/compact``) are not
  shown as conversation.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler

from circle.display_stream import TypedDisplayStreamNormalizer, event_deltas, extract_display_channels
from circle.events import EventBus
from circle.pricing import callback_model_name, price_call, response_model_name
from circle.tool_recoverable import RECOVERABLE_KEY, is_recoverable_message

logger = logging.getLogger(__name__)

_INTERNAL_CALL_KEY = "lc_internal_call"
_INPUT_CAP = 400
_LARGE_INPUT_TOOLS = frozenset({"write_todos", "task"})


# ── usage extraction (InfoTest graph.py) ───────────────────────────────────


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    dump = getattr(value, "model_dump", None)
    if not callable(dump):
        return {}
    try:
        result = dump(mode="json")
    except TypeError:
        result = dump()
    return dict(result) if isinstance(result, Mapping) else {}


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _pos_int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _anthropic_sdk_usage(raw_value: Any) -> dict[str, Any]:
    raw = _mapping(raw_value)
    if not raw or not ({"input_tokens", "output_tokens"} & set(raw)):
        return {}
    cache_read = _int(raw.get("cache_read_input_tokens"))
    cache_creation = _int(raw.get("cache_creation_input_tokens"))
    breakdown = _mapping(raw.get("cache_creation"))
    ttl_keys = ("ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")
    ttl_total = sum(_int(breakdown.get(key)) for key in ttl_keys)
    details: dict[str, int] = {}
    if raw.get("cache_read_input_tokens") is not None:
        details["cache_read"] = cache_read
    if raw.get("cache_creation_input_tokens") is not None:
        details["cache_creation"] = 0 if ttl_total else cache_creation
    for key in ttl_keys:
        if breakdown.get(key) is not None:
            details[key] = _int(breakdown.get(key))
    input_tokens = _int(raw.get("input_tokens")) + cache_read + (ttl_total or cache_creation)
    output_tokens = _int(raw.get("output_tokens"))
    usage: dict[str, Any] = {"input_tokens": input_tokens, "output_tokens": output_tokens,
                             "total_tokens": input_tokens + output_tokens}
    if details:
        usage["input_token_details"] = details
    return usage


def _generic_sdk_usage(raw_value: Any) -> dict[str, Any]:
    usage = _mapping(raw_value)
    if "input_tokens" not in usage and "prompt_tokens" in usage:
        usage["input_tokens"] = _int(usage.get("prompt_tokens"))
    if "output_tokens" not in usage and "completion_tokens" in usage:
        usage["output_tokens"] = _int(usage.get("completion_tokens"))
    return usage


def _merge_missing(primary: dict[str, Any], fallback: dict[str, Any]) -> None:
    for key, value in fallback.items():
        current = primary.get(key)
        if isinstance(current, Mapping) and isinstance(value, Mapping):
            merged = dict(current)
            for nested_key, nested_value in value.items():
                merged.setdefault(nested_key, nested_value)
            primary[key] = merged
        elif key not in primary:
            primary[key] = value


def _cache_read(usage: dict[str, Any]) -> int:
    details = _mapping(usage.get("input_token_details"))
    prompt = _mapping(usage.get("prompt_tokens_details"))
    return next((v for c in (usage.get("prompt_cache_hit_tokens"), details.get("cache_read"),
                             prompt.get("cached_tokens"), usage.get("cached_tokens"))
                 if (v := _pos_int(c))), 0)


def _cache_write(usage: dict[str, Any]) -> int:
    details = _mapping(usage.get("input_token_details"))
    prompt = _mapping(usage.get("prompt_tokens_details"))
    ttl = sum(_pos_int(details.get(k)) for k in ("ephemeral_5m_input_tokens",
                                                   "ephemeral_1h_input_tokens"))
    return next((v for c in (usage.get("prompt_cache_write_tokens"), ttl,
                             details.get("cache_creation"),
                             prompt.get("cache_creation_input_tokens"),
                             prompt.get("cache_write_tokens")) if (v := _pos_int(c))), 0)


def _finalize(usage: dict[str, Any], *, primary: dict[str, Any] | None = None) -> dict[str, Any]:
    preferred = primary or {}
    details = _mapping(usage.get("input_token_details"))
    write = _cache_write(preferred) or _cache_write(usage)
    if write:
        usage["prompt_cache_write_tokens"] = write
        usage["prompt_cache_write_1h_tokens"] = _pos_int(
            preferred.get("prompt_cache_write_1h_tokens")
            if "prompt_cache_write_1h_tokens" in preferred
            else usage.get("prompt_cache_write_1h_tokens", details.get("ephemeral_1h_input_tokens")))
    hit = _cache_read(preferred) or _cache_read(usage)
    if hit:
        usage["prompt_cache_hit_tokens"] = hit
    if ("prompt_cache_hit_tokens" in usage or "prompt_cache_write_tokens" in usage) and (
            "input_tokens" in usage or "prompt_tokens" in usage):
        usage["prompt_cache_miss_tokens"] = max(
            _int(usage.get("input_tokens", usage.get("prompt_tokens")))
            - _int(usage.get("prompt_cache_hit_tokens")) - _int(usage.get("prompt_cache_write_tokens")),
            0)
    if "input_tokens" not in usage and "prompt_tokens" in usage:
        usage["input_tokens"] = _int(usage.get("prompt_tokens"))
    if "output_tokens" not in usage and "completion_tokens" in usage:
        usage["output_tokens"] = _int(usage.get("completion_tokens"))
    if "total_tokens" not in usage and ("input_tokens" in usage or "output_tokens" in usage):
        usage["total_tokens"] = _int(usage.get("input_tokens")) + _int(usage.get("output_tokens"))
    return usage


def extract_message_usage(message: Any, *, token_usage: Any = None,
                          anthropic_usage: Any = None) -> dict[str, Any]:
    standard = _mapping(getattr(message, "usage_metadata", None))
    metadata = _mapping(getattr(message, "response_metadata", None))
    generic = _generic_sdk_usage(token_usage if token_usage is not None
                                 else metadata.get("token_usage"))
    anthropic = _anthropic_sdk_usage(anthropic_usage if anthropic_usage is not None
                                     else metadata.get("usage"))
    if standard:
        usage = dict(standard)
        _merge_missing(usage, generic)
        _merge_missing(usage, anthropic)
        return _finalize(usage, primary=standard)
    usage = generic or anthropic
    if generic and anthropic:
        usage = dict(generic)
        _merge_missing(usage, anthropic)
    return _finalize(dict(usage)) if usage else {}


def extract_llm_usage(response: Any) -> dict[str, Any]:
    try:
        generations = getattr(response, "generations", None) or []
        message = (getattr(generations[0][0], "message", None)
                   if generations and generations[0] else None)
        llm_output = _mapping(getattr(response, "llm_output", None))
        return extract_message_usage(message, token_usage=llm_output.get("token_usage"),
                                     anthropic_usage=llm_output.get("usage"))
    except Exception:  # noqa: BLE001 — usage is display-only
        return {}


def sanitize_tool_inputs(inputs: Any, *, cap: int = _INPUT_CAP) -> dict[str, Any]:
    if not isinstance(inputs, Mapping):
        return {}
    out: dict[str, Any] = {}
    for key, value in inputs.items():
        if not isinstance(key, str):
            continue
        if isinstance(value, str):
            out[key] = value[:cap]
        elif isinstance(value, (int, float, bool)) or value is None:
            out[key] = value
    return out


# ── the handler ────────────────────────────────────────────────────────────


class ProgressHandler(BaseCallbackHandler):
    """One per run; emits to ``bus``."""

    def __init__(self, bus: EventBus) -> None:
        self._bus = bus
        self._chat_idx = 0
        self._tool_name_stack: list[str] = []
        self._seen_tool_run_ids: set[str] = set()
        self._internal_runs: set[str] = set()
        self._lock = threading.RLock()
        self._runs: dict[str, TypedDisplayStreamNormalizer] = {}
        self._run_tags: dict[str, dict[str, Any]] = {}
        self._run_names: dict[str, str] = {}
        self._pricing_models: dict[str, str] = {}
        self._settled_usage_ids: set[str] = set()
        # 结束回调不带 metadata：子代理标签按工具 run id 从开始时记下的那份取
        self._tool_tags: dict[str, dict[str, Any]] = {}
        # 回调的父运行链：子代理事件沿链找到它属于哪一次 task 调用（并行子代理不串）
        self._parents: dict[str, str] = {}
        self._task_runs: set[str] = set()

    def _emit(self, kind: str, *, payload: dict[str, Any] | None = None,
              tags: dict[str, Any] | None = None, usage: dict[str, Any] | None = None) -> None:
        try:
            self._bus.emit(kind, payload=payload, tags=tags, usage=usage)  # type: ignore[arg-type]
        except Exception:  # noqa: BLE001 — display must never break the run
            logger.debug("progress emit failed: %s", kind, exc_info=True)

    @staticmethod
    def _key(kwargs: dict) -> str:
        rid = str(kwargs.get("run_id") or "")
        return rid or f"anon:{threading.get_ident()}"

    def _note_parent(self, kwargs: dict) -> None:
        run_id, parent = str(kwargs.get("run_id") or ""), str(kwargs.get("parent_run_id") or "")
        if run_id and parent:
            with self._lock:
                self._parents[run_id] = parent

    def _task_ancestor(self, run_id: str) -> str:
        seen = 0
        current = self._parents.get(run_id, "")
        while current and seen < 256:
            if current in self._task_runs:
                return current
            current = self._parents.get(current, "")
            seen += 1
        return ""

    def _subagent_tags(self, kwargs: dict, base: dict | None = None) -> dict:
        tags = dict(base or {})
        agent = str((kwargs.get("metadata") or {}).get("lc_agent_name") or "")
        if agent:
            tags["parent_subagent"] = agent
            with self._lock:
                task_run = self._task_ancestor(str(kwargs.get("run_id") or ""))
            if task_run:
                tags["parent_tool_use_id"] = task_run
        return tags

    def on_chain_start(self, serialized: Any, inputs: Any, **kwargs: Any) -> None:
        self._note_parent(kwargs)

    @staticmethod
    def _is_internal(kwargs: dict) -> bool:
        meta = kwargs.get("metadata") or {}
        return bool(meta.get(_INTERNAL_CALL_KEY)) or meta.get("lc_source") == "summarization"

    # model rounds

    def on_chat_model_start(self, serialized: Any, messages: Any, **kwargs: Any) -> None:
        try:
            self._note_parent(kwargs)
            key = self._key(kwargs)
            if self._is_internal(kwargs):
                with self._lock:
                    self._internal_runs.add(key)
                return
            tags = self._subagent_tags(kwargs)
            name = str(serialized.get("name") or "") if isinstance(serialized, dict) else ""
            normalizer = TypedDisplayStreamNormalizer()
            pricing_model = callback_model_name(serialized, metadata=kwargs.get("metadata"),
                                                invocation_params=kwargs.get("invocation_params"))
            with self._lock:
                if not tags.get("parent_subagent"):
                    normalizer.round_n = self._chat_idx
                normalizer.start()
                if not tags.get("parent_subagent"):
                    self._chat_idx = normalizer.round_n
                self._runs[key] = normalizer
                self._run_tags[key] = dict(tags)
                self._run_names[key] = name
                self._pricing_models[key] = pricing_model
            self._emit("llm_start", payload={"name": name, **normalizer.carrier_fields()},
                       tags=tags or None)
        except Exception:  # noqa: BLE001
            logger.debug("llm_start projection failed", exc_info=True)

    def on_llm_new_token(self, token: str, **kwargs: Any) -> None:
        try:
            key = self._key(kwargs)
            with self._lock:
                if key in self._internal_runs:
                    return
                normalizer = self._runs.get(key)
                tags = dict(self._run_tags.get(key) or {})
                name = str(self._run_names.get(key) or "")
                if normalizer is None:
                    normalizer = TypedDisplayStreamNormalizer()
                    normalizer.start()
                    self._runs[key] = normalizer
                chunk = kwargs.get("chunk")
                events = normalizer.observe(chunk if chunk is not None else {"content": str(token or "")})
                fields = normalizer.carrier_fields()
            deltas = event_deltas(events)
            if deltas.reasoning or deltas.text:
                self._emit("llm_token", payload={"name": name, "content": deltas.text,
                                                 "reasoning": deltas.reasoning, **fields},
                           tags=tags or None)
        except Exception:  # noqa: BLE001
            logger.debug("llm token projection failed", exc_info=True)

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        key = self._key(kwargs)
        rid = str(kwargs.get("run_id") or "")
        with self._lock:
            if key in self._internal_runs:
                self._internal_runs.discard(key)
                return
        channels = extract_display_channels(response)
        text, thinking_text = channels.text, channels.reasoning
        has_tool_calls = False
        usage: dict[str, Any] = {}
        try:
            gens = getattr(response, "generations", None) or []
            if gens and gens[0]:
                first = gens[0][0]
                msg = getattr(first, "message", None)
                if msg is not None:
                    extra = getattr(msg, "additional_kwargs", None) or {}
                    has_tool_calls = bool(getattr(msg, "tool_calls", None)) or bool(extra.get("tool_calls"))
                if not text:
                    text = getattr(first, "text", "") or ""
            usage = extract_llm_usage(response)
        except Exception:  # noqa: BLE001
            text = ""
        text = (text or "").strip()
        tags = self._subagent_tags(kwargs)
        with self._lock:
            normalizer = self._runs.pop(key, None)
            stored = dict(self._run_tags.pop(key, {}) or {})
            name = str(self._run_names.pop(key, "") or "")
            pricing_model = self._pricing_models.pop(key, "")
            typed = normalizer.finish(response) if normalizer is not None else []
            fields = normalizer.carrier_fields() if normalizer is not None else {}
        if not tags.get("parent_subagent") and stored.get("parent_subagent"):
            tags.update(stored)
        replay = event_deltas(typed)
        if replay.reasoning or replay.text:
            self._emit("llm_token", payload={"name": name, "content": replay.text,
                                             "reasoning": replay.reasoning, **fields},
                       tags=tags or None)
        if usage and tags.get("parent_subagent"):
            self._emit("llm_end", payload={"name": "subagent_usage", **fields}, tags=tags, usage=usage)
        if usage and not tags.get("parent_subagent"):
            with self._lock:
                duplicate = bool(rid and rid in self._settled_usage_ids)
                if rid:
                    self._settled_usage_ids.add(rid)
            if not duplicate:
                reported = response_model_name(response)
                cost = price_call(pricing_model or reported, usage)
                cost["response_model"] = reported
                self._emit("llm_end", payload={"name": "usage_only", **fields, "usage_call_id": rid,
                                               "usage_cost": cost},
                           tags=tags or None, usage=usage)
        if thinking_text and not tags.get("parent_subagent"):
            self._emit("info", payload={"name": "thinking_block", "thinking": thinking_text, **fields},
                       tags=tags or None)
        if tags.get("parent_subagent"):
            self._emit("llm_end", payload={"name": "subagent_done", **fields}, tags=tags)
        elif has_tool_calls:
            self._emit("llm_end", payload={"name": "thought", "content": text or "[Calling tools]",
                                           **fields}, tags=tags or None)
        elif text:
            self._emit("llm_end", payload={"name": "final_thought", "content": text, **fields},
                       tags=tags or None)
        else:
            self._emit("llm_end", payload={"name": "round_done", **fields}, tags=tags or None)

    def on_llm_error(self, error: BaseException, **kwargs: Any) -> None:
        key = self._key(kwargs)
        with self._lock:
            if key in self._internal_runs:
                self._internal_runs.discard(key)
                return
            normalizer = self._runs.pop(key, None)
            tags = dict(self._run_tags.pop(key, {}) or {})
            self._run_names.pop(key, None)
            self._pricing_models.pop(key, None)
            fields: dict[str, Any] = {}
            if normalizer is not None:
                normalizer.finish()
                fields = normalizer.carrier_fields()
        self._emit("llm_end", payload={"name": "round_error", **fields}, tags=tags or None)

    # tools

    def on_tool_start(self, serialized: Any, input_str: str, **kwargs: Any) -> None:
        name = str(serialized.get("name") or "") if isinstance(serialized, dict) else ""
        run_id = str(kwargs.get("run_id") or "")
        if run_id in self._seen_tool_run_ids:
            return
        self._note_parent(kwargs)
        if run_id:
            self._seen_tool_run_ids.add(run_id)
        self._tool_name_stack.append(name)
        cap = 4000 if name in _LARGE_INPUT_TOOLS else _INPUT_CAP
        is_main = not (kwargs.get("metadata") or {}).get("lc_agent_name")
        tags = self._subagent_tags(kwargs, {"name": name})
        if name == "task" and is_main and run_id:
            with self._lock:
                self._task_runs.add(run_id)
        if run_id:
            tags["lc_tool_run_id"] = run_id
            self._tool_tags[run_id] = dict(tags)
        payload_input: dict[str, Any] = {"raw": (input_str or "")[:cap]}
        structured = sanitize_tool_inputs(kwargs.get("inputs"), cap=cap)
        if structured:
            payload_input["args"] = structured
        self._emit("tool_call", payload={"name": name, "input": payload_input}, tags=tags)

    def _settle_tool(self, kwargs: dict) -> tuple[str, dict] | None:
        run_id = str(kwargs.get("run_id") or "")
        if run_id and run_id not in self._seen_tool_run_ids:
            return None
        self._seen_tool_run_ids.discard(run_id)
        name = self._tool_name_stack.pop() if self._tool_name_stack else ""
        tags = self._tool_tags.pop(run_id, None) if run_id else None
        if tags is None:
            tags = self._subagent_tags(kwargs, {"name": name})
            if run_id:
                tags["lc_tool_run_id"] = run_id
        name = str(tags.get("name") or name)
        return name, tags

    def on_tool_end(self, output: Any, **kwargs: Any) -> None:
        from langgraph.types import Command

        settled = self._settle_tool(kwargs)
        if settled is None:
            return
        name, tags = settled
        messages: list[Any] = []
        if isinstance(output, Command):
            update = getattr(output, "update", None) or {}
            if isinstance(update, Mapping) and "todos" in update:
                todos = update["todos"]
                self._emit("todo_list", payload={"todos": todos if isinstance(todos, list) else []})
            candidates = update.get("messages") if isinstance(update, Mapping) else None
            messages = [m for m in (candidates or []) if hasattr(m, "content")]
            text = str(messages[-1].content) if messages else ""
            output = messages[-1] if messages else output
        elif hasattr(output, "content"):
            inner = output.content
            text = inner if isinstance(inner, str) else str(inner)
        else:
            text = output if isinstance(output, str) else str(output)
        payload: dict[str, Any] = {"name": name, "output": text}
        status = str(getattr(output, "status", "") or "")
        if status in ("error", "success"):
            payload["status"] = status
        if is_recoverable_message(output):
            payload[RECOVERABLE_KEY] = True
        self._emit("tool_result", payload=payload, tags=tags)

    def on_tool_error(self, error: BaseException, **kwargs: Any) -> None:
        settled = self._settle_tool(kwargs)
        if settled is None:
            return
        name, tags = settled
        self._emit("tool_result", payload={"name": name, "output": f"error: {error}",
                                           "status": "error"}, tags=tags)
