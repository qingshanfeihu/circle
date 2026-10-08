"""Compaction you can watch: the engine reports each step, the watcher hears it, the session
shows a progress row while it runs (``auto-compacting · ████░░░░ summarizing · 12s``) and one
line when it ends, automatic and /compact alike.

The window is the model's ``profile["max_input_tokens"]``. It is set from what Circle's own
system prompt and tools measure on the harness these tests build (``Sizes``), so that the
prompt plus a 6,000-token message is 90% of it: past the 85% the compaction starts at, still
inside the 95% budget, and a second message takes the conversation over (one message alone
cannot be split). The compaction keeps the last 10%, less than a 3,000-token message, which
gives /compact something older than what it keeps. Your home folder is replaced by an empty
one, so the skills and instruction files there do not change the prompt.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from circle.compaction import (
    CircleSummarization,
    CompactionProgress,
    CompactionWatcher,
    done_text,
)
from langchain_core.messages.utils import count_tokens_approximately

from circle.context_middleware import build_context_middleware, thread_config
from circle.harness import create_harness
from circle.testing import ScriptedModel

LONG = "word " * 4_800  # ~6k tokens by the approximate counter: past 85%, under the 95% budget
OLDER = "word " * 2_400  # ~3k tokens: more than the 2k the compaction keeps


@pytest.fixture(autouse=True)
def _empty_home(tmp_path, monkeypatch):
    """Skills and instruction files in your home folder would make the prompt longer."""
    home = tmp_path / "user-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))


@dataclass
class Sizes:
    overhead: int  # Circle's system prompt and tools, as the engine counts them
    window: int  # the model's window: overhead + a LONG message is 90% of it

    @property
    def threshold(self) -> int:
        return int(self.window * 0.85)


@pytest.fixture
def sizes(tmp_path, monkeypatch) -> Sizes:
    seen: list[int] = []
    room = CircleSummarization._room

    def measure(self, request):
        out = room(self, request)
        seen.append(self._approximate([]))
        return out

    monkeypatch.setattr(CircleSummarization, "_room", measure)
    probe = ScriptedModel(responses=[AIMessage(content="ok")])
    probe.profile = {"max_input_tokens": 1_000_000}
    create_harness(probe, root_dir=tmp_path, home=tmp_path).invoke(
        {"messages": [HumanMessage(content="hi")]}, config=thread_config("probe"))
    monkeypatch.setattr(CircleSummarization, "_room", room)
    overhead = seen[0]
    long_tokens = count_tokens_approximately([HumanMessage(content=LONG)])
    return Sizes(overhead=overhead, window=round((overhead + long_tokens) / 0.9))


def _model(*replies: str, window: int) -> ScriptedModel:
    model = ScriptedModel(responses=[AIMessage(content=reply) for reply in replies])
    model.profile = {"max_input_tokens": window}
    return model


def _phases(events: list[dict]) -> list[str]:
    return [e["phase"] for e in events if e["phase"] != "chunks"]


def test_the_engine_takes_deepagents_place_and_reads_the_window_from_the_profile(
        tmp_path, monkeypatch):
    from deepagents.middleware.summarization import SummarizationMiddleware

    model = _model("ok", window=20_000)
    engine, tool = build_context_middleware(model, None)
    assert isinstance(engine, CircleSummarization)
    assert engine.name == "SummarizationMiddleware", "replaces deepagents' own by name"
    assert tool._summarization is engine, "/compact runs the same engine"
    assert engine._lc_helper._trigger_clauses, "thresholds came from the profile"
    ran: list[str] = []
    original = SummarizationMiddleware.wrap_model_call

    def spy(self, request, handler):
        ran.append(type(self).__name__)
        return original(self, request, handler)

    monkeypatch.setattr(SummarizationMiddleware, "wrap_model_call", spy)
    agent = create_harness(model, root_dir=tmp_path, home=tmp_path)
    agent.invoke({"messages": [HumanMessage(content="hi")]}, config=thread_config("one"))
    assert ran == ["CircleSummarization"], "one summarization layer, and it is Circle's"


def test_auto_compaction_reports_each_step(tmp_path, sizes):
    model = _model("first", "SUMMARY OF THE EARLIER TALK", "second", window=sizes.window)
    agent = create_harness(model, root_dir=tmp_path, home=tmp_path)
    events: list[dict] = []
    cfg = {**thread_config("auto"), "callbacks": [CompactionWatcher(events.append)]}
    agent.invoke({"messages": [HumanMessage(content=LONG)]}, config=cfg)
    assert events == [], "one message cannot be split: nothing is compacted"
    out = agent.invoke({"messages": [HumanMessage(content="and now?")]}, config=cfg)
    assert out["messages"][-1].content == "second"
    assert _phases(events) == ["start", "saving", "saved", "summarizing", "summarized", "done"]
    start, done = events[0], events[-1]
    assert start["trigger"] == "auto" and start["tokens"] > sizes.threshold
    assert done["trigger"] == "auto" and done["summarized"] >= 1 and done["kept"] >= 1
    assert done["file"] and done["tokens_after"] < done["tokens_before"]
    # both counts are the whole request, as the footer's ctx: the prompt and tools too
    assert done["tokens_after"] > sizes.overhead
    text = done_text(done, automatic=True)
    assert text.startswith("auto-compacted · ~") and "history: " in text


class _Answering(ScriptedModel):
    """A model that sets ``max_tokens`` aside for its answer, as a real one does."""

    max_tokens: int = 0


def test_the_answers_reserve_can_bring_the_compaction_forward(tmp_path):
    """deepagents also compacts once a request no longer fits 95% of the window less the
    answer's max_tokens. Here that is 76,000 - 20,000 = 56,000, before 85% = 68,000: it is
    the automatic compaction, not a refused request. (A message over 50,000 tokens would be
    moved to a file instead, so the first one stays under that.)"""
    model = _Answering(responses=[AIMessage(content=reply) for reply in
                                  ("first", "SUMMARY OF THE EARLIER TALK", "second")],
                       max_tokens=20_000)
    model.profile = {"max_input_tokens": 80_000}
    agent = create_harness(model, root_dir=tmp_path, home=tmp_path)
    events: list[dict] = []
    cfg = {**thread_config("reserve"), "callbacks": [CompactionWatcher(events.append)]}
    agent.invoke({"messages": [HumanMessage(content="word " * 32_000)]}, config=cfg)  # ~40k
    assert events == [], "under 56,000"
    out = agent.invoke({"messages": [HumanMessage(content="word " * 5_600)]}, config=cfg)  # ~7k
    assert out["messages"][-1].content == "second"
    assert _phases(events) == ["start", "saving", "saved", "summarizing", "summarized", "done"]
    start = events[0]
    assert start["trigger"] == "auto" and 56_000 < start["tokens"] < 68_000
    progress = CompactionProgress()
    progress.apply(start)
    assert progress.label == "auto-compacting"


def test_compact_tool_reports_the_same_steps(tmp_path, monkeypatch, sizes):
    from deepagents.middleware.summarization import SummarizationToolMiddleware

    # deepagents lets the tool run from half the threshold on, judged by reported usage
    monkeypatch.setattr(SummarizationToolMiddleware, "_is_eligible_for_compaction",
                        lambda self, messages: True)
    model = ScriptedModel(responses=[
        AIMessage(content="first"),
        AIMessage(content="", tool_calls=[{"name": "compact_conversation", "args": {},
                                           "id": "c1"}]),
        AIMessage(content="THE SUMMARY"),
        AIMessage(content="compacted it"),
    ])
    model.profile = {"max_input_tokens": sizes.window}
    agent = create_harness(model, root_dir=tmp_path, home=tmp_path)
    events: list[dict] = []
    cfg = {**thread_config("tool"), "callbacks": [CompactionWatcher(events.append)]}
    agent.invoke({"messages": [HumanMessage(content=OLDER)]}, config=cfg)
    assert events == [], "under the threshold: no automatic compaction"
    agent.invoke({"messages": [HumanMessage(content="compact please")]}, config=cfg)
    # the tool summarizes first and saves the history after
    assert _phases(events) == ["start", "summarizing", "summarized", "saving", "saved", "done"]
    assert events[0]["trigger"] == "tool" and events[-1]["trigger"] == "tool"
    assert sizes.overhead < events[-1]["tokens_after"] < events[-1]["tokens_before"]


def test_a_failed_summary_is_reported_and_still_raises(tmp_path, sizes):
    import pytest

    class Broken(ScriptedModel):
        """Answers the conversation; every summary request (one bare prompt) fails, retries
        included."""

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if len(messages) == 1 and "summar" in str(messages[0].content).lower():
                raise RuntimeError("summary model down")
            return super()._generate(messages, stop, run_manager, **kwargs)

    model = Broken(responses=[AIMessage(content="first"), AIMessage(content="second")])
    model.profile = {"max_input_tokens": sizes.window}
    agent = create_harness(model, root_dir=tmp_path, home=tmp_path)
    events: list[dict] = []
    cfg = {**thread_config("broken"), "callbacks": [CompactionWatcher(events.append)]}
    agent.invoke({"messages": [HumanMessage(content=LONG)]}, config=cfg)
    with pytest.raises(Exception):
        agent.invoke({"messages": [HumanMessage(content="and now?")]}, config=cfg)
    assert _phases(events)[-1] == "failed"
    assert "summary model down" in events[-1]["error"]


def test_the_counts_read_like_the_footers_ctx():
    """The closing line's counts are the approximation scaled by what the provider reported
    for the last answer, so they are in the units of the footer's ctx."""
    from langchain_core.messages.utils import count_tokens_approximately

    engine, _tool = build_context_middleware(_model("x", window=20_000), None)
    talk = [HumanMessage(content="word " * 2_000), AIMessage(content="ok")]
    approximate = count_tokens_approximately(talk)
    assert engine._provider_scale(talk) == 1.0, "nothing reported: the approximation"
    talk[1] = AIMessage(content="ok", usage_metadata={
        "input_tokens": 2 * approximate - 5, "output_tokens": 5, "total_tokens": 2 * approximate})
    assert engine._provider_scale(talk) == 2.0
    assert engine._shown(talk, 2.0) == 2 * approximate


def test_the_watcher_counts_only_the_summary_and_not_too_often():
    sent: list[dict] = []
    watcher = CompactionWatcher(sent.append, every_s=0.0)
    watcher.on_chat_model_start({}, [], run_id="s", metadata={"lc_source": "summarization"})
    watcher.on_chat_model_start({}, [], run_id="m", metadata={})
    for _ in range(3):
        watcher.on_llm_new_token("x", run_id="s")
        watcher.on_llm_new_token("y", run_id="m")
    assert [e["chunks"] for e in sent] == [1, 2, 3]
    watcher.on_custom_event("circle_compaction", {"phase": "saving"})
    watcher.on_custom_event("something_else", {"phase": "saving"})
    assert sent[-1] == {"phase": "saving"} and len(sent) == 4
    slow: list[dict] = []
    throttled = CompactionWatcher(slow.append, every_s=60.0)
    throttled.on_chat_model_start({}, [], run_id="s", metadata={"lc_source": "summarization"})
    for _ in range(50):
        throttled.on_llm_new_token("x", run_id="s")
    assert len(slow) == 1, "chunk counts are sent a few times a second, not per chunk"


def test_progress_fills_by_stage_and_never_claims_a_summary_done_early():
    progress = CompactionProgress()
    progress.apply({"phase": "start", "trigger": "auto"})
    assert progress.label == "auto-compacting" and progress.stage == "starting"
    assert progress.fraction() == 0.05
    progress.apply({"phase": "saved", "file": "/h.md"})
    progress.apply({"phase": "summarizing"})
    progress.apply({"phase": "chunks", "chunks": 4000})
    assert 0.9 < progress.fraction() < 1.0, "a long summary nears the end, never reaches it"
    progress.apply({"phase": "summarized", "chars": 900})
    assert progress.fraction() == 1.0 and progress.stage == "summarized"
    # what started it is not shown, only whether it was automatic
    assert CompactionProgress(trigger="overflow").label == "auto-compacting"
    assert CompactionProgress(trigger="tool", requested=True).label == "compacting"
    assert CompactionProgress(trigger="tool").label == "compacting", "the model's own call"
    assert "summarized 1 message, kept 2" in done_text({"summarized": 1, "kept": 2})


# ── the session ──────────────────────────────────────────────────────────

def _session(tmp_path, monkeypatch):
    from tests.test_approvals import _session as make

    return make(tmp_path, monkeypatch)


def test_the_session_shows_a_row_while_it_runs_and_a_line_when_it_is_done(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._on_compaction({"phase": "start", "trigger": "auto", "messages": 40, "keep": 6,
                        "tokens": 171_000})
    app._on_compaction({"phase": "summarizing"})
    app._sync_pending(120)
    row = app._pending_text.value
    assert row.startswith(" ") and "auto-compacting · " in row
    assert "summarizing · " in row and "█" in row and "%" not in row
    app._on_compaction({"phase": "done", "trigger": "auto", "tokens_before": 171_000,
                        "tokens_after": 18_000, "summarized": 40, "kept": 6,
                        "file": "/conversation_history/s.md", "seconds": 34.0})
    assert app._compaction is None
    app._sync_pending(120)
    text = "\n".join(app._transcript.snapshot())
    assert ("auto-compacted · ~171.0k → ~18.0k tokens · summarized 40 messages, kept 6 · 34s · "
            "history: /conversation_history/s.md") in text
    app._footer.shutdown()


def test_the_bar_is_full_only_when_the_summary_is_in(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    for event in ({"phase": "start", "trigger": "auto"}, {"phase": "saved", "file": "/h.md"},
                  {"phase": "summarizing"}, {"phase": "chunks", "chunks": 5_000}):
        app._on_compaction(event)
    app._sync_pending(120)
    assert app._pending_text.value.count("█") == 15, "a long summary is near the end, not at it"
    app._on_compaction({"phase": "summarized", "chars": 900})
    app._sync_pending(120)
    assert app._pending_text.value.count("█") == 16
    app._footer.shutdown()


def _wait(app, seconds: float = 15.0) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline and (app._is_loading or app._bridge.is_running):
        time.sleep(0.05)


def test_a_compaction_inside_a_turn_leaves_its_line_under_the_turn(tmp_path, monkeypatch, sizes):
    """A turn is redrawn in place while it runs: the closing line waits for its end, so it
    never comes between the answer and the turn's usage line."""
    app = _session(tmp_path, monkeypatch)
    app.model_override = _model("first", "SUMMARY OF THE EARLIER TALK", "second",
                                window=sizes.window)
    app._rebuild_agent(model=app.model_override)
    app._on_submit(LONG)
    _wait(app)
    app._on_submit("and now?")
    _wait(app)
    lines = app._transcript.snapshot()
    answer = max(i for i, line in enumerate(lines) if "second" in line)
    usage = next(i for i in range(answer, len(lines)) if "↑" in lines[i])
    closing = max(i for i, line in enumerate(lines) if "auto-compacted · ~" in line)
    assert answer < usage < closing
    assert app._held_notes == []
    app._footer.shutdown()


def test_a_failed_compaction_leaves_a_red_line(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._on_compaction({"phase": "start", "trigger": "auto"})
    app._on_compaction({"phase": "failed", "error": "RuntimeError: summary model down"})
    assert app._compaction is None
    text = "\n".join(app._transcript.snapshot())
    assert "Compaction failed: RuntimeError: summary model down" in text
    app._footer.shutdown()


def test_compact_shows_the_row_at_once_and_one_closing_line(tmp_path, monkeypatch, sizes):
    from deepagents.middleware.summarization import SummarizationToolMiddleware

    monkeypatch.setattr(SummarizationToolMiddleware, "_is_eligible_for_compaction",
                        lambda self, messages: True)
    app = _session(tmp_path, monkeypatch)
    app.model_override = ScriptedModel(responses=[
        AIMessage(content="", tool_calls=[{"name": "compact_conversation", "args": {},
                                           "id": "c1"}]),
        AIMessage(content="THE SUMMARY"),
        AIMessage(content="Compacted."),
    ])
    app.model_override.profile = {"max_input_tokens": sizes.window}
    app._rebuild_agent(model=app.model_override)
    app._agent.update_state(thread_config(app._thread_id), {"messages": [
        HumanMessage(content=OLDER), AIMessage(content="b"), HumanMessage(content="c"),
        AIMessage(content="d")]})
    app._on_submit("/compact")
    assert app._compaction is not None and app._compaction.label == "compacting"
    deadline = time.time() + 10
    while time.time() < deadline and (app._compaction is not None or app._is_loading):
        time.sleep(0.05)
    text = "\n".join(app._transcript.snapshot())
    assert text.count("compacted · ~") == 1 and "auto-compacted" not in text
    assert "— compacted ·" not in text, "the engine's line replaces the old one, no repeat"
    app._footer.shutdown()


def test_compact_bills_its_calls_in_the_footer(tmp_path, monkeypatch):
    """/compact runs outside the turns, so no snapshot brings its usage: its calls (the
    request, the summary, the answer) still count in ↑ ↓ and the cost, as a summary does."""
    from deepagents.middleware.summarization import SummarizationToolMiddleware

    from circle import model_catalog

    monkeypatch.setattr(SummarizationToolMiddleware, "_is_eligible_for_compaction",
                        lambda self, messages: True)
    app = _session(tmp_path, monkeypatch)
    used = {"usage_metadata": {"input_tokens": 1_000, "output_tokens": 100, "total_tokens": 1_100},
            "response_metadata": {"model_name": "claude-sonnet-5"}}
    app.model_override = ScriptedModel(responses=[
        AIMessage(content="", tool_calls=[{"name": "compact_conversation", "args": {},
                                           "id": "c1"}], **used),
        AIMessage(content="THE SUMMARY", **used),
        AIMessage(content="Compacted.", **used),
    ])
    app.model_override.profile = {"max_input_tokens": 20_000}
    app._rebuild_agent(model=app.model_override)
    model_catalog.set_catalog({"schema": model_catalog.SCHEMA, "providers": {"anthropic": {
        "api": "", "models": {"claude-sonnet-5": {"context": 200_000,
                                                   "cost": {"input": 3.0, "output": 15.0}}}}}})
    model_catalog.bind_endpoint("", "anthropic")
    app._agent.update_state(thread_config(app._thread_id), {"messages": [
        HumanMessage(content=OLDER), AIMessage(content="b"), HumanMessage(content="c"),
        AIMessage(content="d")]})
    app._on_submit("/compact")
    _wait(app)
    assert (app._footer.fork_input, app._footer.fork_output) == (3_000, 300)
    # each call 1,000 in at $3 and 100 out at $15 per million
    assert "$0.0135" in app._footer._session_summary()
    app._footer.shutdown()


def test_the_row_takes_its_colours_from_the_palette_at_each_repaint(tmp_path, monkeypatch):
    """The row is rebuilt on every repaint, so /themes (or the terminal turning light under the
    auto theme) recolours a compaction that is already under way."""
    from circle.ink import theme

    monkeypatch.delenv("COLORFGBG", raising=False)
    monkeypatch.setattr(theme, "query_terminal_palette", lambda timeout=0.25: None)
    saved = theme._detected  # noqa: SLF001
    try:
        theme._detected = None  # noqa: SLF001
        theme.reset_palette()
        app = _session(tmp_path, monkeypatch)
        app._on_compaction({"phase": "start", "trigger": "auto", "threshold": "85%"})
        rows = {}
        for name in ("dark", "light"):
            app._on_submit(f"/themes {name}")
            app._sync_pending(120)
            pal = theme.palette()
            rows[name] = row = app._pending_text.value
            assert pal.faint in row and pal.text in row, name
        assert rows["dark"] != rows["light"]
        app._footer.shutdown()
    finally:
        theme._detected = saved  # noqa: SLF001
        theme.reset_palette()


def test_esc_takes_an_automatic_compactions_row_down_without_a_red_line(tmp_path, monkeypatch):
    """Stopping the turn stops its compaction: the row goes at once, and the cancellation the
    engine then reports is not a failure (the stop line says what happened)."""
    app = _session(tmp_path, monkeypatch)
    app._on_compaction({"phase": "start", "trigger": "auto", "messages": 40, "keep": 6,
                        "tokens": 171_000})
    assert app._compaction is not None
    app._dismiss_user_panels()
    assert app._compaction is None
    app._on_compaction({"phase": "summarizing"})
    app._on_compaction({"phase": "failed", "error": "CircleCancelled: Circle turn cancelled"})
    text = "\n".join(app._transcript.snapshot())
    assert "Compaction failed" not in text and app._compaction is None
    app._footer.shutdown()


def test_a_turn_error_is_called_a_compaction_failure_only_when_it_is_one(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app._held_notes = [("fail", "Compaction failed: RuntimeError: summary model down")]
    app._on_error(TimeoutError("the endpoint did not answer in 45s"))
    text = "\n".join(app._transcript.snapshot())
    assert "Compaction failed: RuntimeError: summary model down" in text
    assert "Compaction failed: TimeoutError" not in text and "did not answer" in text
    app._held_notes = [("fail", "Compaction failed: RuntimeError: summary model down")]
    app._on_error(RuntimeError("summary model down"))
    last = app._transcript.snapshot()[-1]
    assert "Compaction failed:" in last and "summary model down" in last
    app._footer.shutdown()
