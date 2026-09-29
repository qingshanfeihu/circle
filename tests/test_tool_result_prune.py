"""Batch pruning is durable, and only a batch boundary changes old requests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import Field

from circle.harness import create_harness
from circle.middleware.tool_result_prune import (
    ToolResultPruneMiddleware,
    prune_messages,
)
from circle.testing import ScriptedModel


class RecordingModel(ScriptedModel):
    seen: list[list[Any]] = Field(default_factory=list)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def _call(i: int) -> AIMessage:
    return AIMessage(
        id=f"ai-{i}",
        content=[{"type": "thinking", "thinking": f"thought {i}", "signature": f"sig-{i}"},
                 {"type": "redacted_thinking", "data": f"redacted-{i}"},
                 {"type": "text", "text": f"step {i}"}],
        tool_calls=[{"name": "tick", "args": {"i": i}, "id": f"tick-{i}", "type": "tool_call"}],
    )


def _bytes(messages: list[Any]) -> bytes:
    def clean(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items() if k != "cache_control"}
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value

    return json.dumps(clean([msg.model_dump(exclude_none=True) for msg in messages]),
                      ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def _is_prefix(earlier: list[Any], later: list[Any]) -> bool:
    return _bytes(earlier) == _bytes(later[:len(earlier)])


def test_batch_is_written_once_and_raw_output_and_thinking_survive(monkeypatch):
    monkeypatch.setenv("CIRCLE_PRUNE_PROTECT_TOKENS", "0")
    chunk = "x" * 40_000  # 10k approximate tokens
    messages: list[Any] = [HumanMessage(content="go")]
    for i in range(2):
        messages.extend((_call(i), ToolMessage(content=chunk, name="tick",
                                               id=f"result-{i}", tool_call_id=f"tick-{i}")))
    middleware = ToolResultPruneMiddleware()
    assert middleware.before_model({"messages": messages[:3]}, None) is None
    decision = middleware.before_model({"messages": messages}, None)
    assert decision is not None
    assert decision["_circle_pruned_tool_ids"] == ["result-0", "result-1"]
    assert decision["_circle_strip_thinking_after"] == "result-0"
    state = {**decision, "messages": messages}
    assert middleware.before_model(state, None) is None
    projected = prune_messages(messages, pruned_ids=set(decision["_circle_pruned_tool_ids"]),
                               strip_after=decision["_circle_strip_thinking_after"])
    assert "pruned to free context" in projected[2].content
    assert projected[2].content.startswith(chunk[:160])
    assert messages[2].content == chunk
    assert [b["type"] for b in projected[1].content] == [
        "thinking", "redacted_thinking", "text",
    ]
    assert [b["type"] for b in projected[3].content] == ["text"]
    assert len(messages[3].content) == 3


def test_only_latest_todos_is_protected_and_exemptions_remain(monkeypatch):
    monkeypatch.setenv("CIRCLE_PRUNE_PROTECT_TOKENS", "0")
    big = "x" * 100_000
    messages = [
        AIMessage(content="", tool_calls=[{"name": "write_todos", "args": {},
                                           "id": "p1", "type": "tool_call"}]),
        ToolMessage(content=big, id="old-plan", name="", tool_call_id="p1"),
        ToolMessage(content=big, id="question", name="question", tool_call_id="q"),
        ToolMessage(content=big, id="skill", name="skill", tool_call_id="s"),
        ToolMessage(content=json.dumps({"body": big}), id="json", name="read_file",
                    tool_call_id="j"),
        AIMessage(content="", tool_calls=[{"name": "write_todos", "args": {},
                                           "id": "p2", "type": "tool_call"}]),
        ToolMessage(content=big, id="new-plan", name="", tool_call_id="p2"),
    ]
    decision = ToolResultPruneMiddleware().before_model({"messages": messages}, None)
    assert decision is not None
    assert decision["_circle_pruned_tool_ids"] == ["old-plan"]
    monkeypatch.setenv("CIRCLE_PRUNE_TOOL_OUTPUTS", "0")
    assert ToolResultPruneMiddleware().before_model({"messages": messages}, None) is None
    request = ModelRequest(model=ScriptedModel(responses=[AIMessage(content="ok")]),
                           messages=messages, state={**decision, "messages": messages})
    assert "pruned to free context" in (
        ToolResultPruneMiddleware()._pruned(request).messages[1].content
    )


def test_real_tool_loop_batches_and_keeps_prefix_between_batches(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("CIRCLE_PRUNE_PROTECT_TOKENS", "40000")

    @tool
    def tick(i: int) -> str:
        """Return a large, numbered test result."""
        return f"{i}:" + "x" * 40_000

    model = RecordingModel(responses=[*(_call(i) for i in range(8)),
                                      AIMessage(content="done")])
    agent = create_harness(model, root_dir=tmp_path, extra_tools=[tick])
    config = {"configurable": {"thread_id": "batch-loop"}}
    result = agent.invoke({"messages": [HumanMessage(content="go")]}, config=config)
    assert len(model.seen) == 9
    assert all(_is_prefix(model.seen[i], model.seen[i + 1]) for i in (0, 1, 2, 3, 5, 7))
    assert not _is_prefix(model.seen[4], model.seen[5])
    assert not _is_prefix(model.seen[6], model.seen[7])
    assert "pruned to free context" not in str(model.seen[4])
    assert "pruned to free context" in str(model.seen[5])

    original_tools = [msg for msg in result["messages"] if isinstance(msg, ToolMessage)]
    assert len(original_tools) == 8
    assert all(len(msg.content) > 40_000 for msg in original_tools)
    ids = agent.get_state(config).values["_circle_pruned_tool_ids"]
    assert len(ids) == 4
    assert model.seen[5][2].content[0]["type"] == "thinking"
    assert [block["type"] for block in model.seen[5][4].content] == ["text"]
    assert [block["type"] for block in model.seen[6][4].content] == ["text"]

    # A new harness against the same checkpointer reuses the saved projection.
    checkpoint = agent.checkpointer
    followup = RecordingModel(responses=[AIMessage(content="again")])
    resumed = create_harness(followup, root_dir=tmp_path, extra_tools=[tick],
                             checkpointer=checkpoint)
    resumed.invoke({"messages": [HumanMessage(content="next")]}, config=config)
    assert "pruned to free context" in str(followup.seen[0])
