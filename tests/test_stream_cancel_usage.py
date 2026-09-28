"""Parallel token coalescing, turn cancellation, and subagent accounting."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import ClassVar
from uuid import uuid4

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import (
    ChatGeneration,
    ChatGenerationChunk,
    ChatResult,
    LLMResult,
)

from circle.events import EventBus
from circle.harness import create_harness
from circle.middleware.cancellation import CancellationToken, CircleCancelled
from circle.pricing import price_call
from circle.tui.harness_bridge import HarnessBridge
from circle.tui.message_model import BLOCK_AGENT_CARD
from circle.tui.progress_handler import ProgressHandler
from circle.tui.reducer import MessageReducer
from circle.tui.sink import TuiSink


def _wait_until(predicate, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("timed out waiting for the agent")


def test_subagent_tokens_build_bounded_snapshots(monkeypatch) -> None:
    monkeypatch.setattr("circle.tui.reducer.time.time", lambda: 123.0)
    posted = []
    seen = []
    sink = TuiSink(post=posted.append)
    bus = EventBus(run_id="many-tokens")
    bus.subscribe(seen.append)
    bus.subscribe(sink)
    built = 0
    original = sink.reducer._snapshot_locked

    def counted():
        nonlocal built
        built += 1
        return original()

    sink.reducer._snapshot_locked = counted
    bus.emit("run_start")
    bus.emit("tool_call", tags={"name": "task", "lc_tool_run_id": "task-run"},
             payload={"input": {"subagent_type": "general-purpose", "description": "work"}})
    for _ in range(2000):
        bus.emit("llm_token", tags={"parent_subagent": "general-purpose",
                                    "parent_tool_use_id": "task-run"},
                 payload={"reasoning": "x"})
    bus.emit("tool_result", tags={"name": "task", "lc_tool_run_id": "task-run"},
             payload={"output": "done", "status": "success"})
    bus.emit("run_end")

    expected = MessageReducer()
    for event in seen:
        expected.dispatch(event, notify=False)
    assert posted[-1] == expected.snapshot()
    assert built < 100 and len(posted) < 100


def test_running_card_and_main_stream_start_post_promptly() -> None:
    posted = []
    sink = TuiSink(post=posted.append)
    bus = EventBus(run_id="visible")
    bus.subscribe(sink)
    bus.emit("run_start")
    bus.emit("tool_call", tags={"name": "task", "lc_tool_run_id": "task-run"},
             payload={"input": {"subagent_type": "general-purpose", "description": "work"}})
    _wait_until(lambda: any(
        block.type == BLOCK_AGENT_CARD and block.payload.get("status") == "running"
        for snap in posted for message in snap.messages for block in message.content
    ))
    bus.emit("llm_token", payload={"content": "first"})
    _wait_until(lambda: any(snap.streaming_text == "first" for snap in posted))


class PausedParallelModel(BaseChatModel):
    gate: ClassVar[threading.Event] = threading.Event()
    entered: ClassVar[list[str]] = []
    calls: ClassVar[list[str]] = []
    lock: ClassVar[threading.Lock] = threading.Lock()

    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        first = str(next(message.content for message in messages if message.type == "human"))
        last = messages[-1]
        with self.lock:
            self.calls.append(first)
        if first == "DIRECT":
            with self.lock:
                self.entered.append(first)
            self.gate.wait(10)
            answer = AIMessage(content="", tool_calls=[{
                "name": "execute", "args": {"command": "touch direct.done"},
                "id": "execute-direct", "type": "tool_call",
            }])
        elif first.startswith("SUB"):
            with self.lock:
                self.entered.append(first)
            self.gate.wait(10)
            answer = AIMessage(content="", tool_calls=[{
                "name": "execute", "args": {"command": f"touch {first}.done"},
                "id": f"execute-{first}", "type": "tool_call",
            }])
        elif str(last.content) == "NEXT":
            answer = AIMessage(content="new turn works")
        elif last.type == "human":
            answer = AIMessage(content="", tool_calls=[{
                "name": "task", "args": {"subagent_type": "general-purpose",
                                         "description": f"SUB{i}"},
                "id": f"task-{i}", "type": "tool_call",
            } for i in range(2)])
        else:
            answer = AIMessage(content="finished")
        return ChatResult(generations=[ChatGeneration(message=answer)])

    @property
    def _llm_type(self):
        return "paused-parallel-test"


def test_cancel_stops_parallel_subagent_tools_and_new_turn_runs(tmp_path: Path) -> None:
    PausedParallelModel.gate = threading.Event()
    PausedParallelModel.entered = []
    PausedParallelModel.calls = []
    agent = create_harness(PausedParallelModel(), root_dir=tmp_path)
    done = []
    errors = []
    bridge = HarnessBridge(agent=agent, thread_id="cancel-parallel",
                           on_update=lambda _update: None,
                           on_interrupt=lambda _interrupts: None,
                           on_done=done.append, on_error=errors.append)
    bridge.start("MAIN")
    _wait_until(lambda: len(PausedParallelModel.entered) == 2)
    bridge.cancel()
    calls_at_cancel = len(PausedParallelModel.calls)
    PausedParallelModel.gate.set()
    _wait_until(lambda: not bridge.is_running)
    assert len(PausedParallelModel.calls) == calls_at_cancel
    assert not list(tmp_path.glob("SUB*.done"))
    assert not errors

    bridge.start("NEXT")
    _wait_until(lambda: not bridge.is_running)
    assert done == ["new turn works"]
    assert not errors


def test_cancel_stops_a_pending_main_tool(tmp_path: Path) -> None:
    PausedParallelModel.gate = threading.Event()
    PausedParallelModel.entered = []
    PausedParallelModel.calls = []
    agent = create_harness(PausedParallelModel(), root_dir=tmp_path)
    errors = []
    bridge = HarnessBridge(agent=agent, thread_id="cancel-main",
                           on_update=lambda _update: None,
                           on_interrupt=lambda _interrupts: None,
                           on_done=lambda _text: None, on_error=errors.append)
    bridge.start("DIRECT")
    _wait_until(lambda: PausedParallelModel.entered == ["DIRECT"])
    bridge.cancel()
    PausedParallelModel.gate.set()
    _wait_until(lambda: not bridge.is_running)
    assert not (tmp_path / "direct.done").exists()
    assert not errors


class StreamingModel(BaseChatModel):
    next_chunk: ClassVar[threading.Event] = threading.Event()
    closed: ClassVar[threading.Event] = threading.Event()

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="unused"))])

    def _stream(self, messages, stop=None, run_manager=None, **_kwargs):
        try:
            yield ChatGenerationChunk(message=AIMessageChunk(content="first"))
            self.next_chunk.wait(10)
            yield ChatGenerationChunk(message=AIMessageChunk(content="second"))
        finally:
            self.closed.set()

    @property
    def _llm_type(self):
        return "stream-cancel-test"


def test_cancel_closes_stream_on_next_chunk() -> None:
    StreamingModel.next_chunk = threading.Event()
    StreamingModel.closed = threading.Event()
    token = CancellationToken()
    bus = EventBus(run_id="stream")
    seen = []
    bus.subscribe(seen.append)
    errors = []

    def consume() -> None:
        try:
            list(StreamingModel().stream("hello", config={
                "callbacks": [ProgressHandler(bus, cancel_token=token)],
            }))
        except CircleCancelled as exc:
            errors.append(exc)

    worker = threading.Thread(target=consume)
    worker.start()
    _wait_until(lambda: any(event["kind"] == "llm_token" for event in seen))
    token.cancel()
    StreamingModel.next_chunk.set()
    worker.join(timeout=10)
    assert StreamingModel.closed.is_set()
    assert len(errors) == 1 and isinstance(errors[0], CircleCancelled)


class UsageParallelModel(BaseChatModel):
    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        first = str(next(message.content for message in messages if message.type == "human"))
        last = messages[-1]
        if first.startswith("SUB"):
            answer = AIMessage(content="sub done")
        elif last.type == "human":
            answer = AIMessage(content="", tool_calls=[{
                "name": "task", "args": {"subagent_type": "general-purpose",
                                         "description": f"SUB{i}"},
                "id": f"usage-task-{i}", "type": "tool_call",
            } for i in range(2)])
        else:
            answer = AIMessage(content="main done")
        answer.usage_metadata = {"input_tokens": 100, "output_tokens": 10,
                                 "total_tokens": 110}
        answer.response_metadata = {"model_name": "claude-sonnet-5"}
        return ChatResult(generations=[ChatGeneration(message=answer)])

    @property
    def _llm_type(self):
        return "usage-parallel-test"


def test_bridge_main_usage_does_not_double_count_subagents(tmp_path: Path) -> None:
    agent = create_harness(UsageParallelModel(), root_dir=tmp_path)
    updates = []
    done = []
    errors = []
    bridge = HarnessBridge(agent=agent, thread_id="usage-parallel",
                           on_update=updates.append,
                           on_interrupt=lambda _interrupts: None,
                           on_done=done.append, on_error=errors.append)
    bridge.start("MAIN")
    _wait_until(lambda: not bridge.is_running)
    assert done == ["main done"] and not errors
    main_usage = [update.usage for update in updates if update.usage]
    assert main_usage[-1]["input_tokens"] == 200
    snap = bridge._sink.reducer.snapshot()
    assert snap.usage["input_tokens"] == 200
    assert snap.fork_usage["input_tokens"] == 200


def test_subagent_usage_keeps_its_model_price_and_cache_totals() -> None:
    reducer = MessageReducer()
    reducer.dispatch({"kind": "llm_token", "run_id": "run", "seq": 0,
                      "payload": {"content": "main is streaming"}})
    usage = {"input_tokens": 1000, "output_tokens": 100,
             "prompt_cache_hit_tokens": 600, "prompt_cache_write_tokens": 200}
    cost = price_call("claude-sonnet-5", usage)
    event = {"kind": "llm_end", "run_id": "run", "seq": 1, "ts": "",
             "tags": {"parent_subagent": "general-purpose"},
             "payload": {"name": "subagent_usage", "usage_call_id": "one",
                         "usage_cost": cost}, "usage": usage}
    reducer.dispatch(event)
    reducer.dispatch(event)
    snap = reducer.snapshot()
    assert snap.fork_usage["input_tokens"] == 1000
    assert snap.fork_usage["prompt_cache_hit_tokens"] == 600
    assert snap.fork_usage_cost["calls"] == 1
    assert snap.fork_usage_cost["amounts"] == {"USD": cost["amount"]}
    assert not snap.usage, "the main context must remain separate"
    assert snap.streaming_text == "main is streaming"
    reducer.reset()
    assert reducer.snapshot().fork_usage["input_tokens"] == 1000


def test_progress_handler_prices_each_subagent_model() -> None:
    bus = EventBus(run_id="prices")
    reducer = MessageReducer()
    bus.subscribe(reducer.dispatch)
    handler = ProgressHandler(bus)
    usage = {"input_tokens": 1000, "output_tokens": 100, "total_tokens": 1100,
             "input_token_details": {"cache_read": 600}}
    for model in ("claude-sonnet-5", "qwen3.8-flash"):
        run_id = uuid4()
        metadata = {"lc_agent_name": "general-purpose"}
        handler.on_chat_model_start({"name": "test"}, [[]], run_id=run_id,
                                    metadata=metadata, invocation_params={"model": model})
        response = LLMResult(generations=[[ChatGeneration(message=AIMessage(
            content="done", usage_metadata=usage,
            response_metadata={"model_name": model},
        ))]])
        handler.on_llm_end(response, run_id=run_id, metadata=metadata)
    snap = reducer.snapshot()
    assert snap.fork_usage["input_tokens"] == 2000
    assert snap.fork_usage["prompt_cache_hit_tokens"] == 1200
    assert snap.fork_usage_cost["calls"] == 2
    assert set(snap.fork_usage_cost["amounts"]) == {"USD", "RMB"}
