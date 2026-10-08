"""Footer meters and streamed tool arguments."""

from types import SimpleNamespace
from typing import ClassVar

from circle import model_catalog
from circle.ink.components.footer import FooterPane
from circle.pricing import price_call
from circle.tui.harness_bridge import HarnessBridge, format_tool_args
from circle.tui.reducer import MessageReducer
from tests.test_approvals import _session


# Prices and windows come from models.dev for the connected endpoint (circle.model_catalog);
# these tests use a small catalog of their own so models.dev's changes do not move them.
CATALOG = {"schema": model_catalog.SCHEMA, "providers": {
    "anthropic": {"api": "", "models": {"claude-sonnet-5": {
        "context": 200_000, "output": 64_000,
        "cost": {"input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_write": 3.75}}}},
}}


def _anthropic_endpoint() -> None:
    model_catalog.set_catalog(CATALOG)
    model_catalog.bind_endpoint("https://api.anthropic.com", "anthropic")


def test_footer_shows_price_effort_cache_and_context():
    _anthropic_endpoint()
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
    assert text.startswith("↑ 20.0k · ↓ 1.0k · $")
    assert "cache 25.0% · ctx 18.0k/200.0k (9%)" in text
    assert "思考" not in text


def test_context_meter_uses_latest_request_not_session_sum():
    footer = FooterPane()
    footer.update(tokens_budget=1_000_000, input_tokens=2_300_000,
                  context_input_tokens=100_000, cache_hit_tokens=460_000)
    text = footer._session_summary()
    assert "cache 20.0% · ctx 100.0k/1.0M (10%)" in text
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
    assert "cache 20.0% · ctx 20.0k/" in text
    app._footer.shutdown()


def test_footer_includes_subagents_but_context_stays_main(tmp_path, monkeypatch):
    _anthropic_endpoint()
    app = _session(tmp_path, monkeypatch)
    app._turn_base = 0
    app._footer.update(model="claude-sonnet-5")
    app._apply_usage({"input_tokens": 100, "context_input_tokens": 80,
                      "output_tokens": 10, "cache_hit": 20})
    reducer = MessageReducer()
    main_usage = {"input_tokens": 100, "output_tokens": 10,
                  "prompt_cache_hit_tokens": 20}
    fork_usage = {"input_tokens": 900, "output_tokens": 90,
                  "prompt_cache_hit_tokens": 600}
    reducer.dispatch({"kind": "llm_end", "run_id": "r", "seq": 1,
                      "payload": {"name": "usage_only", "usage_call_id": "main",
                                  "usage_cost": price_call("claude-sonnet-5", main_usage)},
                      "usage": main_usage})
    reducer.dispatch({"kind": "llm_end", "run_id": "r", "seq": 2,
                      "tags": {"parent_subagent": "general-purpose"},
                      "payload": {"name": "subagent_usage", "usage_call_id": "fork",
                                  "usage_cost": price_call("claude-sonnet-5", fork_usage)},
                      "usage": fork_usage})
    app._on_snapshot(reducer.snapshot())
    summary = app._footer._session_summary()
    assert "↑ 1.0k · ↓ 100" in summary
    # both calls are priced, in dollars: 100 in + 10 out, and 300 new + 600 cached in + 90 out
    main = (80 * 3.0 + 20 * 0.3 + 10 * 15.0) / 1_000_000
    fork = (300 * 3.0 + 600 * 0.3 + 90 * 15.0) / 1_000_000
    assert f"${main + fork:.4f}" in summary and "¥" not in summary
    assert "cache 62.0% · ctx 80/200.0k" in summary
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


class _RunningTotalModel:
    """A streaming model whose usage repeats the running total on every chunk, as some
    OpenAI-compatible gateways do."""

    @staticmethod
    def build():
        from langchain_core.language_models.chat_models import BaseChatModel
        from langchain_core.messages import AIMessageChunk
        from langchain_core.outputs import ChatGenerationChunk

        from circle.model_guard import guard_model

        class Model(BaseChatModel):
            streaming: bool = True

            @property
            def _llm_type(self) -> str:
                return "running-total"

            def bind_tools(self, tools, **kwargs):
                return self

            def _generate(self, messages, stop=None, run_manager=None, **kwargs):
                raise NotImplementedError

            def _stream(self, messages, stop=None, run_manager=None, **kwargs):
                parts = ["po", "ng", "!", ""]
                for i, text in enumerate(parts):
                    out = [0, 1, 5, 26][i]
                    chunk = ChatGenerationChunk(
                        message=AIMessageChunk(content=text, id="lc_run-1", usage_metadata={
                            "input_tokens": 3360, "output_tokens": out,
                            "total_tokens": 3360 + out,
                            "input_token_details": {"cache_read": 3200}}),
                        generation_info={"finish_reason": "stop"} if i == 3 else None)
                    yield chunk

        return guard_model(Model())


def test_footer_counts_a_running_usage_total_once(tmp_path):
    import time

    from circle.harness import create_harness

    agent = create_harness(_RunningTotalModel.build(), root_dir=tmp_path)
    updates, done, errors = [], [], []
    bridge = HarnessBridge(agent=agent, thread_id="running-total", on_update=updates.append,
                           on_interrupt=lambda _i: None, on_done=done.append,
                           on_error=errors.append)
    bridge.start("hi")
    deadline = time.monotonic() + 20
    while bridge.is_running and time.monotonic() < deadline:
        time.sleep(0.02)
    assert done == ["pong!"] and not errors
    last = [u.usage for u in updates if u.usage][-1]
    assert (last["input_tokens"], last["output_tokens"], last["cache_hit"]) == (3360, 26, 3200)
    assert last["context_input_tokens"] == 3360
    state = agent.get_state({"configurable": {"thread_id": "running-total"}})
    assert state.values["messages"][-1].usage_metadata["input_tokens"] == 3360


def test_a_nearly_full_context_turns_yellow_then_red():
    from circle.ink.theme import palette

    footer = FooterPane()
    footer.update(tokens_budget=100_000, context_input_tokens=50_000)
    assert palette().yellow not in footer._session_summary(colored=True)
    footer.update(context_input_tokens=75_000)
    assert f"{palette().yellow}ctx 75.0k/100.0k (75%)" in footer._session_summary(colored=True)
    footer.update(context_input_tokens=95_000)
    assert f"{palette().red}ctx 95.0k/100.0k (95%)" in footer._session_summary(colored=True)
    assert palette().red not in footer._session_summary(), "plain where the line is cut to fit"
