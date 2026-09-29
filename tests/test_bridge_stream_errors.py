"""Bridge stream failures must reach on_error."""

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from tests.test_bridge_approval_cancel_regressions import _bridge, _call, _wait_for


class ToolThenFailureModel(BaseChatModel):
    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        if messages[-1].type == "human":
            return ChatResult(generations=[ChatGeneration(message=_call("ls", {}, "ls-1"))])
        raise RuntimeError("model failed after ls")

    @property
    def _llm_type(self):
        return "tool-then-failure-test"


def test_error_after_tool_output_is_reported_as_error(tmp_path):
    bridge, interrupts, done, errors = _bridge(ToolThenFailureModel(), tmp_path)
    bridge.start("show files")
    _wait_for(lambda: bool(errors) and not bridge.is_running)
    assert "model failed after ls" in str(errors[0])
    assert not done and not interrupts


class PartialStreamFailureModel(BaseChatModel):
    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        raise AssertionError("stream path expected")

    def _stream(self, messages, stop=None, run_manager=None, **_kwargs):
        yield ChatGenerationChunk(message=AIMessageChunk(content="partial answer"))
        raise RuntimeError("stream disconnected")

    @property
    def _llm_type(self):
        return "partial-stream-failure-test"


def test_partial_first_stream_is_not_a_final_answer(tmp_path):
    bridge, interrupts, done, errors = _bridge(PartialStreamFailureModel(), tmp_path)
    bridge.start("my original question")
    _wait_for(lambda: bool(errors) and not bridge.is_running)
    assert "stream disconnected" in str(errors[0])
    assert not done and not interrupts
