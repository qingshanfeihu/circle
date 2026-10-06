"""A turn with many quick steps must finish, and persist every tool result.

langgraph 1.2 saves checkpoints on a worker pool by default. Each save waits for the one
before it and for the message writes of its step, which can be queued behind it, so a
burst of fast steps can fill the pool with saves that wait on each other forever. The
harness saves each step before the next one; these tests keep it that way.
"""

from __future__ import annotations

import threading

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from circle.harness import CONFIG_KEY_DURABILITY, create_harness
from circle.testing import ScriptedModel


def test_fast_multi_step_turn_persists_each_tool_result(tmp_path, monkeypatch):
    monkeypatch.setenv('CIRCLE_LOOP_GUARD', '0')

    @tool
    def tick(index: int) -> str:
        """Return a numbered result."""
        return f'result-{index}'

    replies = [AIMessage(content='', tool_calls=[{
        'name': 'tick', 'args': {'index': i}, 'id': f'tick-{i}'
    }]) for i in range(20)] + [AIMessage(content='done')]
    graph = create_harness(ScriptedModel(responses=replies), root_dir=tmp_path,
                           extra_tools=[tick])
    config = {'configurable': {'thread_id': 'checkpoint-smoke'}, 'recursion_limit': 200}
    result = graph.invoke({'messages': [HumanMessage(content='count')]}, config=config)
    assert result['messages'][-1].content == 'done'
    saved = graph.get_state(config).values['messages']
    assert [m.content for m in saved if isinstance(m, ToolMessage)] == [f'result-{i}' for i in range(20)]
    assert saved[-1].content == 'done'


def _call(i: int) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": "tick", "args": {"i": i}, "id": f"tick-{i}"}])


@tool
def tick(i: int) -> str:
    """Return a numbered test result."""
    return f"content {i}"


def test_harness_saves_each_step_before_the_next(tmp_path):
    agent = create_harness(ScriptedModel(responses=[AIMessage(content="done")]), root_dir=tmp_path)
    assert agent.config["configurable"][CONFIG_KEY_DURABILITY] == "sync"


def test_burst_of_quick_steps_finishes_on_a_small_worker_pool(tmp_path, monkeypatch):
    monkeypatch.setenv("CIRCLE_LOOP_GUARD", "0")
    responses = [_call(i) for i in range(12)] + [AIMessage(content="done")]
    agent = create_harness(ScriptedModel(responses=responses), root_dir=tmp_path,
                           extra_tools=[tick])
    outcome: dict[str, object] = {}

    def run() -> None:
        try:
            # Two workers make the old wait-on-each-other pattern hang within a few steps.
            outcome["result"] = agent.invoke(
                {"messages": [HumanMessage(content="go")]},
                config={"configurable": {"thread_id": "burst"}, "max_concurrency": 2},
            )
        except BaseException as exc:  # noqa: BLE001 - reported by the assertion below
            outcome["error"] = exc

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(timeout=30)
    assert not worker.is_alive(), "the turn hung while saving checkpoints"
    assert "error" not in outcome, outcome.get("error")
    assert outcome["result"]["messages"][-1].content == "done"
    saved = agent.get_state({"configurable": {"thread_id": "burst"}})
    assert saved.values["messages"][-1].content == "done"
