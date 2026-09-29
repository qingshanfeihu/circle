"""A display callback failure cannot rewrite a model or tool result."""

from __future__ import annotations

from typing import ClassVar

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from circle.tui.progress_handler import ProgressHandler
from tests.test_bridge_approval_cancel_regressions import _bridge, _call, _wait_for


class OneEffectModel(BaseChatModel):
    seen_tool: ClassVar[list[str]] = []

    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        if messages[-1].type == "human":
            answer = _call("execute", {"command": "touch effect.done"}, "effect-1")
        else:
            self.seen_tool.append(str(next(msg.content for msg in messages
                                           if isinstance(msg, ToolMessage))))
            answer = AIMessage(content="finished")
        return ChatResult(generations=[ChatGeneration(message=answer)])

    @property
    def _llm_type(self):
        return "display-callback-effect-test"


def test_tool_end_projection_failure_does_not_fail_completed_effect(tmp_path, monkeypatch):
    OneEffectModel.seen_tool = []
    bridge, interrupts, done, errors = _bridge(OneEffectModel(), tmp_path)
    bridge._agent._circle_approvals.set_yolo(bridge.thread_id, True)

    def broken_projection(_self, _output, **_kwargs):
        raise RuntimeError("screen callback broke after tool execution")

    monkeypatch.setattr(ProgressHandler, "on_tool_end", broken_projection)
    bridge.start("run effect")
    _wait_for(lambda: bool(done) and not bridge.is_running)
    assert (tmp_path / "effect.done").exists()
    assert done == ["finished"] and not errors and not interrupts
    assert len(OneEffectModel.seen_tool) == 1
    assert "Tool execution failed" not in OneEffectModel.seen_tool[0]


def test_llm_end_projection_failure_preserves_paid_answer(tmp_path, monkeypatch):
    bridge, interrupts, done, errors = _bridge(OneEffectModel(), tmp_path)
    bridge._agent._circle_approvals.set_yolo(bridge.thread_id, True)

    def broken_projection(_self, _response, **_kwargs):
        raise RuntimeError("screen callback broke after model response")

    monkeypatch.setattr(ProgressHandler, "on_llm_end", broken_projection)
    bridge.start("run effect")
    _wait_for(lambda: bool(done) and not bridge.is_running)
    assert done == ["finished"] and not errors and not interrupts
    assert (tmp_path / "effect.done").exists()
