"""What the bridge hands over as the turn's answer, and what it leaves out."""

from __future__ import annotations

import time
from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage

from circle.context_middleware import thread_config
from circle.harness import create_harness
from circle.paths import project_data_dir
from circle.testing import ScriptedModel
from circle.tui.harness_bridge import NO_OUTPUT, HarnessBridge


def _compacting_model(final: str) -> ScriptedModel:
    """Calls compact_conversation with a context big enough for it, writes the summary
    when the compaction asks, then gives ``final`` as its answer."""
    call = AIMessage(
        content="",
        tool_calls=[{"name": "compact_conversation", "args": {}, "id": "c1", "type": "tool_call"}],
        usage_metadata={"input_tokens": 120_000, "output_tokens": 5, "total_tokens": 120_005},
        response_metadata={"model_provider": "scriptedmodel"},
    )
    return ScriptedModel(responses=[call, AIMessage(content="SUMMARY OF EARLIER WORK"),
                                    AIMessage(content=final)])


def _run(tmp_path: Path, model: ScriptedModel):
    ws, home = tmp_path / "ws", tmp_path / "home"
    ws.mkdir()
    agent = create_harness(model, root_dir=ws, home=home)
    history = []
    for i in range(12):
        history += [HumanMessage(content=f"question {i} " + "word " * 100),
                    AIMessage(content=f"answer {i} " + "word " * 100)]
    agent.update_state(thread_config("t"), {"messages": history})
    updates, done, errors, snaps = [], [], [], []
    bridge = HarnessBridge(agent=agent, thread_id="t", on_update=updates.append,
                           on_interrupt=lambda _i: None, on_done=done.append,
                           on_error=errors.append, on_snapshot=snaps.append)
    bridge.start("please compact")
    deadline = time.monotonic() + 20
    while bridge.is_running and time.monotonic() < deadline:
        time.sleep(0.02)
    assert not errors
    return ws, home, updates, done, snaps


def test_a_summary_written_during_the_turn_is_not_the_answer(tmp_path: Path):
    """The summary call's text never reaches the screen, even when the model then says
    nothing: the turn ends with no answer instead of the summary as one."""
    ws, home, updates, done, snaps = _run(tmp_path, _compacting_model(final=""))
    assert done == [NO_OUTPUT]
    assert not any("SUMMARY" in (u.text or "") for u in updates)
    shown = [block.text for snap in snaps for message in snap.messages
             for block in message.content]
    assert not any("SUMMARY" in text for text in shown)
    # and the summarized messages went to the data folder, not into the project
    assert list(ws.iterdir()) == []
    kept = project_data_dir(ws, home) / "conversation_history"
    assert [p.suffix for p in kept.iterdir()] == [".md"]


def test_the_answer_is_the_last_model_message(tmp_path: Path):
    _ws, _home, _updates, done, _snaps = _run(tmp_path, _compacting_model(final="carrying on"))
    assert done == ["carrying on"]
