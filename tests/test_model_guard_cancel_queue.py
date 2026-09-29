"""Cancel a real Bridge turn during Retry-After and drain later messages FIFO."""

from __future__ import annotations

import time
from typing import ClassVar

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from circle.ink.parse_keypress import KeyPress
from circle.model_guard import add_retry_listener, guard_model
from tests.test_model_guard import status_error
from tests.test_slash_behaviors import _app


class RateLimitedTurnModel(BaseChatModel):
    seen: ClassVar[list[str]] = []

    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        text = str(next(msg.content for msg in reversed(messages) if msg.type == "human"))
        self.seen.append(text)
        if text == "FIRST":
            raise status_error(429, "slow", headers={"retry-after": "5"})
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=f"{text}-done"))])

    def _stream(self, messages, stop=None, run_manager=None, **_kwargs):
        result = self._generate(messages, stop=stop, run_manager=run_manager)
        yield ChatGenerationChunk(
            message=AIMessageChunk(content=str(result.generations[0].message.content)),
            generation_info={"finish_reason": "stop"},
        )

    @property
    def _llm_type(self):
        return "rate-limited-turn-test"


def _wait_for(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    pytest.fail("cancelled worker or queued turns did not finish")


def test_cancel_interrupts_backoff_and_drains_messages_in_arrival_order(tmp_path, monkeypatch):
    RateLimitedTurnModel.seen = []
    app = _app(tmp_path, monkeypatch)
    app.model_override = guard_model(RateLimitedTurnModel())
    app._rebuild_agent(model=app.model_override)
    retries = []
    remove = add_retry_listener(retries.append)
    try:
        app._on_submit("FIRST")
        _wait_for(lambda: any(event.get("event") == "retry" for event in retries))
        start = time.monotonic()
        app._handle_key(KeyPress(key="escape"))
        app._on_submit("SECOND", kind="followup")
        app._on_submit("THIRD", kind="steering")
        _wait_for(lambda: app._last_assistant_plain == "THIRD-done"
                  and not app._bridge.is_running and not app._msg_queue)
        assert time.monotonic() - start < 4
        assert RateLimitedTurnModel.seen == ["FIRST", "SECOND", "THIRD"]
        transcript = "\n".join(app._transcript.snapshot())
        assert transcript.index("SECOND-done") < transcript.index("THIRD-done")
    finally:
        remove()
