"""Message model: block factories and frozen types.

Ported from InfoTest ``tests/tui/test_message_model.py``."""

from __future__ import annotations

from circle.tui.message_model import (
    BLOCK_TEXT,
    BLOCK_TOOL_RESULT,
    BLOCK_TOOL_USE,
    MessageSnapshot,
    append_content_block,
    make_assistant_message,
    make_payload_block,
    make_text_block,
    make_tool_result_block,
    make_tool_use_block,
    make_user_message,
    make_uuid,
    replace_content_block,
)

def test_message_uuid_format():
    assert make_uuid("run-123", 5) == "run-123:5"


def test_message_is_frozen():
    msg = make_assistant_message(uuid="r:1", content=make_text_block("hi"))
    try:
        msg.uuid = "tampered"  # type: ignore[misc]
    except Exception as exc:
        assert "frozen" in str(exc).lower() or "cannot assign" in str(exc).lower()
    else:
        raise AssertionError("Message should be frozen")


def test_text_block_factory():
    b = make_text_block("hello world")
    assert b.type == BLOCK_TEXT
    assert b.text == "hello world"


def test_tool_use_block_factory_default_running():
    b = make_tool_use_block(tool_use_id="tu-1", name="qa_grep", input={"pattern": "foo"})
    assert b.type == BLOCK_TOOL_USE
    assert b.tool_use_id == "tu-1"
    assert b.name == "qa_grep"
    assert dict(b.input) == {"pattern": "foo"}
    assert b.status == "running"


def test_tool_result_block_factory():
    b = make_tool_result_block(tool_use_id="tu-1", output="hit\nline")
    assert b.type == BLOCK_TOOL_RESULT
    assert b.tool_use_id == "tu-1"
    assert b.output == "hit\nline"


def test_replace_content_block_returns_new_message():
    msg = make_assistant_message(
        uuid="r:1",
        content=[make_text_block("first"), make_tool_use_block(tool_use_id="tu-1", name="x")],
    )
    new_block = make_tool_use_block(tool_use_id="tu-1", name="x", status="done")
    new_msg = replace_content_block(
        msg,
        predicate=lambda b: b.type == BLOCK_TOOL_USE and b.tool_use_id == "tu-1",
        new_block=new_block,
    )
    
    assert msg.content[1].status == "running"
    assert new_msg.content[1].status == "done"
    
    assert new_msg.content[0].text == "first"
    
    assert new_msg.uuid == msg.uuid


def test_append_content_block():
    msg = make_user_message(uuid="r:2", content=make_text_block("a"))
    new_msg = append_content_block(msg, make_text_block("b"))
    assert len(msg.content) == 1
    assert len(new_msg.content) == 2
    assert new_msg.content[1].text == "b"


def test_message_snapshot_default_status_idle():
    snap = MessageSnapshot(messages=())
    assert snap.status == "idle"
    assert snap.streaming_text is None
    assert snap.usage == {}
    assert snap.messages == ()


def test_payload_block_preserves_dict():
    b = make_payload_block("evidence", {"k": "v", "n": 1})
    assert b.type == "evidence"
    assert dict(b.payload) == {"k": "v", "n": 1}
