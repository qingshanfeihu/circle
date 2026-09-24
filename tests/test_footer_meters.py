"""Footer meters and streamed tool arguments."""

from circle.ink.components.footer import FooterPane
from circle.tui.harness_bridge import HarnessBridge, format_tool_args


def test_footer_shows_price_effort_cache_and_context():
    footer = FooterPane()
    footer.update(
        model="claude-sonnet-5",
        input_tokens=20_000,
        output_tokens=1_000,
        cache_hit_tokens=5_000,
        reasoning_effort="high",
        reasoning_tokens=800,
    )
    text = footer._session_summary()
    assert text.startswith("↑ 20.0k · ↓ 1.0k tokens · claude-sonnet-5 (high) · $")
    assert "CH25.0% CTX 20.0k/200.0 (10%)" in text
    assert "思考" not in text


def test_streamed_tool_args_replace_empty_object():
    bridge = HarnessBridge.__new__(HarnessBridge)
    bridge._tool_acc = {}

    class First:
        tool_calls = []
        tool_call_chunks = [{"id": "call-1", "name": "execute", "args": "", "index": 0}]

    first = bridge._absorb_tool_calls(First())
    assert first[0]["name"] == "execute"
    assert format_tool_args(first[0]["args"]) == ""

    class More:
        tool_calls = []
        tool_call_chunks = [
            {"id": "call-1", "args": '{"command":', "index": 0},
        ]

    class Rest:
        tool_calls = []
        tool_call_chunks = [
            {"id": "call-1", "args": '"pwd"}', "index": 0},
        ]

    bridge._absorb_tool_calls(More())
    done = bridge._absorb_tool_calls(Rest())
    assert done[0]["args"] == {"command": "pwd"}
    assert format_tool_args(done[0]["args"]) == '{"command":"pwd"}'
