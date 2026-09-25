"""Guards around every model request (C4).

``guard_model(model)`` returns the same chat model with these added to its request path
(streaming and non-streaming, sync and async):

- **Retries by error kind**, each with its own budget: rate limits (429), server errors
  (408/409/5xx), network failures (connection, timeouts) and errors reported inside an
  accepted stream. The wait doubles from a small start with ±10 % jitter; a
  ``Retry-After`` / ``retry-after-ms`` header or a "try again in N s" message sets the
  wait instead, capped per kind. Quota exhaustion (402, ``insufficient_quota``) is not
  retried. Nothing is retried once output has been streamed, so text is never shown
  twice.
- **Rejected parameters**: when the endpoint answers 400/422 naming a parameter this
  model sends (effort, thinking, betas, stream options, ``parallel_tool_calls``,
  ``extra_body`` keys …), that parameter is dropped and the request sent again, at most
  four times per request. The drop sticks to the model for the rest of the session and
  is listed in ``downgrades(model)``.
- **Stalls**: when a stream keeps delivering only keep-alive chunks for
  ``CIRCLE_LLM_STALL_TIMEOUT`` seconds (default 180), it is cut; if nothing had been
  produced yet, it is sent once more.
- **Repetition**: when the streamed text falls into a loop (see ``text_repetition``)
  before any answer text or tool call was produced, the request is sent again with a
  reminder to change approach (twice at most); after answer text, the stream is ended
  where it is. ``CIRCLE_LLM_REPEAT_GUARD=0`` turns this off.
- **Missing finish signal**: a stream that ends without ``finish_reason`` /
  ``stop_reason`` and produced nothing is sent once more; one that produced output is
  kept and logged as possibly truncated. ``CIRCLE_LLM_VERIFY_FINISH=0`` turns this off.

``add_retry_listener(fn)`` receives a dict per wait or dropped parameter so a UI can
say what is happening.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import random
import re
import threading
import time
from copy import copy
from typing import Any, AsyncIterator, Callable, Iterator, NamedTuple

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage
from pydantic import PrivateAttr

from circle.text_repetition import RepetitionMonitor

logger = logging.getLogger(__name__)


class Budget(NamedTuple):
    max_retries: int
    deadline_s: float
    initial_s: float
    cap_s: float
    jitter: float


# 交互式会话：用户在等，预算比 InfoTest 无人值守批次短，网络类也有次数上限
BUDGETS: dict[str, Budget] = {
    "rate_limit": Budget(5, 600.0, 2.0, 120.0, 0.1),
    "server": Budget(6, 300.0, 2.0, 30.0, 0.1),
    "network": Budget(6, 300.0, 3.0, 30.0, 0.0),
    "inband": Budget(3, 120.0, 2.0, 30.0, 0.1),
}
MAX_PARAM_DROPS = 4
MAX_REPEAT_RECOVERIES = 2

_REPEAT_RECOVERY = (
    "<system-reminder>\n"
    "You have been repeating the same text over and over without making progress.\n"
    "Stop and take a different approach:\n"
    "- If you were about to produce a large result in one go, produce a small first "
    "piece instead, then continue.\n"
    "- If you were about to call a tool, call it now rather than restating the intention.\n"
    "- If something is blocking you, say what it is instead of restarting.\n"
    "Do not repeat the text you have been repeating.\n"
    "</system-reminder>",
    "<system-reminder>\n"
    "You are still repeating yourself after a previous reminder. Abandon the current "
    "plan.\n"
    "1. State in one sentence what you were trying to produce and why you could not "
    "start.\n"
    "2. Do the smallest useful piece of it.\n"
    "</system-reminder>",
)

_TIMEOUT_NAMES = frozenset({"APITimeoutError", "ReadTimeout", "ConnectTimeout", "WriteTimeout",
                            "PoolTimeout", "TimeoutException", "TimeoutError"})
_QUOTA_CODES = ("insufficient_quota", "quota_exceeded", "billing", "credit_balance")
_REJECTION_MARKERS = ("invalid", "not permitted", "unknown parameter", "unsupported",
                      "unexpected", "allowed:", "unrecognized", "supported values",
                      "not supported", "extra inputs are not permitted")
_EXPLICIT_PARAM_RE = re.compile(r"\bthe\s+([a-z_][a-z0-9_.-]*)\s+(?:parameter|argument)\b",
                                re.IGNORECASE)
_RETRY_AFTER_MESSAGE_RE = re.compile(
    r"(?:try again|retry(?:ing)?)(?: in| after)\s+(\d+(?:\.\d+)?)\s*"
    r"(ms|milliseconds?|s|seconds?|m|minutes?)", re.IGNORECASE)

_listeners: list[Callable[[dict[str, Any]], None]] = []
_listeners_lock = threading.Lock()


class StreamStalled(TimeoutError):
    pass


class TextRepetitionLoop(RuntimeError):
    def __init__(self, period: int) -> None:
        super().__init__(f"model output is looping on a {period}-token block")
        self.period = period


def add_retry_listener(fn: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
    with _listeners_lock:
        _listeners.append(fn)

    def remove() -> None:
        with _listeners_lock:
            if fn in _listeners:
                _listeners.remove(fn)

    return remove


def _notify(event: dict[str, Any]) -> None:
    with _listeners_lock:
        targets = list(_listeners)
    for fn in targets:
        try:
            fn(event)
        except Exception:  # noqa: BLE001 — a display hook must not break the request
            logger.debug("retry listener failed", exc_info=True)


def _env_flag(name: str) -> bool:
    return (os.environ.get(name) or "1").strip().lower() not in ("0", "false", "off", "no")


def _stall_seconds() -> float:
    try:
        return float(os.environ.get("CIRCLE_LLM_STALL_TIMEOUT") or 180.0)
    except (TypeError, ValueError):
        return 180.0


# ── error classification ───────────────────────────────────────────────────


def _error_codes(exc: BaseException) -> list[str]:
    out: list[str] = []
    nodes: list[Any] = [getattr(exc, "body", None)]
    response = getattr(exc, "response", None)
    reader = getattr(response, "json", None)
    if callable(reader):
        try:
            nodes.append(reader())
        except Exception:  # noqa: BLE001 — diagnostics must not hide the original error
            pass
    while nodes:
        node = nodes.pop()
        if not isinstance(node, dict):
            continue
        for key in ("type", "code"):
            if isinstance(node.get(key), str):
                out.append(node[key].lower())
        if isinstance(node.get("error"), dict):
            nodes.append(node["error"])
    return out


def _chain(exc: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        yield cur
        cur = cur.__cause__ or cur.__context__


def _network_types() -> tuple[type[BaseException], ...]:
    found: list[type[BaseException]] = [ConnectionError]
    for module_name, names in (("httpx", ("TransportError",)),
                               ("httpcore", ("NetworkError", "ProtocolError", "TimeoutException")),
                               ("openai", ("APIConnectionError",)),
                               ("anthropic", ("APIConnectionError",))):
        try:
            module = __import__(module_name)
        except ImportError:
            continue
        for name in names:
            cls = getattr(module, name, None)
            if isinstance(cls, type) and issubclass(cls, BaseException):
                found.append(cls)
    return tuple(found)


def _is_inband(exc: BaseException) -> bool:
    try:
        import openai

        if type(exc) is openai.APIError:
            return True
    except ImportError:
        pass
    try:
        import anthropic

        return type(exc) is anthropic.APIStatusError and getattr(exc, "status_code", None) == 200
    except ImportError:
        return False


def error_kind(exc: BaseException) -> str | None:
    """Which retry budget applies, or None when the error should not be retried."""
    if isinstance(exc, (StreamStalled, TextRepetitionLoop)):
        return None
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and status != 200:
        codes = _error_codes(exc)
        if status == 402 or any(q in c for c in codes for q in _QUOTA_CODES):
            return None
        if status == 429:
            return "rate_limit"
        if status in (408, 409) or status >= 500:
            return "server"
        if status == 400 and "bad_response_status_code" in codes:
            return "server"
        return None
    if _is_inband(exc):
        return "inband"
    if any(type(e).__name__ in _TIMEOUT_NAMES for e in _chain(exc)):
        return "network"
    if isinstance(exc, _network_types()):
        return "network"
    return None


def retry_after_s(exc: BaseException) -> float | None:
    headers = getattr(getattr(exc, "response", None), "headers", None)
    if headers is not None and callable(getattr(headers, "get", None)):
        raw_ms = headers.get("retry-after-ms")
        if raw_ms is not None:
            try:
                return max(0.1, float(str(raw_ms).strip()) / 1000.0)
            except ValueError:
                pass
        raw = headers.get("retry-after")
        if raw is not None:
            text = str(raw).strip()
            try:
                return max(0.1, float(text))
            except ValueError:
                try:
                    from email.utils import parsedate_to_datetime

                    delay = parsedate_to_datetime(text).timestamp() - time.time()
                    if delay > 0:
                        return max(0.1, delay)
                except (TypeError, ValueError, AttributeError):
                    pass
    match = _RETRY_AFTER_MESSAGE_RE.search(str(exc))
    if match:
        unit = match.group(2).lower()
        scale = (0.001 if unit == "ms" or unit.startswith("milli")
                 else 60.0 if unit == "m" or unit.startswith("minute") else 1.0)
        return max(0.1, float(match.group(1)) * scale)
    return None


def backoff_s(kind: str, attempt: int, exc: BaseException | None) -> float:
    budget = BUDGETS[kind]
    hinted = retry_after_s(exc) if exc is not None else None
    if hinted is not None:
        return min(budget.cap_s, hinted)
    base = min(budget.cap_s, budget.initial_s * (2.0 ** max(0, attempt)))
    if budget.jitter <= 0:
        return base
    return max(0.1, min(budget.cap_s, base * (1.0 + (random.random() * 2 - 1) * budget.jitter)))


def _explicit_params(exc: BaseException) -> set[str]:
    names: set[str] = set()
    nodes: list[Any] = [getattr(exc, "body", None)]
    reader = getattr(getattr(exc, "response", None), "json", None)
    if callable(reader):
        try:
            nodes.append(reader())
        except Exception:  # noqa: BLE001
            pass
    for node in nodes:
        if isinstance(node, dict):
            inner = node.get("error") if isinstance(node.get("error"), dict) else node
            value = inner.get("param")
            if isinstance(value, str) and value.strip():
                names.add(value.strip().lower().split(".", 1)[0])
    if not names:
        match = _EXPLICIT_PARAM_RE.search(str(exc))
        if match:
            names.add(match.group(1).lower().split(".", 1)[0])
    return names


def rejects_param(exc: BaseException, param: str) -> bool:
    if getattr(exc, "status_code", None) not in (400, 422):
        return False
    explicit = _explicit_params(exc)
    if explicit and param.split(".", 1)[0] not in explicit:
        return False
    text = str(exc).lower()
    return param in text and any(marker in text for marker in _REJECTION_MARKERS)


# ── stream chunk reading ───────────────────────────────────────────────────


def _message(chunk: Any) -> Any:
    return getattr(chunk, "message", None)


def _blocks(content: Any) -> list[dict]:
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []


def chunk_text(chunk: Any) -> str:
    msg = _message(chunk)
    content = getattr(msg, "content", None)
    parts: list[str] = []
    if isinstance(content, str):
        parts.append(content)
    for block in _blocks(content):
        for key in ("text", "thinking", "reasoning"):
            if isinstance(block.get(key), str):
                parts.append(block[key])
    reasoning = (getattr(msg, "additional_kwargs", None) or {}).get("reasoning_content")
    if isinstance(reasoning, str):
        parts.append(reasoning)
    return "".join(parts)


def _has_substance(chunk: Any) -> bool:
    msg = _message(chunk)
    if msg is None:
        return True
    extra = getattr(msg, "additional_kwargs", None) or {}
    return bool(getattr(msg, "content", None) or getattr(msg, "tool_call_chunks", None)
                or getattr(msg, "usage_metadata", None) or extra.get("reasoning_content")
                or extra.get("tool_calls"))


def _carries_answer(chunk: Any) -> bool:
    """Answer text or a tool call (thinking alone does not count)."""
    msg = _message(chunk)
    if msg is None:
        return True
    if getattr(msg, "tool_call_chunks", None):
        return True
    content = getattr(msg, "content", None)
    if isinstance(content, str):
        return bool(content)
    return any((b.get("type") == "text" and b.get("text")) or b.get("type") == "tool_use"
               for b in _blocks(content))


def _finish_reason(chunk: Any) -> str:
    info = getattr(chunk, "generation_info", None) or {}
    if info.get("finish_reason"):
        return str(info["finish_reason"])
    meta = getattr(_message(chunk), "response_metadata", None) or {}
    return str(meta.get("finish_reason") or meta.get("stop_reason") or "")


_BUDGET_STOPS = frozenset({"max_tokens", "length"})


def _report_budget_stop(finish: str, answered: bool) -> None:
    """输出额度在给出回答前就用完（通常被思考吃光）：本轮没有任何回答，不能静默结束。"""
    if finish in _BUDGET_STOPS and not answered:
        logger.warning("model stopped on %s before any answer; the output budget went to "
                       "thinking (raise max_tokens for this model)", finish)
        _notify({"event": "output_budget_exhausted", "finish_reason": finish})


# ── the guarded model ──────────────────────────────────────────────────────


class _Attempts:
    """Retry bookkeeping for one request (all of its resends)."""

    def __init__(self) -> None:
        self.by_kind: dict[str, int] = {}
        self.started = time.monotonic()
        self.param_drops = 0
        self.repeat = 0
        self.stall_resent = False
        self.finish_resent = False

    def wait_for(self, exc: BaseException) -> float | None:
        kind = error_kind(exc)
        if kind is None:
            return None
        budget = BUDGETS[kind]
        done = self.by_kind.get(kind, 0)
        if done >= budget.max_retries or time.monotonic() - self.started >= budget.deadline_s:
            logger.warning("model request: %s retries exhausted after %s attempt(s)", kind, done)
            return None
        wait = backoff_s(kind, done, exc)
        self.by_kind[kind] = done + 1
        logger.warning("model request failed (%s, %s); retry %s/%s in %.1fs", kind,
                       type(exc).__name__, done + 1, budget.max_retries, wait)
        _notify({"event": "retry", "kind": kind, "attempt": done + 1,
                 "max": budget.max_retries, "wait_s": round(wait, 1),
                 "error": type(exc).__name__})
        return wait


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


async def _asleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


def _has_native(obj: Any, name: str) -> bool:
    """Whether the wrapped class implements ``name`` itself rather than inheriting
    LangChain's default, which just runs the sync method (already guarded) in a thread."""
    for klass in type(obj).__mro__:
        if klass is _GuardMixin or issubclass(klass, _GuardMixin):
            continue
        if name in vars(klass):
            return klass is not BaseChatModel
    return False


class _GuardMixin:
    _circle_downgrades: dict[str, str]

    # 端点拒收某个参数时依次尝试的摘除项：(错误里点名的参数名, 当前是否在发, 怎么摘)
    def _param_fixes(self, kwargs: dict[str, Any]) -> list[tuple[tuple[str, ...], bool,
                                                                 Callable[[], None]]]:
        model: Any = self

        def unset(*attrs: str) -> Callable[[], None]:
            def apply() -> None:
                for attr in attrs:
                    if hasattr(model, attr):
                        setattr(model, attr, None)
            return apply

        extra = getattr(model, "extra_body", None)
        extra = extra if isinstance(extra, dict) else {}
        fixes: list[tuple[tuple[str, ...], bool, Callable[[], None]]] = [
            # betas 在 thinking 之前：interleaved-thinking-… 里含 thinking 字样
            (("betas", "anthropic-beta", "anthropic_beta"), bool(getattr(model, "betas", None)),
             unset("betas")),
            (("reasoning_effort", "output_config", "effort"),
             bool(getattr(model, "reasoning_effort", None) or getattr(model, "output_config", None)),
             unset("reasoning_effort", "output_config")),
            (("reasoning",), bool(getattr(model, "reasoning", None)), unset("reasoning")),
            (("thinking", "budget_tokens"), bool(getattr(model, "thinking", None)),
             unset("thinking")),
            (("stream_options",), bool(getattr(model, "stream_usage", False)),
             lambda: setattr(model, "stream_usage", False)),
            (("parallel_tool_calls",), "parallel_tool_calls" in kwargs,
             lambda: kwargs.pop("parallel_tool_calls", None)),
        ]
        for key in list(extra):
            fixes.append(((key,), True, lambda k=key: extra.pop(k, None)))
        return fixes

    def _drop_rejected_param(self, exc: BaseException, kwargs: dict[str, Any],
                             attempts: _Attempts) -> bool:
        if attempts.param_drops >= MAX_PARAM_DROPS:
            return False
        status = getattr(exc, "status_code", None)
        for names, active, apply in self._param_fixes(kwargs):
            if not active:
                continue
            beta_route = names[0] == "betas" and status in (404, 405)
            if beta_route or any(rejects_param(exc, name) for name in names):
                apply()
                attempts.param_drops += 1
                self._circle_downgrades[names[0]] = f"rejected by the endpoint ({status})"
                logger.warning("endpoint rejected %r; sending again without it", names[0])
                _notify({"event": "param_dropped", "param": names[0], "status": status})
                return True
        return False

    def _stream(self, messages: list, stop: Any = None, run_manager: Any = None,
                **kwargs: Any) -> Iterator[Any]:
        attempts = _Attempts()
        messages = list(messages)
        while True:
            yielded = substantive = answered = saw_finish = False
            finish = ""
            last_progress = time.monotonic()
            stall_s = _stall_seconds()
            monitor = RepetitionMonitor() if _env_flag("CIRCLE_LLM_REPEAT_GUARD") else None
            try:
                upstream = super()._stream(messages, stop=stop,  # type: ignore[misc]
                                           run_manager=run_manager, **kwargs)
                with contextlib.closing(upstream):
                    for chunk in upstream:
                        yielded = True
                        reason = _finish_reason(chunk)
                        if reason:
                            saw_finish, finish = True, reason
                        if _has_substance(chunk):
                            substantive = True
                            last_progress = time.monotonic()
                        elif stall_s > 0 and time.monotonic() - last_progress > stall_s:
                            raise StreamStalled(f"no content for {stall_s:.0f}s (keep-alive only)")
                        answered = answered or _carries_answer(chunk)
                        if monitor is not None:
                            period = monitor.feed(chunk_text(chunk))
                            if period:
                                raise TextRepetitionLoop(period)
                        yield chunk
                if (yielded and not saw_finish and not substantive and not attempts.finish_resent
                        and _env_flag("CIRCLE_LLM_VERIFY_FINISH")):
                    attempts.finish_resent = True
                    logger.warning("stream ended without a finish signal or content; resending")
                    continue
                if yielded and not saw_finish and _env_flag("CIRCLE_LLM_VERIFY_FINISH"):
                    logger.warning("stream ended without a finish signal; output may be cut short")
                _report_budget_stop(finish, answered)
                return
            except TextRepetitionLoop as loop:
                if answered:
                    logger.warning("model output looping (%s tokens); ending the stream here",
                                   loop.period)
                    return
                if attempts.repeat >= MAX_REPEAT_RECOVERIES:
                    raise
                messages = messages + [HumanMessage(content=_REPEAT_RECOVERY[attempts.repeat])]
                attempts.repeat += 1
                logger.warning("model output looping (%s tokens); resending with a reminder",
                               loop.period)
            except StreamStalled:
                if substantive or attempts.stall_resent:
                    raise
                attempts.stall_resent = True
                logger.warning("stream stalled before any content; resending once")
            except Exception as exc:
                if yielded:
                    raise
                if self._drop_rejected_param(exc, kwargs, attempts):
                    continue
                wait = attempts.wait_for(exc)
                if wait is None:
                    raise
                _sleep(wait)

    async def _astream(self, messages: list, stop: Any = None, run_manager: Any = None,
                       **kwargs: Any) -> AsyncIterator[Any]:
        if not _has_native(self, "_astream"):
            async for chunk in super()._astream(messages, stop=stop,  # type: ignore[misc]
                                                run_manager=run_manager, **kwargs):
                yield chunk
            return
        attempts = _Attempts()
        messages = list(messages)
        while True:
            yielded = substantive = answered = saw_finish = False
            finish = ""
            last_progress = time.monotonic()
            stall_s = _stall_seconds()
            monitor = RepetitionMonitor() if _env_flag("CIRCLE_LLM_REPEAT_GUARD") else None
            try:
                upstream = super()._astream(messages, stop=stop,  # type: ignore[misc]
                                            run_manager=run_manager, **kwargs)
                async with contextlib.aclosing(upstream):
                    async for chunk in upstream:
                        yielded = True
                        reason = _finish_reason(chunk)
                        if reason:
                            saw_finish, finish = True, reason
                        if _has_substance(chunk):
                            substantive = True
                            last_progress = time.monotonic()
                        elif stall_s > 0 and time.monotonic() - last_progress > stall_s:
                            raise StreamStalled(f"no content for {stall_s:.0f}s (keep-alive only)")
                        answered = answered or _carries_answer(chunk)
                        if monitor is not None:
                            period = monitor.feed(chunk_text(chunk))
                            if period:
                                raise TextRepetitionLoop(period)
                        yield chunk
                if (yielded and not saw_finish and not substantive and not attempts.finish_resent
                        and _env_flag("CIRCLE_LLM_VERIFY_FINISH")):
                    attempts.finish_resent = True
                    continue
                if yielded and not saw_finish and _env_flag("CIRCLE_LLM_VERIFY_FINISH"):
                    logger.warning("stream ended without a finish signal; output may be cut short")
                _report_budget_stop(finish, answered)
                return
            except TextRepetitionLoop:
                if answered:
                    return
                if attempts.repeat >= MAX_REPEAT_RECOVERIES:
                    raise
                messages = messages + [HumanMessage(content=_REPEAT_RECOVERY[attempts.repeat])]
                attempts.repeat += 1
            except StreamStalled:
                if substantive or attempts.stall_resent:
                    raise
                attempts.stall_resent = True
            except Exception as exc:
                if yielded:
                    raise
                if self._drop_rejected_param(exc, kwargs, attempts):
                    continue
                wait = attempts.wait_for(exc)
                if wait is None:
                    raise
                await _asleep(wait)

    def _generate(self, messages: list, stop: Any = None, run_manager: Any = None,
                  **kwargs: Any) -> Any:
        if getattr(self, "streaming", False):
            # 流式模型的 _generate 走 self._stream，守卫已在那一层
            return super()._generate(messages, stop=stop,  # type: ignore[misc]
                                     run_manager=run_manager, **kwargs)
        attempts = _Attempts()
        while True:
            try:
                return super()._generate(messages, stop=stop,  # type: ignore[misc]
                                         run_manager=run_manager, **kwargs)
            except Exception as exc:
                if self._drop_rejected_param(exc, kwargs, attempts):
                    continue
                wait = attempts.wait_for(exc)
                if wait is None:
                    raise
                _sleep(wait)

    async def _agenerate(self, messages: list, stop: Any = None, run_manager: Any = None,
                         **kwargs: Any) -> Any:
        if getattr(self, "streaming", False) or not _has_native(self, "_agenerate"):
            return await super()._agenerate(messages, stop=stop,  # type: ignore[misc]
                                            run_manager=run_manager, **kwargs)
        attempts = _Attempts()
        while True:
            try:
                return await super()._agenerate(messages, stop=stop,  # type: ignore[misc]
                                                run_manager=run_manager, **kwargs)
            except Exception as exc:
                if self._drop_rejected_param(exc, kwargs, attempts):
                    continue
                wait = attempts.wait_for(exc)
                if wait is None:
                    raise
                await _asleep(wait)


_CLASSES: dict[type, type] = {}
_CLASSES_LOCK = threading.Lock()


def _guarded_class(base: type) -> type:
    with _CLASSES_LOCK:
        cls = _CLASSES.get(base)
        if cls is None:
            namespace = {
                "__module__": __name__,
                "__annotations__": {"_circle_downgrades": dict},
                "_circle_downgrades": PrivateAttr(default_factory=dict),
            }
            cls = type(f"Guarded{base.__name__}", (_GuardMixin, base), namespace)
            _CLASSES[base] = cls
        return cls


def guard_model(model: Any) -> Any:
    """The same model (same settings, same client) with the guards above."""
    if not isinstance(model, BaseChatModel) or isinstance(model, _GuardMixin):
        return model
    cls = _guarded_class(type(model))
    guarded = cls.__new__(cls)
    object.__setattr__(guarded, "__dict__", copy(model.__dict__))
    object.__setattr__(guarded, "__pydantic_fields_set__", set(model.__pydantic_fields_set__))
    object.__setattr__(guarded, "__pydantic_extra__", copy(model.__pydantic_extra__))
    private = dict(model.__pydantic_private__ or {})
    private["_circle_downgrades"] = {}
    object.__setattr__(guarded, "__pydantic_private__", private)
    return guarded


def downgrades(model: Any) -> dict[str, str]:
    """Parameters the endpoint rejected and this model no longer sends."""
    if isinstance(model, _GuardMixin):
        return dict(model._circle_downgrades)
    return {}
