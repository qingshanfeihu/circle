"""Compaction you can watch: the automatic one and ``/compact``.

deepagents' ``SummarizationMiddleware`` compacts a conversation: it splits off the older
messages, saves them to the history file, has the model summarize them and goes on with the
summary in their place. ``CircleSummarization`` is that middleware reporting each step as the
LangChain custom event ``circle_compaction``; ``CompactionWatcher`` is the callback handler
that hears those events and the summary's streamed chunks and hands each change to the
screen, where ``CompactionProgress`` turns them into the progress row and the closing line.

The automatic compaction runs inside a model call (``trigger`` ``auto`` past the threshold
or the input budget, ``overflow`` when the provider refused the size); ``/compact`` and a
model's own call to ``compact_conversation`` run it in the tool (``trigger`` ``tool``). Both
go through the same engine, so both report the same way. Event ``phase``s:

- ``start``: ``trigger``, ``messages`` to summarize, ``keep``, ``tokens`` (an estimate of the
  context before)
- ``saving`` / ``saved`` (``file``), ``summarizing`` / ``summarized`` (``chars``)
- ``done``: ``trigger``, ``tokens_before`` and ``tokens_after`` (estimates of the whole
  request, system prompt and tools included, scaled to the provider's count as the footer's
  ``ctx`` shows it), ``summarized``, ``kept``, ``file``, ``seconds``
- ``failed``: ``error``

The watcher adds ``chunks``: how many pieces of the summary have streamed so far.
"""

from __future__ import annotations

import contextvars
import logging
import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from deepagents.middleware.summarization import (
    SummarizationMiddleware,
    compute_summarization_defaults,
)
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages.utils import count_tokens_approximately

logger = logging.getLogger(__name__)

EVENT = "circle_compaction"

# Set while a model call runs through the middleware: the compaction it starts is automatic
_in_model_call: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "circle_compaction_model_call", default=None)
# The compaction under way, from the split to the new messages
_current: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "circle_compaction_current", default=None)


def _dispatch(data: dict[str, Any]) -> None:
    try:
        from langchain_core.callbacks.manager import dispatch_custom_event

        dispatch_custom_event(EVENT, data)
    except Exception:  # noqa: BLE001 — outside a run there is no one to tell; never break it
        logger.debug("compaction event not dispatched: %s", data.get("phase"), exc_info=True)


async def _adispatch(data: dict[str, Any]) -> None:
    try:
        from langchain_core.callbacks.manager import adispatch_custom_event

        await adispatch_custom_event(EVENT, data)
    except Exception:  # noqa: BLE001
        logger.debug("compaction event not dispatched: %s", data.get("phase"), exc_info=True)


class CircleSummarization(SummarizationMiddleware):
    """deepagents' summarization middleware, reporting each step (see the module docstring).

    It keeps deepagents' public name, so ``create_deep_agent`` puts it in the place of its
    own instead of adding a second one."""

    @property
    def name(self) -> str:
        return "SummarizationMiddleware"

    def _room(self, request: Any) -> dict[str, Any]:
        """deepagents compacts past the threshold, and also once the request no longer fits
        its input budget (95% of the window less the answer's ``max_tokens``): both are the
        automatic compaction, not a refused request."""
        # What every request carries besides the conversation (see _shown)
        self._frame = (getattr(request, "system_message", None), getattr(request, "tools", None))
        try:
            return {"budget": self._input_budget(request)}
        except Exception:  # noqa: BLE001 — only the trigger's name depends on it
            return {}

    # ── steps ──────────────────────────────────────────────────────────

    def _approximate(self, messages: list[Any]) -> int:
        """``messages`` as a request: with the last request's system prompt and tools."""
        system, tools = getattr(self, "_frame", (None, None))
        head = [system] if system is not None else []
        return count_tokens_approximately([*head, *messages], tools=tools or None)

    def _provider_scale(self, messages: list[Any]) -> float:
        """The provider's tokens per approximate token, from the last answer that reported its
        usage (its total is the request it answered plus itself): the closing line's counts
        then read like the footer's ctx, which is what the provider reports."""
        for i in range(len(messages) - 1, -1, -1):
            usage = getattr(messages[i], "usage_metadata", None)
            total = usage.get("total_tokens") if isinstance(usage, dict) else None
            if isinstance(messages[i], AIMessage) and isinstance(total, int) and total > 0:
                counted = self._approximate(messages[:i + 1])
                return min(5.0, max(0.2, total / counted)) if counted > 0 else 1.0
        return 1.0

    def _shown(self, messages: list[Any], scale: float) -> int | None:
        try:
            return round(self._approximate(messages) * scale)
        except Exception:  # noqa: BLE001 — only the closing line's counts depend on it
            return None

    def _begin(self, messages: list[Any], to_summarize: list[Any], preserved: list[Any]
               ) -> dict[str, Any]:
        call = _in_model_call.get()
        if call is None:
            trigger = "tool"
        else:
            trigger = "auto" if call.get("over_threshold") else "overflow"
        try:
            scale = self._provider_scale(messages)
        except Exception:  # noqa: BLE001
            scale = 1.0
        run = {"trigger": trigger, "tokens_before": self._shown(messages, scale), "scale": scale,
               "summarized": len(to_summarize), "kept": len(preserved),
               "preserved": list(preserved), "started": time.monotonic(), "file": None}
        _current.set(run)
        return {"phase": "start", "trigger": trigger,
                "messages": len(to_summarize), "keep": len(preserved),
                "tokens": run["tokens_before"]}

    def _finish(self, summary_messages: list[Any], file_path: str | None) -> dict[str, Any] | None:
        run = _current.get()
        if run is None:
            return None
        _current.set(None)
        return {"phase": "done", "trigger": run["trigger"],
                "tokens_before": run["tokens_before"],
                "tokens_after": self._shown([*summary_messages, *run["preserved"]], run["scale"]),
                "summarized": run["summarized"], "kept": run["kept"],
                "file": file_path or run.get("file"),
                "seconds": round(time.monotonic() - run["started"], 1)}

    @staticmethod
    def _failure(exc: BaseException) -> dict[str, Any] | None:
        if _current.get() is None:
            return None
        _current.set(None)
        return {"phase": "failed", "error": f"{type(exc).__name__}: {exc}"[:400]}

    def _should_summarize(self, messages: list[Any], total_tokens: int) -> bool:
        over = super()._should_summarize(messages, total_tokens)
        call = _in_model_call.get()
        if call is not None:
            budget = call.get("budget")
            call["over_threshold"] = over or (isinstance(budget, int) and total_tokens > budget)
        return over

    def _partition_messages(self, conversation_messages: list[Any], cutoff_index: int
                            ) -> tuple[list[Any], list[Any]]:
        to_summarize, preserved = super()._partition_messages(conversation_messages, cutoff_index)
        _dispatch(self._begin(conversation_messages, to_summarize, preserved))
        return to_summarize, preserved

    def _offload_to_backend(self, backend: Any, messages: list[Any], session_id: str
                            ) -> str | None:
        active = _current.get() is not None
        if active:
            _dispatch({"phase": "saving"})
        try:
            path = super()._offload_to_backend(backend, messages, session_id)
        except BaseException as exc:
            if (failure := self._failure(exc)) is not None:
                _dispatch(failure)
            raise
        if active and (run := _current.get()) is not None:
            run["file"] = path
            _dispatch({"phase": "saved", "file": path})
        return path

    def _create_summary(self, messages_to_summarize: list[Any]) -> str:
        active = _current.get() is not None
        if active:
            _dispatch({"phase": "summarizing"})
        try:
            summary = super()._create_summary(messages_to_summarize)
        except BaseException as exc:
            if (failure := self._failure(exc)) is not None:
                _dispatch(failure)
            raise
        if active:
            _dispatch({"phase": "summarized", "chars": len(summary or "")})
        return summary

    def _build_new_messages_with_path(self, summary: str, file_path: str | None) -> list[Any]:
        messages = super()._build_new_messages_with_path(summary, file_path)
        if (done := self._finish(messages, file_path)) is not None:
            _dispatch(done)
        return messages

    def wrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        token = _in_model_call.set(self._room(request))
        try:
            return super().wrap_model_call(request, handler)
        except BaseException as exc:
            if (failure := self._failure(exc)) is not None:
                _dispatch(failure)
            raise
        finally:
            _in_model_call.reset(token)

    # ── the async twins (deepagents runs offload and summary side by side there) ──

    async def _aoffload_to_backend(self, backend: Any, messages: list[Any], session_id: str
                                   ) -> str | None:
        active = _current.get() is not None
        if active:
            await _adispatch({"phase": "saving"})
        try:
            path = await super()._aoffload_to_backend(backend, messages, session_id)
        except BaseException as exc:
            if (failure := self._failure(exc)) is not None:
                await _adispatch(failure)
            raise
        if active and (run := _current.get()) is not None:
            run["file"] = path
            await _adispatch({"phase": "saved", "file": path})
        return path

    async def _acreate_summary(self, messages_to_summarize: list[Any]) -> str:
        active = _current.get() is not None
        if active:
            await _adispatch({"phase": "summarizing"})
        try:
            summary = await super()._acreate_summary(messages_to_summarize)
        except BaseException as exc:
            if (failure := self._failure(exc)) is not None:
                await _adispatch(failure)
            raise
        if active:
            await _adispatch({"phase": "summarized", "chars": len(summary or "")})
        return summary

    async def awrap_model_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        token = _in_model_call.set(self._room(request))
        try:
            return await super().awrap_model_call(request, handler)
        except BaseException as exc:
            if (failure := self._failure(exc)) is not None:
                await _adispatch(failure)
            raise
        finally:
            _in_model_call.reset(token)


def create_circle_summarization(model: BaseChatModel, backend: Any) -> CircleSummarization:
    """Built as ``deepagents.middleware.summarization.create_summarization_middleware`` builds
    its own: the threshold from ``model.profile`` (85% of ``max_input_tokens``)."""
    defaults = compute_summarization_defaults(model)
    return CircleSummarization(
        model,
        backend=backend,
        trigger=defaults["trigger"],
        keep=defaults["keep"],
        trim_tokens_to_summarize=None,
        truncate_args_settings=defaults["truncate_args_settings"],
    )


# ── listening ────────────────────────────────────────────────────────────


class CompactionWatcher(BaseCallbackHandler):
    """Hands each compaction event, and the summary's streamed chunks, to ``sink``."""

    raise_error = False

    def __init__(self, sink: Callable[[dict[str, Any]], None], *, every_s: float = 0.2) -> None:
        self._sink = sink
        self._every_s = every_s
        self._lock = threading.Lock()
        self._chunks: dict[str, int] = {}
        self._sent_at = 0.0

    def _send(self, data: dict[str, Any]) -> None:
        try:
            self._sink(data)
        except Exception:  # noqa: BLE001 — the screen must not break the run
            logger.debug("compaction sink failed", exc_info=True)

    def on_custom_event(self, name: str, data: Any, **kwargs: Any) -> None:
        if name == EVENT and isinstance(data, dict):
            self._send(dict(data))

    def on_chat_model_start(self, serialized: Any, messages: Any, **kwargs: Any) -> None:
        if (kwargs.get("metadata") or {}).get("lc_source") == "summarization":
            with self._lock:
                self._chunks[str(kwargs.get("run_id") or "")] = 0

    def on_llm_new_token(self, token: str, **kwargs: Any) -> None:
        key = str(kwargs.get("run_id") or "")
        with self._lock:
            if key not in self._chunks:
                return
            self._chunks[key] += 1
            count = self._chunks[key]
            now = time.monotonic()
            if now - self._sent_at < self._every_s:
                return
            self._sent_at = now
        self._send({"phase": "chunks", "chunks": count})

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        with self._lock:
            self._chunks.pop(str(kwargs.get("run_id") or ""), None)

    def on_llm_error(self, error: BaseException, **kwargs: Any) -> None:
        with self._lock:
            self._chunks.pop(str(kwargs.get("run_id") or ""), None)


# ── the screen's model of it ─────────────────────────────────────────────

_STAGES = {"start": "starting", "saving": "saving history", "saved": "history saved",
           "summarizing": "summarizing", "summarized": "summarized"}


def _tokens(n: Any) -> str:
    if not isinstance(n, (int, float)) or isinstance(n, bool) or n < 0:
        return "?"
    return f"{n / 1000:.1f}k" if n >= 1000 else str(int(n))


@dataclass
class CompactionProgress:
    """What the progress row shows while a compaction runs: ``label`` (``auto-compacting``, or
    ``compacting`` for /compact and the model's own call), the stage and how far along."""

    trigger: str = ""
    stage: str = "starting"
    started: float = field(default_factory=time.monotonic)
    saved: bool = False
    summarized: bool = False
    chunks: int = 0
    requested: bool = False

    def apply(self, event: dict[str, Any]) -> None:
        phase = str(event.get("phase") or "")
        if phase == "start":
            self.trigger = str(event.get("trigger") or self.trigger)
        elif phase == "saved":
            self.saved = True
        elif phase == "summarized":
            self.summarized = True
        elif phase == "chunks":
            self.chunks = max(self.chunks, int(event.get("chunks") or 0))
            return
        if phase in _STAGES:
            self.stage = _STAGES[phase]

    @property
    def automatic(self) -> bool:
        return not self.requested and self.trigger in ("auto", "overflow")

    @property
    def label(self) -> str:
        return "auto-compacting" if self.automatic else "compacting"

    def fraction(self) -> float:
        """How far along: saving the history is a tenth, the summary most of the rest. The
        summary's length is not known ahead, so its share fills more slowly as it grows."""
        summary = 1.0 if self.summarized else 1.0 - math.exp(-self.chunks / 400.0)
        return min(1.0, 0.05 + (0.10 if self.saved else 0.0) + 0.85 * summary)

    def elapsed(self) -> float:
        return time.monotonic() - self.started


def _messages(n: Any) -> str:
    if not isinstance(n, int) or isinstance(n, bool):
        return "? messages"
    return f"{n} message" if n == 1 else f"{n} messages"


def done_text(event: dict[str, Any], *, automatic: bool = False) -> str:
    """The closing line: how much went in and came out, and where the rest is."""
    parts = ["auto-compacted" if automatic else "compacted",
             f"~{_tokens(event.get('tokens_before'))} → ~{_tokens(event.get('tokens_after'))} tokens",
             f"summarized {_messages(event.get('summarized'))}, kept {event.get('kept', '?')}"]
    if isinstance(event.get("seconds"), (int, float)):
        parts.append(f"{float(event['seconds']):.0f}s")
    if event.get("file"):
        parts.append(f"history: {event['file']}")
    return " · ".join(parts)
