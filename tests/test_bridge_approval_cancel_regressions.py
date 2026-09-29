"""Real harness/bridge regressions for resumed approvals and stream failures."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from circle.harness import create_harness
from circle.tui.harness_bridge import HarnessBridge


def _wait_for(predicate, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    pytest.fail("bridge did not reach the expected state")


def _bridge(model: BaseChatModel, root: Path, thread_id: str = "bridge-regression"):
    interrupts: list = []
    done: list[str] = []
    errors: list[BaseException] = []
    bridge = HarnessBridge(
        agent=create_harness(model, root_dir=root, home=root / ".home"),
        thread_id=thread_id, on_update=lambda _update: None,
        on_interrupt=interrupts.append, on_done=done.append, on_error=errors.append,
    )
    return bridge, interrupts, done, errors


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[
        {"name": name, "args": args, "id": call_id, "type": "tool_call"},
    ])


class SequentialSubagentModel(BaseChatModel):
    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        first = str(next(msg.content for msg in messages if msg.type == "human"))
        last = messages[-1]
        if first == "MAIN":
            answer = (_call("task", {"subagent_type": "general-purpose",
                                    "description": "SUB: run two commands"}, "task-1")
                      if last.type == "human" else AIMessage(content="finished"))
        else:
            completed = sum(msg.type == "tool" for msg in messages)
            answer = (_call("execute", {"command": f"touch command-{completed + 1}"},
                            f"execute-{completed + 1}") if completed < 2
                      else AIMessage(content="subagent finished"))
        return ChatResult(generations=[ChatGeneration(message=answer)])

    @property
    def _llm_type(self):
        return "sequential-subagent-approval-test"


@pytest.mark.parametrize("first_decision", ["approve", "reject"])
def test_subagent_second_approval_waits_for_its_own_decision(tmp_path, first_decision):
    bridge, interrupts, done, errors = _bridge(SequentialSubagentModel(), tmp_path)
    bridge.start("MAIN")
    _wait_for(lambda: len(interrupts) == 1 and not bridge.is_running)
    assert len(interrupts[0][0].value["action_requests"]) == 1

    bridge.resume({"decision": first_decision})
    _wait_for(lambda: len(interrupts) == 2 and not bridge.is_running)
    assert not (tmp_path / "command-2").exists()
    assert (tmp_path / "command-1").exists() is (first_decision == "approve")
    assert not done and not errors

    bridge.resume({"decision": "reject"})
    _wait_for(lambda: bool(done) and not bridge.is_running)
    assert done == ["finished"] and not errors
    assert not (tmp_path / "command-2").exists()
