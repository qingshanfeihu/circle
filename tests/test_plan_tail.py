"""Checkpointed plan reminders, their cadence, and provider message shape."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import Field

from circle.harness import create_harness
from circle.middleware.plan_tail import PlanTailMiddleware, is_plan_reminder, plan_tail
from circle.model import build_chat_model
from circle.settings import CircleSettings, ModelAuth, save_credentials
from circle.testing import ScriptedModel


class RecordingModel(ScriptedModel):
    seen: list[list[Any]] = Field(default_factory=list)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)


def _todos() -> list[dict[str, str]]:
    return [{"content": "Read the manual", "status": "completed"},
            {"content": "Compile the cases", "status": "in_progress"},
            {"content": "Check the output", "status": "pending"}]


def _call(name: str, call_id: str, args: dict | None = None) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args or {},
                                              "id": call_id, "type": "tool_call"}])


def _history(rounds: int) -> list[Any]:
    messages: list[Any] = [HumanMessage(content="compile"),
                           _call("write_todos", "plan", {"todos": _todos()}),
                           ToolMessage(content="plan saved", tool_call_id="plan")]
    for i in range(rounds):
        messages.extend((_call("tick", f"tick-{i}"),
                         ToolMessage(content="ok", tool_call_id=f"tick-{i}")))
    return messages


@pytest.mark.parametrize("protocol,model_name", [
    ("anthropic", "claude-sonnet-4-5"),
    ("openai", "gpt-5.1"),
])
def test_reminder_is_a_separate_message_after_tool_result(tmp_path, protocol, model_name):
    home = tmp_path / "home"
    save_credentials({"api_key": "sk-test"}, home)
    settings = CircleSettings(initialized=True, auth=ModelAuth(
        protocol=protocol, base_url="http://127.0.0.1:9", model=model_name,
    ))
    model = build_chat_model(settings, home=home)
    original = _history(10)
    state = {"messages": original, "todos": _todos()}
    reminder = PlanTailMiddleware._reminder(state)
    assert reminder is not None and is_plan_reminder(reminder)
    assert "privately" in reminder.content
    assert "not a user message" in reminder.content
    assert "Do not reply" in reminder.content
    assert original[-1].content == "ok"

    system = SystemMessage(content="Stable system prompt")
    payload = model._get_request_payload([system, *original, reminder])
    wire = payload["messages"]
    if protocol == "anthropic":
        assert [block["type"] for block in wire[-1]["content"]] == ["tool_result", "text"]
        assert wire[-1]["content"][-1]["text"] == reminder.content
    else:
        assert [entry["role"] for entry in wire[-2:]] == ["tool", "user"]
        assert wire[-1]["content"] == reminder.content


def test_cadence_completion_and_current_turn_only(monkeypatch):
    middleware = PlanTailMiddleware()
    assert middleware.before_model({"messages": _history(9), "todos": _todos()}, None) is None
    state = {"messages": _history(10), "todos": _todos()}
    first = middleware.before_model(state, None)
    assert first is not None and is_plan_reminder(first["messages"][0])
    state["messages"].extend(first["messages"])
    state["messages"].extend((_call("tick", "next"), ToolMessage(content="ok", tool_call_id="next")))
    assert middleware.before_model(state, None) is None
    for i in range(9):
        state["messages"].extend((_call("tick", f"more-{i}"),
                                  ToolMessage(content="ok", tool_call_id=f"more-{i}")))
    assert middleware.before_model(state, None) is not None
    state["todos"] = [{"content": "done", "status": "completed"}]
    assert middleware.before_model(state, None) is None

    state["todos"] = _todos()
    state["messages"].append(HumanMessage(content="unrelated question"))
    state["messages"].extend((_call("tick", "unrelated"),
                              ToolMessage(content="ok", tool_call_id="unrelated")))
    assert middleware.before_model(state, None) is None
    state["messages"].extend((_call("write_todos", "bad", {"todos": _todos()}),
                              ToolMessage(content="invalid plan", tool_call_id="bad",
                                          status="error")))
    for i in range(10):
        state["messages"].extend((_call("tick", f"failed-{i}"),
                                  ToolMessage(content="ok", tool_call_id=f"failed-{i}")))
    assert middleware.before_model(state, None) is None
    state["messages"].append(HumanMessage(content="continue"))
    state["messages"].extend(_history(10)[1:])
    assert middleware.before_model(state, None) is not None

    monkeypatch.setattr("circle.middleware.plan_tail.get_config",
                        lambda: {"configurable": {"ls_agent_type": "subagent"}})
    assert middleware.before_model(state, None) is None


def test_compaction_hiding_the_write_call_refreshes_the_reminder():
    state = {"messages": _history(1), "todos": _todos()}
    state["_summarization_event"] = {
        "cutoff_index": 3,
        "summary_message": HumanMessage(content="Summary", additional_kwargs={
            "lc_source": "summarization",
        }),
    }
    reminder = PlanTailMiddleware._reminder(state)
    assert reminder is not None
    state["messages"].append(reminder)
    state["messages"].extend((_call("tick", "again"), ToolMessage(content="ok", tool_call_id="again")))
    assert PlanTailMiddleware._reminder(state) is None


def test_async_hook_and_bounded_plan():
    state = {"messages": _history(10), "todos": _todos()}
    result = asyncio.run(PlanTailMiddleware().abefore_model(state, None))
    assert result is not None and is_plan_reminder(result["messages"][0])
    todos = [{"content": f"finished {i}", "status": "completed"} for i in range(20)]
    todos += [{"content": "active " + "中" * 160, "status": "in_progress"}]
    todos += [{"content": f"later {i}", "status": "pending"} for i in range(5)]
    lines = plan_tail(todos).splitlines()
    assert len(lines) <= 18
    assert any(line.startswith("[>] active ") for line in lines)
    assert max(map(len, lines[1:])) <= 100
    assert lines[1].startswith("… ")


def test_real_harness_persists_one_reminder_and_keeps_request_prefix(tmp_path: Path):
    @tool
    def tick(i: int) -> str:
        """Advance a harmless test step."""
        return str(i)

    todos = _todos()
    responses = [_call("write_todos", "plan-call", {"todos": todos})]
    responses += [_call("tick", f"tick-{i}", {"i": i}) for i in range(10)]
    responses.append(AIMessage(content="done"))
    model = RecordingModel(responses=responses)
    agent = create_harness(model, root_dir=tmp_path, extra_tools=[tick])
    config = {"configurable": {"thread_id": "plan-tail"}}
    result = agent.invoke({"messages": [HumanMessage(content="compile")]}, config=config)
    assert result["todos"] == todos
    assert len(model.seen) == 12
    assert not any(is_plan_reminder(msg) for msg in model.seen[10])
    assert is_plan_reminder(model.seen[11][-1])
    assert [msg.model_dump(exclude_none=True) for msg in model.seen[10]] == [
        msg.model_dump(exclude_none=True) for msg in model.seen[11][:len(model.seen[10])]
    ]
    saved = agent.get_state(config).values["messages"]
    assert sum(is_plan_reminder(msg) for msg in saved) == 1
    assert saved[-1].content == "done"

    agent.invoke({"messages": [HumanMessage(content="new topic")]}, config=config)
    assert sum(is_plan_reminder(msg) for msg in model.seen[-1]) == 1
    assert not is_plan_reminder(model.seen[-1][-1])
