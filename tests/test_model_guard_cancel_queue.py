"""Cancel a real Bridge turn during Retry-After and drain queued messages."""

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


def test_cancel_drains_steering_first_and_each_class_in_order(tmp_path, monkeypatch):
    RateLimitedTurnModel.seen = []
    app = _app(tmp_path, monkeypatch)
    app.model_override = guard_model(RateLimitedTurnModel())
    app._rebuild_agent(model=app.model_override)
    retries = []
    remove = add_retry_listener(retries.append)
    try:
        app._on_submit("FIRST")
        _wait_for(lambda: any(event.get("event") == "retry" for event in retries))
        app._on_submit("FOLLOWUP-1", kind="followup")
        app._on_submit("STEERING-1", kind="steering")
        app._on_submit("FOLLOWUP-2", kind="followup")
        app._on_submit("STEERING-2", kind="steering")
        assert [text for _kind, text in app._msg_queue] == [
            "FOLLOWUP-1", "STEERING-1", "FOLLOWUP-2", "STEERING-2",
        ]
        start = time.monotonic()
        app._handle_key(KeyPress(key="escape"))
        _wait_for(lambda: app._last_assistant_plain == "FOLLOWUP-2-done"
                  and not app._bridge.is_running and not app._msg_queue)
        assert time.monotonic() - start < 4
        assert RateLimitedTurnModel.seen == [
            "FIRST", "STEERING-1", "STEERING-2", "FOLLOWUP-1", "FOLLOWUP-2",
        ]
        transcript = "\n".join(app._transcript.snapshot())
        assert (transcript.index("STEERING-1-done")
                < transcript.index("STEERING-2-done")
                < transcript.index("FOLLOWUP-1-done")
                < transcript.index("FOLLOWUP-2-done"))
    finally:
        remove()
