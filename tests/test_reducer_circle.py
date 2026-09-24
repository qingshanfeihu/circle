"""Reducer behavior circle relies on beyond the ported InfoTest cases: tool status and
the recoverable flag reach the snapshot, empty errors get readable text, cancelling
settles in-flight tools and running subagent cards, and the sink posts snapshots."""

from __future__ import annotations

from circle.display_lexicon import ERROR_WITHOUT_TEXT, tool_result_is_error, tool_result_recoverable
from circle.events import EventBus
from circle.tui.message_model import (
    BLOCK_AGENT_CARD,
    BLOCK_ERROR,
    BLOCK_TOOL_RESULT,
    BLOCK_TOOL_USE,
    BLOCK_WARN,
)
from circle.tui.reducer import MessageReducer
from circle.tui.sink import TuiSink


def _blocks(snap, kind):
    return [b for m in snap.messages for b in m.content if b.type == kind]


def _call(r, seq, name="read_file", run_id="lc1"):
    r.dispatch({"kind": "tool_call", "run_id": "r", "seq": seq, "ts": "",
                "tags": {"name": name, "lc_tool_run_id": run_id}, "payload": {"input": {"x": 1}}})


def _result(r, seq, output, *, status="", recoverable=False, run_id="lc1", name="read_file"):
    payload = {"output": output}
    if status:
        payload["status"] = status
    if recoverable:
        payload["recoverable"] = True
    r.dispatch({"kind": "tool_result", "run_id": "r", "seq": seq, "ts": "",
                "tags": {"name": name, "lc_tool_run_id": run_id}, "payload": payload})


def test_status_decides_errors_not_the_words_in_the_output():
    r = MessageReducer()
    _call(r, 1)
    _result(r, 2, "The user rejected this tool call.", status="error")
    _call(r, 3, run_id="lc2")
    _result(r, 4, "grep found: error handling in parser.py", run_id="lc2")
    results = _blocks(r.snapshot(), BLOCK_TOOL_RESULT)
    assert [b.is_error for b in results] == [True, False]
    assert results[0].payload["status"] == "error"


def test_recoverable_flag_reaches_the_snapshot():
    r = MessageReducer()
    _call(r, 1)
    _result(r, 2, "Tool call 'read_file' was not run: invalid arguments", status="error",
            recoverable=True)
    block = _blocks(r.snapshot(), BLOCK_TOOL_RESULT)[0]
    assert block.is_error and tool_result_recoverable(block.payload)


def test_error_marker_without_status_still_counts():
    assert tool_result_is_error("Error: file not found")
    assert tool_result_is_error("✖ failed")
    assert not tool_result_is_error("no errors found")


def test_errors_and_warnings_become_blocks():
    r = MessageReducer()
    r.dispatch({"kind": "error", "run_id": "r", "seq": 1, "payload": {"error": "  "}})
    r.dispatch({"kind": "warn", "run_id": "r", "seq": 2, "payload": {"text": "slow endpoint"}})
    snap = r.snapshot()
    assert _blocks(snap, BLOCK_ERROR)[0].payload["text"] == ERROR_WITHOUT_TEXT
    assert _blocks(snap, BLOCK_WARN)[0].payload["text"] == "slow endpoint"


def test_cancel_settles_running_tools_and_subagent_cards():
    r = MessageReducer()
    _call(r, 1)
    with r._lock:  # noqa: SLF001
        r._upsert_card("agent:x", {"kind": "subagent", "status": "running"})  # noqa: SLF001
    r.cancel_run(reason="ctrl+c")
    snap = r.snapshot()
    assert snap.status == "cancelled"
    assert _blocks(snap, BLOCK_TOOL_USE)[0].status == "error"
    card = _blocks(snap, BLOCK_AGENT_CARD)[0]
    assert card.payload["status"] == "error" and card.payload["termination_cause"] == "CANCELLED"
    r.dispatch({"kind": "tool_call", "run_id": "r", "seq": 9, "tags": {"name": "ls"}})
    assert len(r.snapshot().messages) == len(snap.messages), "nothing lands after cancel"


def test_card_transcript_upsert_replaces_by_key():
    r = MessageReducer()
    with r._lock:  # noqa: SLF001
        r._upsert_card("agent:y", {"_transcript_append": {"key": "t1", "tool": "ls"}})  # noqa: SLF001
        r._upsert_card("agent:y", {"_transcript_upsert": {"key": "t1", "status": "ok"}})  # noqa: SLF001
        r._upsert_card("agent:y", {"_transcript_upsert": {"key": "t2", "tool": "grep"}})  # noqa: SLF001
    card = _blocks(r.snapshot(), BLOCK_AGENT_CARD)[0]
    assert card.payload["transcript"] == [{"key": "t1", "tool": "ls", "status": "ok"},
                                          {"key": "t2", "tool": "grep"}]


def test_sink_posts_a_snapshot_per_event():
    posted = []
    sink = TuiSink(post=posted.append)
    bus = EventBus(run_id="run-1")
    bus.subscribe(sink)
    bus.emit("run_start")
    bus.emit("llm_token", payload={"content": "hello"})
    bus.emit("run_end", payload={"awaiting_user": True})
    assert [s.status for s in posted] == ["running", "running", "done"]
    assert posted[1].streaming_text == "hello"
    assert posted[-1].run_end_info["awaiting_user"] is True
    assert posted[-1].source_run_id == "run-1"
