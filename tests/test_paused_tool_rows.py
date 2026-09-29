"""Question and approval interruptions retain and settle their original rows."""

from __future__ import annotations

import time

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from circle.ink.parse_keypress import KeyPress
from circle.tui.agent_strip import card_activity, card_light, snapshot_cards
from circle.tui.message_model import BLOCK_TOOL_RESULT, BLOCK_TOOL_USE
from tests.test_approval_decision_stability import _calls
from tests.test_slash_behaviors import _app


def _wait_for(predicate):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    pytest.fail("session did not reach expected state")


def _blocks(app, kind, name):
    return [block for message in app._bridge._sink.reducer.snapshot().messages
            for block in message.content if block.type == kind and block.name == name]


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{
        "name": name, "args": args, "id": call_id, "type": "tool_call",
    }])


def test_answered_question_reuses_one_completed_tool_row(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch, responses=[
        _calls(("question", {"questions": [{"question": "Proceed?", "options": ["Yes"]}]})),
        AIMessage(content="done"),
    ])
    app._on_submit("ask")
    _wait_for(lambda: app._ask_session is not None and not app._bridge.is_running)
    assert len(_blocks(app, BLOCK_TOOL_USE, "question")) == 1
    app._handle_key(KeyPress(key="1", char="1"))
    _wait_for(lambda: app._last_assistant_plain == "done" and not app._bridge.is_running)
    uses = _blocks(app, BLOCK_TOOL_USE, "question")
    results = _blocks(app, BLOCK_TOOL_RESULT, "question")
    assert len(uses) == len(results) == 1
    assert uses[0].status == "done" and results[0].tool_use_id == uses[0].tool_use_id


class SubagentQuestionModel(BaseChatModel):
    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        first = str(next(msg.content for msg in messages if msg.type == "human"))
        last = messages[-1]
        if first == "MAIN":
            answer = (_call("task", {"subagent_type": "general-purpose",
                                     "description": "SUB: ask one question"}, "task-1")
                      if last.type == "human" else AIMessage(content="finished"))
        else:
            answer = (_call("question", {"questions": [{
                "question": "Proceed?", "options": ["Yes"]}]}, "question-1")
                      if last.type == "human" else AIMessage(content="sub finished"))
        return ChatResult(generations=[ChatGeneration(message=answer)])

    @property
    def _llm_type(self):
        return "subagent-question-test"


def test_subagent_question_waits_for_answer_and_counts_once(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app.model_override = SubagentQuestionModel()
    app._rebuild_agent(model=app.model_override)
    app._on_submit("MAIN")
    _wait_for(lambda: app._ask_session is not None and not app._bridge.is_running)
    card = snapshot_cards(app._bridge._sink.reducer.snapshot())[0][1]
    assert card["awaiting_question"] and not card["awaiting_approval"]
    assert card_activity(card) == "waiting for you"
    assert card_light(card) == ("\x1b[36m", "●")
    app._handle_key(KeyPress(key="1", char="1"))
    _wait_for(lambda: app._last_assistant_plain == "finished" and not app._bridge.is_running)
    card = snapshot_cards(app._bridge._sink.reducer.snapshot())[0][1]
    assert card["n_calls"] == 1 and not card["awaiting_question"]
    assert len([item for item in card["transcript"]
                if item.get("kind") == "tool" and item.get("tool") == "question"]) == 1


def test_cancel_settles_paused_task_and_question_rows(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    app.model_override = SubagentQuestionModel()
    app._rebuild_agent(model=app.model_override)
    app._on_submit("MAIN")
    _wait_for(lambda: app._ask_session is not None and not app._bridge.is_running)
    app._handle_key(KeyPress(key="ctrl+c", char="c", ctrl=True))
    snap = app._bridge._sink.reducer.snapshot()
    assert app._ask_session is None
    assert all(block.status == "error" for message in snap.messages
               for block in message.content if block.type == BLOCK_TOOL_USE)
    cards = snapshot_cards(snap)
    assert len(cards) == 1
    assert cards[0][1]["status"] == "error"
    assert not cards[0][1]["awaiting_approval"]
    assert not cards[0][1]["awaiting_question"]
