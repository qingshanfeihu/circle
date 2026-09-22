"""Stream/thinking content-block parsing (InfoTest-compatible)."""

from circle.tui.content_blocks import (
    assistant_block,
    message_text,
    parse_content,
    thinking_preview,
)


def test_parse_splits_thinking_and_text():
    content = [
        {"type": "thinking", "thinking": "line one\nline two"},
        {"type": "text", "text": "Hi there"},
    ]
    parsed = parse_content(content)
    assert parsed.text == "Hi there"
    assert "line two" in parsed.thinking
    assert message_text(content) == "Hi there"
    assert thinking_preview(content) == "line two"


def test_assistant_block_indents():
    out = assistant_block("hello\nworld")
    assert out.startswith(" ⏺ hello") or "hello" in out.split("\n")[0]
    assert "world" in out
