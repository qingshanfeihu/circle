"""Typed display stream: split model output into reasoning and answer text channels,
track the round clock, and pull a reasoning title from a leading ``**…**`` paragraph.

Ported unchanged from InfoTest ``main/ist_core/display_stream.py``.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, TypedDict


DisplayStreamEventKind = Literal[
    "llm_round_start",
    "reasoning_delta",
    "reasoning_end",
    "text_delta",
    "llm_round_end",
]


class DisplayStreamEvent(TypedDict, total=False):
    """Internal stream event; it does not add EventBus kinds."""

    event: DisplayStreamEventKind
    round_n: int
    call_started_at: float
    delta: str
    last_line: str
    chars_total: int
    duration_s: float


@dataclass(frozen=True)
class DisplayChannels:

    reasoning: str = ""
    text: str = ""


@dataclass(frozen=True)
class ReasoningSummary:

    title: str | None
    body: str


_LEADING_BOLD_TITLE_RE = re.compile(
    r"^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)"
)
_CASE_AUTOID_TITLE_RE = re.compile(
    r"case\s+\d+\s*:\s*\d{18}",
    re.IGNORECASE,
)
_BARE_SHA_TITLE_RE = re.compile(r"[0-9a-f]{7,64}", re.IGNORECASE)

_BODY_TAIL_LIVE = 4096
_BODY_TAIL_SETTLED = 16384


def sanitize_display_line(text: str) -> str:
    cleaned = "".join(ch for ch in str(text or "") if ch.isprintable())
    return " ".join(cleaned.split())


def _identifier_title(candidate: str) -> bool:
    title = str(candidate or "").strip()
    return bool(
        title.isdigit()
        or _CASE_AUTOID_TITLE_RE.fullmatch(title)
        or _BARE_SHA_TITLE_RE.fullmatch(title)
    )


def reasoning_summary(text: str) -> ReasoningSummary:
    content = str(text or "").strip()
    match = _LEADING_BOLD_TITLE_RE.match(content)
    if match is None:
        return ReasoningSummary(title=None, body=content)
    title = sanitize_display_line(match.group(1))
    if not title or _identifier_title(title):
        return ReasoningSummary(title=None, body=content)
    return ReasoningSummary(
        title=title,
        body=content[match.end():].rstrip(),
    )


def _first_message(value: Any) -> Any:
    if value is None:
        return None
    message = getattr(value, "message", None)
    if message is not None:
        return message
    generations = getattr(value, "generations", None)
    if generations:
        try:
            first = generations[0]
            generation = first[0] if isinstance(first, Sequence) else first
            return getattr(generation, "message", None) or generation
        except (IndexError, TypeError):
            pass
    if isinstance(value, Mapping):
        if value.get("message") is not None:
            return value["message"]
        generations = value.get("generations")
        if isinstance(generations, Sequence) and generations:
            first = generations[0]
            if isinstance(first, Sequence) and first:
                first = first[0]
            if isinstance(first, Mapping) and first.get("message") is not None:
                return first["message"]
            return first
    return value


def extract_display_channels(value: Any) -> DisplayChannels:
    message = _first_message(value)
    if message is None:
        return DisplayChannels()
    if isinstance(message, Mapping):
        additional = message.get("additional_kwargs") or {}
        content = message.get("content")
    else:
        additional = getattr(message, "additional_kwargs", None) or {}
        content = getattr(message, "content", None)

    reasoning = ""
    if isinstance(additional, Mapping):
        normalized = additional.get("reasoning_content")
        if isinstance(normalized, str):
            reasoning = normalized

    text_parts: list[str] = []
    thinking_parts: list[str] = []
    if isinstance(content, str):
        text_parts.append(content)
    elif isinstance(content, Sequence) and not isinstance(content, (bytes, bytearray)):
        for block in content:
            if not isinstance(block, Mapping):
                continue
            block_type = str(block.get("type") or "")
            if block_type == "thinking":
                thinking = block.get("thinking")
                if isinstance(thinking, str):
                    thinking_parts.append(thinking)
            elif block_type in {"text", "text_delta"}:
                text = block.get("text")
                if isinstance(text, str):
                    text_parts.append(text)
    if not reasoning:
        reasoning = "".join(thinking_parts)
    return DisplayChannels(reasoning=reasoning, text="".join(text_parts))


class TypedDisplayStreamNormalizer:

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.time,
        line_cap: int = 160,
    ) -> None:
        self._clock = clock
        self._line_cap = max(16, int(line_cap))
        self.round_n = 0
        self.call_started_at: float | None = None
        self.reasoning_active = False
        self.reasoning_title: str | None = None
        self.reasoning_last_line = ""
        self.reasoning_chars = 0
        self.reasoning_duration_s: float | None = None
        self._reasoning_started_at: float | None = None
        self._reasoning_text = ""
        self._reasoning_tail = ""
        self._reasoning_body_tail = ""
        self._text_chars = 0
        self.activity_summary: str | None = None
        self.activity_summary_at: float | None = None

    @staticmethod
    def _now(value: float | None, clock: Callable[[], float]) -> float:
        return float(clock() if value is None else value)

    def note_activity_summary(
        self, summary: str | None, *, now: float | None = None
    ) -> None:
        text = sanitize_display_line(summary)
        if not text:
            return
        self.activity_summary = text
        self.activity_summary_at = self._now(now, self._clock)

    def start(self, *, now: float | None = None) -> list[DisplayStreamEvent]:
        current = self._now(now, self._clock)
        self.round_n += 1
        self.call_started_at = current
        self.reasoning_active = False
        self.reasoning_title = None
        self.reasoning_last_line = ""
        self.reasoning_chars = 0
        self.reasoning_duration_s = None
        self._reasoning_started_at = None
        self._reasoning_text = ""
        self._reasoning_tail = ""
        self._reasoning_body_tail = ""
        self._text_chars = 0
        return [{
            "event": "llm_round_start",
            "round_n": self.round_n,
            "call_started_at": current,
        }]

    def _ensure_started(self, current: float) -> list[DisplayStreamEvent]:
        return self.start(now=current) if self.call_started_at is None else []

    def _update_last_line(self, delta: str) -> None:
        self._reasoning_tail = (self._reasoning_tail + delta)[-4096:]
        candidates = [
            " ".join(line.split())
            for line in self._reasoning_tail.splitlines()
            if line.strip()
        ]
        if not candidates and self._reasoning_tail.strip():
            candidates = [" ".join(self._reasoning_tail.split())]
        if candidates:
            line = candidates[-1]
            self.reasoning_last_line = (
                line
                if len(line) <= self._line_cap
                else "…" + line[-(self._line_cap - 1):]
            )

    def _end_reasoning(self, current: float) -> DisplayStreamEvent | None:
        if not self.reasoning_active:
            return None
        started = self._reasoning_started_at
        if started is None:
            started = self.call_started_at if self.call_started_at is not None else current
        duration = max(0.0, current - started)
        self.reasoning_active = False
        self.reasoning_duration_s = duration
        return {
            "event": "reasoning_end",
            "round_n": self.round_n,
            "duration_s": duration,
        }

    def observe(self, value: Any, *, now: float | None = None) -> list[DisplayStreamEvent]:
        current = self._now(now, self._clock)
        events = self._ensure_started(current)
        channels = extract_display_channels(value)
        if channels.reasoning:
            if not self.reasoning_active:
                self.reasoning_active = True
                self._reasoning_started_at = (
                    self.call_started_at
                    if self.call_started_at is not None else current
                )
            self.reasoning_chars += len(channels.reasoning)
            self._reasoning_text += channels.reasoning
            self._reasoning_body_tail = (
                self._reasoning_body_tail + channels.reasoning
            )[-_BODY_TAIL_SETTLED:]
            self.reasoning_title = reasoning_summary(
                self._reasoning_text
            ).title
            self._update_last_line(channels.reasoning)
            events.append({
                "event": "reasoning_delta",
                "round_n": self.round_n,
                "delta": channels.reasoning,
                "last_line": self.reasoning_last_line,
                "chars_total": self.reasoning_chars,
            })
        if channels.text:
            ended = self._end_reasoning(current)
            if ended is not None:
                events.append(ended)
            self._text_chars += len(channels.text)
            events.append({
                "event": "text_delta",
                "round_n": self.round_n,
                "delta": channels.text,
            })
        return events

    def finish(self, value: Any = None, *, now: float | None = None) -> list[DisplayStreamEvent]:
        current = self._now(now, self._clock)
        events = self._ensure_started(current)
        channels = extract_display_channels(value)
        replay: dict[str, Any] = {"content": "", "additional_kwargs": {}}
        if channels.reasoning and self.reasoning_chars == 0:
            replay["additional_kwargs"] = {
                "reasoning_content": channels.reasoning,
            }
        if channels.text and self._text_chars == 0:
            replay["content"] = channels.text
        if replay["content"] or replay["additional_kwargs"]:
            events.extend(self.observe(replay, now=current))
        ended = self._end_reasoning(current)
        if ended is not None:
            events.append(ended)
        started = self.call_started_at if self.call_started_at is not None else current
        events.append({
            "event": "llm_round_end",
            "round_n": self.round_n,
            "duration_s": max(0.0, current - started),
        })
        self.call_started_at = None
        return events

    def carrier_fields(self) -> dict[str, Any]:
        return {
            "llm_round": int(self.round_n),
            "call_started_at": self.call_started_at,
            "reasoning_active": bool(self.reasoning_active),
            "reasoning_title": self.reasoning_title,
            "reasoning_last_line": str(self.reasoning_last_line),
            "reasoning_chars": int(self.reasoning_chars),
            "reasoning_duration_s": self.reasoning_duration_s,
            "reasoning_tail": (
                self._reasoning_body_tail
                if (not self.reasoning_active
                    and self.reasoning_duration_s is not None)
                else self._reasoning_body_tail[-_BODY_TAIL_LIVE:]
            ),
            "activity_summary": self.activity_summary,
            "activity_summary_at": self.activity_summary_at,
        }


def event_deltas(events: Sequence[DisplayStreamEvent]) -> DisplayChannels:
    reasoning = "".join(
        str(event.get("delta") or "")
        for event in events if event.get("event") == "reasoning_delta"
    )
    text = "".join(
        str(event.get("delta") or "")
        for event in events if event.get("event") == "text_delta"
    )
    return DisplayChannels(reasoning=reasoning, text=text)


__all__ = [
    "DisplayChannels",
    "ReasoningSummary",
    "DisplayStreamEvent",
    "TypedDisplayStreamNormalizer",
    "event_deltas",
    "extract_display_channels",
    "reasoning_summary",
    "sanitize_display_line",
]
