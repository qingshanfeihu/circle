"""Typed display stream: reasoning/text channels, titles, round clock.

Ported from InfoTest ``tests/ist_core/test_display_stream_normalization.py``."""

from __future__ import annotations

import json

from pathlib import Path

from circle.display_stream import (
    TypedDisplayStreamNormalizer,
    event_deltas,
    extract_display_channels,
)

_FIXTURE = json.loads(
    (
        Path(__file__).parent
        / "fixtures/typed_stream_recorded_slices.json"
    ).read_text(encoding="utf-8")
)

def test_openai_mimo_real_stream_becomes_typed_round_without_prose_sniffing() -> None:
    sample = _FIXTURE["openai_mimo_formal4"]
    normalizer = TypedDisplayStreamNormalizer()
    events = normalizer.start(now=sample["started_at"])
    for index, chunk in enumerate(sample["chunks"], start=1):
        events.extend(normalizer.observe(chunk, now=sample["started_at"] + index / 10))

    assert events[0]["event"] == "llm_round_start"
    assert [row["event"] for row in events].count("reasoning_delta") == 12
    assert normalizer.reasoning_chars == len(
        sample["final_message"]["additional_kwargs"]["reasoning_content"]
    )
    assert normalizer.reasoning_last_line.endswith("I need to invoke that skill first.")
    assert normalizer.carrier_fields()["reasoning_active"] is True

    closed = normalizer.finish(sample["final_message"], now=sample["finished_at"])
    assert not event_deltas(closed).reasoning, "流式聚合全文不得在 end 再播一次"
    assert [row["event"] for row in closed] == ["reasoning_end", "llm_round_end"]
    assert normalizer.carrier_fields()["call_started_at"] is None


def test_openai_complete_message_replays_nonstream_with_real_duration() -> None:
    sample = _FIXTURE["openai_mimo_formal4"]
    normalizer = TypedDisplayStreamNormalizer()
    normalizer.start(now=sample["started_at"])

    events = normalizer.finish(sample["final_message"], now=sample["finished_at"])

    assert [row["event"] for row in events] == [
        "reasoning_delta", "reasoning_end", "llm_round_end",
    ]
    assert events[1]["duration_s"] == sample["finished_at"] - sample["started_at"]
    assert normalizer.reasoning_last_line.endswith("I need to invoke that skill first.")


def test_anthropic_grok_real_complete_blocks_replay_both_channels() -> None:
    sample = _FIXTURE["anthropic_grok_complete"]
    normalizer = TypedDisplayStreamNormalizer()
    normalizer.start(now=sample["started_at"])

    events = normalizer.finish(sample["final_message"], now=sample["finished_at"])
    deltas = event_deltas(events)

    assert [row["event"] for row in events] == [
        "reasoning_delta", "reasoning_end", "text_delta", "llm_round_end",
    ]
    assert deltas.reasoning.startswith('The user just said "hi"')
    assert deltas.text == "你好。需要查命令、编用例、上机验证还是评审，直接说就行。"
    assert normalizer.reasoning_last_line.endswith("matches this request.")


def test_anthropic_streaming_sdk_shape_behaves_like_openai_channel() -> None:
    sample = _FIXTURE["anthropic_stream_schema"]
    assert str(sample["record_status"]).startswith("未确定:")
    normalizer = TypedDisplayStreamNormalizer()
    normalizer.start(now=1.0)
    events = []
    for index, chunk in enumerate(sample["chunks"], start=1):
        events.extend(normalizer.observe(chunk, now=1.0 + index))

    assert [row["event"] for row in events] == [
        "reasoning_delta", "reasoning_delta", "reasoning_end", "text_delta",
    ]
    assert normalizer.reasoning_last_line.endswith("matches this request.")
    assert event_deltas(events).text.startswith("你好")


def test_provider_without_reasoning_emits_round_and_text_only() -> None:
    normalizer = TypedDisplayStreamNormalizer()
    events = normalizer.start(now=1.0)
    events.extend(normalizer.observe({"content": "plain answer"}, now=2.0))
    events.extend(normalizer.finish({"content": "plain answer"}, now=3.0))

    assert [row["event"] for row in events] == [
        "llm_round_start", "text_delta", "llm_round_end",
    ]
    assert normalizer.reasoning_chars == 0
    assert normalizer.reasoning_last_line == ""


def test_legacy_reasoning_summary_and_bold_prose_are_never_reasoning_sources() -> None:
    legacy = _FIXTURE["legacy_sniffer_failure"]["event"]
    assert extract_display_channels(legacy).reasoning == ""
    channels = extract_display_channels({
        "content": "**Case 3: 111122223333444455**",
        "additional_kwargs": {},
    })
    assert channels.reasoning == ""
    assert channels.text == "**Case 3: 111122223333444455**"
