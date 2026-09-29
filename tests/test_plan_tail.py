"""The current plan appears only in model requests, with legal provider roles."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import Field

from circle.harness import create_harness
from circle.middleware.plan_tail import PlanTailMiddleware, plan_tail
from circle.middleware.tool_result_prune import prune_messages
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


@pytest.mark.parametrize("protocol,model_name", [
    ("anthropic", "claude-sonnet-4-5"),
    ("openai", "gpt-5.1"),
])
def test_plan_is_only_in_the_request_and_provider_roles_are_legal(
        tmp_path, protocol: str, model_name: str) -> None:
    home = tmp_path / "home"
    save_credentials({"api_key": "sk-test"}, home)
    settings = CircleSettings(initialized=True, auth=ModelAuth(
        protocol=protocol, base_url="http://127.0.0.1:9", model=model_name,
    ))
    model = build_chat_model(settings, home=home)
    original = [
        HumanMessage(content="Compile these cases"),
        AIMessage(content="", tool_calls=[{"name": "execute", "args": {"command": "pwd"},
                                           "id": "call_1", "type": "tool_call"}]),
        ToolMessage(content="working directory", name="execute", tool_call_id="call_1"),
    ]
    state = {"messages": original, "todos": _todos()}
    system = SystemMessage(content="Stable system prompt")
    request = ModelRequest(model=model, messages=original, state=state, system_message=system)
    seen = []

    def handler(current):
        seen.append(current)
        return ModelResponse(result=[AIMessage(content="ok")])

    middleware = PlanTailMiddleware()
    middleware.wrap_model_call(request, handler)
    middleware.wrap_model_call(request, handler)
    assert len(seen) == 2
    assert request.messages is original and len(original) == 3
    assert original[-1].content == "working directory"
    assert state["messages"] is original and state["todos"] == _todos()
    assert all(current.system_message is system for current in seen)
    assert all(len(current.messages) == 4 for current in seen)
    reminder = seen[0].messages[-1]
    assert isinstance(reminder, HumanMessage)
    assert reminder.content.startswith("This is your current write_todos plan;")
    assert "[x] Read the manual" in reminder.content
    assert "[>] Compile the cases" in reminder.content
    assert "[ ] Check the output" in reminder.content
    assert seen[1].messages[-1].content == reminder.content

    payload = model._get_request_payload([system, *seen[0].messages])
    wire = payload["messages"]
    if protocol == "anthropic":
        assert [entry["role"] for entry in wire] == ["user", "assistant", "user"]
        assert [block["type"] for block in wire[-1]["content"]] == ["tool_result", "text"]
        assert wire[-1]["content"][-1]["text"] == reminder.content
    else:
        assert [entry["role"] for entry in wire] == ["system", "user", "assistant", "tool", "user"]
        assert wire[-1]["content"] == reminder.content


def test_last_user_message_is_extended_without_mutating_history() -> None:
    last = HumanMessage(content=[{"type": "text", "text": "Continue"}])
    state = {"messages": [last], "todos": _todos()}
    request = ModelRequest(model=ScriptedModel(responses=[AIMessage(content="ok")]),
                           messages=state["messages"], state=state)
    changed = PlanTailMiddleware._with_plan(request)
    assert len(changed.messages) == 1
    assert changed.messages[0] is not last
    assert changed.messages[0].content[0] == {"type": "text", "text": "Continue"}
    assert "write_todos plan" in changed.messages[0].content[-1]["text"]
    assert state["messages"] == [last] and len(last.content) == 1


@pytest.mark.parametrize("todos", [None, [], [{"content": "done", "status": "completed"}]])
def test_no_unfinished_plan_adds_no_reminder(todos) -> None:
    request = ModelRequest(model=ScriptedModel(responses=[AIMessage(content="ok")]),
                           messages=[HumanMessage(content="go")], state={"todos": todos})
    assert PlanTailMiddleware._with_plan(request) is request


def test_subagent_does_not_inherit_the_main_plan(monkeypatch) -> None:
    monkeypatch.setattr("circle.middleware.plan_tail.get_config",
                        lambda: {"configurable": {"ls_agent_type": "subagent"}})
    request = ModelRequest(model=ScriptedModel(responses=[AIMessage(content="ok")]),
                           messages=[HumanMessage(content="work")], state={"todos": _todos()})
    assert PlanTailMiddleware._with_plan(request) is request


def test_plan_tail_is_bounded_and_keeps_the_active_step() -> None:
    todos = [{"content": f"finished {i}", "status": "completed"} for i in range(20)]
    todos += [{"content": "active " + "中" * 160, "status": "in_progress"}]
    todos += [{"content": f"later {i}", "status": "pending"} for i in range(5)]
    lines = plan_tail(todos).splitlines()
    assert len(lines) <= 18
    assert any(line.startswith("[>] active ") for line in lines)
    assert max(map(len, lines[1:])) <= 100
    assert lines[1].startswith("… ")


def test_write_todos_repr_result_is_never_pruned() -> None:
    big = "x" * 120_000
    result = "Updated todo list to [" + big + "]"
    messages = [ToolMessage(content=result, name="write_todos", tool_call_id="plan")]
    messages.extend(ToolMessage(content=big, name="read_file", tool_call_id=f"read-{i}")
                    for i in range(3))
    pruned = prune_messages(messages)
    assert pruned[0].content == result
    assert "pruned to free context" in pruned[1].content
    assert messages[1].content == big


def test_async_model_hook_uses_the_same_request_only_tail() -> None:
    request = ModelRequest(model=ScriptedModel(responses=[AIMessage(content="ok")]),
                           messages=[HumanMessage(content="go")], state={"todos": _todos()})
    seen = []

    async def handler(current):
        seen.append(current)
        return ModelResponse(result=[AIMessage(content="ok")])

    asyncio.run(PlanTailMiddleware().awrap_model_call(request, handler))
    assert "[>] Compile the cases" in seen[0].messages[-1].content
    assert len(request.messages) == 1


def test_real_harness_repeats_current_plan_without_persisting_the_reminder(tmp_path: Path) -> None:
    todos = _todos()
    model = RecordingModel(responses=[
        AIMessage(content="", tool_calls=[{"name": "write_todos", "args": {"todos": todos},
                                           "id": "plan-call", "type": "tool_call"}]),
        AIMessage(content="first reply"),
        AIMessage(content="second reply"),
    ])
    agent = create_harness(model, root_dir=tmp_path)
    config = {"configurable": {"thread_id": "plan-tail"}}
    first = agent.invoke({"messages": [HumanMessage(content="compile") ]}, config=config)
    assert first["todos"] == todos and len(model.seen) == 2
    assert "[>] Compile the cases" in model.seen[1][-1].content
    assert not any("This is your current write_todos plan" in str(message.content)
                   for message in first["messages"])

    second = agent.invoke({"messages": [HumanMessage(content="continue")]}, config=config)
    assert second["todos"] == todos and len(model.seen) == 3
    assert "[>] Compile the cases" in model.seen[2][-1].content
    assert model.seen[2][-1].content.count("This is your current write_todos plan") == 1
    assert not any("This is your current write_todos plan" in str(message.content)
                   for message in agent.get_state(config).values["messages"])
