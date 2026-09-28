"""Footer meters and streamed tool arguments."""

from types import SimpleNamespace
from typing import ClassVar

from circle.ink.components.footer import FooterPane
from circle.tui.harness_bridge import HarnessBridge, format_tool_args
from tests.test_approvals import _session


def test_footer_shows_price_effort_cache_and_context():
    footer = FooterPane()
    footer.update(
        model="claude-sonnet-5",
        input_tokens=20_000,
        context_input_tokens=18_000,
        output_tokens=1_000,
        cache_hit_tokens=5_000,
        reasoning_effort="high",
        reasoning_tokens=800,
    )
    text = footer._session_summary()
    assert text.startswith("↑ 20.0k · ↓ 1.0k tokens · claude-sonnet-5 (high) · $")
    assert "CH25.0% CTX 18.0k/200.0k (9%)" in text
    assert "思考" not in text


def test_context_meter_uses_latest_request_not_session_sum():
    footer = FooterPane()
    footer.update(tokens_budget=1_000_000, input_tokens=2_300_000,
                  context_input_tokens=100_000, cache_hit_tokens=460_000)
    text = footer._session_summary()
    assert "CH20.0% CTX 100.0k/1.0M (10%)" in text
    assert "230%" not in text


def test_bridge_latest_input_includes_anthropic_cache_usage():
    bridge = HarnessBridge.__new__(HarnessBridge)
    bridge._usage_by_id = {}
    sdk = SimpleNamespace(id="first", usage_metadata=None, response_metadata={"usage": {
        "input_tokens": 20, "cache_read_input_tokens": 60,
        "cache_creation_input_tokens": 20, "output_tokens": 5,
    }})
    first = bridge._note_usage(sdk)
    assert first["context_input_tokens"] == 100
    standard = SimpleNamespace(id="second", usage_metadata={
        "input_tokens": 300, "output_tokens": 10, "total_tokens": 310,
        "input_token_details": {"cache_read": 200, "cache_creation": 50},
    }, response_metadata={})
    second = bridge._note_usage(standard)
    assert second["context_input_tokens"] == 300
    assert second["input_tokens"] == 320, "session sum remains separate"


def test_session_passes_latest_context_input_to_footer(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._apply_usage({"input_tokens": 500_000, "context_input_tokens": 20_000,
                      "output_tokens": 100, "cache_hit": 100_000})
    text = app._footer._session_summary()
    assert "CH20.0% CTX 20.0k/" in text
    app._footer.shutdown()


def test_streamed_tool_args_replace_empty_object():
    bridge = HarnessBridge.__new__(HarnessBridge)
    bridge._tool_acc = {}

    class First:
        tool_calls: ClassVar[list] = []
        tool_call_chunks: ClassVar[list[dict]] = [
            {"id": "call-1", "name": "execute", "args": "", "index": 0},
        ]

    first = bridge._absorb_tool_calls(First())
    assert first[0]["name"] == "execute"
    assert format_tool_args(first[0]["args"]) == ""

    class More:
        tool_calls: ClassVar[list] = []
        tool_call_chunks: ClassVar[list[dict]] = [
            {"id": "call-1", "args": '{"command":', "index": 0},
        ]

    class Rest:
        tool_calls: ClassVar[list] = []
        tool_call_chunks: ClassVar[list[dict]] = [
            {"id": "call-1", "args": '"pwd"}', "index": 0},
        ]

    bridge._absorb_tool_calls(More())
    done = bridge._absorb_tool_calls(Rest())
    assert done[0]["args"] == {"command": "pwd"}
    assert format_tool_args(done[0]["args"]) == '{"command":"pwd"}'
