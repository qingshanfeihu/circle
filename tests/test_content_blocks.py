"""Stream/thinking content-block parsing (InfoTest-compatible)."""

import re

from circle.ink import theme
from circle.ink.components.markdown_renderer import MarkdownRenderer
from circle.ink.theme import palette
from circle.tui.content_blocks import (
    assistant_block,
    message_text,
    parse_content,
    render_thinking_line,
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


def test_expanded_main_thinking_stays_faint_after_markdown_styles():
    rendered = render_thinking_line(
        body="First I check **config**.\nThen I edit the file.",
        done=True,
        expanded=True,
    )
    faint_params = palette().faint[2:-1]
    for word in ("First", "config", ".\n", "Then"):
        before = rendered[:rendered.index(word)]
        active = re.findall(r"\x1b\[[0-9;]*m", before)[-1]
        assert active.endswith(f"{faint_params}m"), (word, active)


def test_main_thinking_redraw_reuses_render_for_same_width_and_body(monkeypatch):
    calls: list[str] = []
    original = MarkdownRenderer.render_streaming

    def counted(self, body):
        calls.append(body)
        return original(self, body)

    monkeypatch.setattr(MarkdownRenderer, "render_streaming", counted)
    body = "cache main reasoning **config** 42"
    for _ in range(3):
        render_thinking_line(body=body, done=True, expanded=True, width=70)
    assert calls == [body]
    render_thinking_line(body=body, done=True, expanded=True, width=71)
    render_thinking_line(body=body + " changed", done=True, expanded=True, width=70)
    assert calls == [body, body, body + " changed"]

    previous = palette()
    try:
        theme.set_palette(theme.build_palette("#f7f8fa", "#202428"))
        render_thinking_line(body=body, done=True, expanded=True, width=70)
        assert calls[-1] == body and len(calls) == 4
    finally:
        theme.set_palette(previous)
