"""A paused task keeps one card and its accumulated facts after HITL resume."""

from __future__ import annotations

from pathlib import Path

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langgraph.errors import GraphBubbleUp
from langgraph.types import Command

from circle.events import EventBus
from circle.harness import create_harness
from circle.ink.theme import status_light
from circle.tui.agent_detail import render_detail_band
from circle.tui.agent_strip import card_activity, snapshot_cards
from circle.tui.message_model import BLOCK_TOOL_RESULT
from circle.tui.progress_handler import ProgressHandler
from circle.tui.reducer import MessageReducer
from circle.tui.transcript_view import ViewOptions, render_turn
from tests.test_parallel_interrupts import ParallelSubagentModel


class MeteredParallelModel(ParallelSubagentModel):
    def _generate(self, *args, **kwargs):
        result = super()._generate(*args, **kwargs)
        result.generations[0].message.usage_metadata = {
            "input_tokens": 10, "output_tokens": 2, "total_tokens": 12,
        }
        return result


class SequentialApprovalModel(BaseChatModel):
    def bind_tools(self, _tools, **_kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **_kwargs):
        first = next(message.content for message in messages if message.type == "human")
        if "MAIN" in str(first):
            if messages[-1].type == "human":
                answer = AIMessage(content="", tool_calls=[{
                    "name": "task",
                    "args": {"subagent_type": "general-purpose",
                             "description": "SUB: run two commands"},
                    "id": "task-sequential",
                    "type": "tool_call",
                }])
            else:
                answer = AIMessage(content="final")
        else:
            completed = sum(isinstance(message, ToolMessage) and message.name == "execute"
                            for message in messages)
            if completed < 2:
                answer = AIMessage(content="", tool_calls=[{
                    "name": "execute",
                    "args": {"command": f"touch step-{completed}.done"},
                    "id": f"execute-{completed}",
                    "type": "tool_call",
                }])
            else:
                answer = AIMessage(content="sub done")
        answer.usage_metadata = {
            "input_tokens": 10, "output_tokens": 2, "total_tokens": 12,
        }
        return ChatResult(generations=[ChatGeneration(message=answer)])

    @property
    def _llm_type(self):
        return "sequential-approval-test"


def test_graph_bubble_up_does_not_emit_a_tool_error():
    bus = EventBus(run_id="bubble")
    events = []
    bus.subscribe(events.append)
    handler = ProgressHandler(bus)
    handler.on_tool_start({"name": "task"}, "{}", run_id="run-1",
                          tool_call_id="task-1")
    handler.on_tool_error(GraphBubbleUp(), run_id="run-1", tool_call_id="task-1")
    assert [event["kind"] for event in events] == ["tool_call"]


def test_parallel_task_cards_wait_and_resume_in_place(tmp_path: Path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    agent = create_harness(MeteredParallelModel(), root_dir=ws, home=home)
    bus = EventBus(run_id="cards")
    reducer = MessageReducer()
    bus.subscribe(reducer.dispatch)
    config = {
        "configurable": {"thread_id": "cards"},
        "callbacks": [ProgressHandler(bus)],
    }

    paused = agent.invoke(
        {"messages": [{"role": "user", "content": "MAIN"}]}, config=config,
    )
    interrupts = paused.get("__interrupt__") or ()
    assert len(interrupts) == 2
    before = snapshot_cards(reducer.snapshot())
    assert len(before) == 2
    before_by_uuid = {uuid: card for uuid, card in before}
    assert all(card["status"] == "running" and card["awaiting_approval"]
               and card["tokens_in"] == 10 and card["tokens_out"] == 2
               for card in before_by_uuid.values())
    assert all(card_activity(card) == "waiting for you" for card in before_by_uuid.values())
    turn = "\n".join(render_turn(reducer.snapshot(), ViewOptions()))
    assert turn.count(" · waiting for you") == 2, "each paused card's meta line says so"
    band, _spans = render_detail_band(before[0][1], index=1, total=2, width=100)
    assert " · waiting for you" in "".join(band)
    assert status_light("wait", reset=False)[2:] in band[0], "the lamp shares the band's SGR"
    assert not [
        block for message in reducer.snapshot().messages for block in message.content
        if block.type == BLOCK_TOOL_RESULT and block.is_error
    ]

    resumed = agent.invoke(
        Command(resume={
            interrupt.id: {"decisions": [{"type": "approve"}]}
            for interrupt in interrupts
        }), config=config,
    )
    assert not resumed.get("__interrupt__")
    after_by_uuid = dict(snapshot_cards(reducer.snapshot()))
    assert set(after_by_uuid) == set(before_by_uuid)
    for uuid, card in after_by_uuid.items():
        prior = before_by_uuid[uuid]
        assert card["tool_use_id"] == prior["tool_use_id"]
        assert card["start_ts"] == prior["start_ts"]
        assert card["status"] == "ok" and not card["awaiting_approval"]
        assert card["tokens_in"] == 20 and card["tokens_out"] == 4
        assert card["n_calls"] == 1
    assert all((ws / f"SUB{index}.done").exists() for index in range(2))


def test_same_task_card_survives_two_approval_pauses(tmp_path: Path):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    agent = create_harness(SequentialApprovalModel(), root_dir=ws, home=home)
    bus = EventBus(run_id="cards")
    reducer = MessageReducer()
    bus.subscribe(reducer.dispatch)
    config = {
        "configurable": {"thread_id": "sequential"},
        "callbacks": [ProgressHandler(bus)],
    }
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "MAIN"}]}, config=config,
    )
    uuids: list[str] = []
    token_counts: list[int] = []
    for _ in range(2):
        interrupts = result.get("__interrupt__") or ()
        assert len(interrupts) == 1
        cards = snapshot_cards(reducer.snapshot())
        assert len(cards) == 1 and cards[0][1]["awaiting_approval"]
        uuids.append(cards[0][0])
        token_counts.append(cards[0][1]["tokens_in"])
        result = agent.invoke(
            Command(resume={interrupts[0].id: {"decisions": [{"type": "approve"}]}}),
            config=config,
        )
    assert not result.get("__interrupt__")
    cards = snapshot_cards(reducer.snapshot())
    assert len(cards) == 1 and cards[0][0] == uuids[0] == uuids[1]
    assert token_counts[0] < token_counts[1] < cards[0][1]["tokens_in"]
    assert cards[0][1]["n_calls"] == 2 and cards[0][1]["status"] == "ok"
    assert all((ws / f"step-{index}.done").exists() for index in range(2))
