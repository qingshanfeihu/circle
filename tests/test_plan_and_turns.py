"""write_todos is bound and shown in the plan panel; each user turn ends with one
``✻ Cooked`` line; ctrl+o / ctrl+t / /thinking redraw every turn in place; the busy
word carries this run's tokens."""

from __future__ import annotations

import re
import time
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from circle.events import EventBus
from circle.ink import theme
from circle.ink.components.plan_panel import MAX_ITEMS, plan_lines, plan_window
from circle.ink.parse_keypress import KeyPress
from circle.testing import ScriptedModel
from circle.tui.sink import TuiSink

ANSI = re.compile(r"\x1b\[[0-9;]*m")


@pytest.fixture(autouse=True)
def _palette():
    theme.reset_palette()
    theme.set_palette(theme.build_palette("#d6dee6", "#10151a"))
    yield
    theme.reset_palette()


def plain(text: str) -> str:
    return ANSI.sub("", text)


def _call(name, args, call_id):
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id,
                                              "type": "tool_call"}])


# ── the harness binds write_todos ──────────────────────────────────────────


def test_write_todos_is_bound_with_circles_description_and_updates_state(tmp_path):
    from circle.harness import create_harness

    todos = [{"content": "read the code", "status": "completed"},
             {"content": "fix the bug", "status": "in_progress"}]
    agent = create_harness(ScriptedModel(responses=[_call("write_todos", {"todos": todos}, "t1"),
                                                    AIMessage(content="ok")]),
                           root_dir=tmp_path, home=tmp_path / "home")
    tool = agent.nodes["tools"].bound.tools_by_name["write_todos"]
    assert "only values the tool accepts" in tool.description
    out = agent.invoke({"messages": [{"role": "user", "content": "go"}]},
                       config={"configurable": {"thread_id": "t"}})
    assert out["todos"] == todos


def test_a_codex_model_gets_one_todo_middleware_not_two(tmp_path):
    from langchain_openai import ChatOpenAI

    from circle.harness import create_harness

    model = ChatOpenAI(model="gpt-5.1-codex", api_key="test", base_url="http://127.0.0.1:9")
    agent = create_harness(model, root_dir=tmp_path, home=tmp_path / "home")
    assert "write_todos" in agent.nodes["tools"].bound.tools_by_name


# ── plan panel ─────────────────────────────────────────────────────────────


def test_plan_lines_show_real_status_and_count_done():
    lines = [plain(ln) for ln in plan_lines([
        {"content": "a", "status": "completed"},
        {"content": "b", "status": "in_progress"},
        {"content": "c", "status": "pending"}], width=60)]
    assert lines[0] == f" {theme.GLYPH_AGENT} Plan · 1/3 完成"
    assert lines[1:] == ["   ● a", "   ◉ b", "   ○ c"]


def test_long_plans_show_a_window_around_the_first_open_item():
    todos = [{"content": f"step {i}", "status": "completed" if i < 12 else "pending"}
             for i in range(20)]
    assert plan_window(todos) == (10, 10 + MAX_ITEMS)
    lines = [plain(ln) for ln in plan_lines(todos, width=60)]
    assert lines[1] == "   … 上面还有 10 项" and lines[2] == "   ● step 10"
    assert not any("下面还有" in ln for ln in lines)
    assert sum(1 for ln in lines if ln.startswith(("   ●", "   ○"))) == MAX_ITEMS
    todos[3]["status"] = "pending"
    lines = [plain(ln) for ln in plan_lines(todos, width=60)]
    assert lines[1] == "   … 上面还有 1 项" and lines[-1] == "   … 下面还有 9 项"


def test_plan_items_are_cut_to_the_width():
    lines = [plain(ln) for ln in plan_lines([{"content": "x" * 300, "status": "pending"}],
                                            width=50)]
    assert len(lines[1]) <= 50 and lines[1].endswith("…")


# ── the session ────────────────────────────────────────────────────────────


def _fake_session(tmp_path: Path, monkeypatch):
    from circle.settings import CircleSettings, ModelAuth, save_settings
    from circle.tui.session_app import CircleSessionApp

    home, ws = tmp_path / "home", tmp_path / "ws"
    home.mkdir()
    ws.mkdir()
    settings = CircleSettings(initialized=True, trusted_folders=[str(ws)], auth=ModelAuth(
        mode="api_key", protocol="openai", base_url="http://127.0.0.1:9", model="test-model"))
    save_settings(settings, home=home)
    monkeypatch.setenv("CIRCLE_HOME", str(home))

    class _FakeAgent:
        def stream(self, *a, **k):
            return iter(())

    monkeypatch.setattr("circle.tui.session_app.create_harness", lambda *a, **k: _FakeAgent())
    monkeypatch.setattr("circle.tui.session_app.build_chat_model", lambda *a, **k: object())
    return CircleSessionApp(settings, ws, home=home)


def _turn(app, events: list[tuple[str, dict]]):
    """Open a turn region, feed events through a real reducer, close it like _on_done."""
    posted = []
    bus = EventBus(run_id=f"r{time.monotonic_ns()}")
    bus.subscribe(TuiSink(post=posted.append))
    app._transcript.append_message(" > question")  # noqa: SLF001
    app._open_turn_region()  # noqa: SLF001
    bus.emit("run_start")
    for kind, payload in events:
        bus.emit(kind, payload=payload)
    bus.emit("run_end")
    app._on_snapshot(posted[-1])  # noqa: SLF001
    app._render_turn_region()  # noqa: SLF001
    app._close_turn_region()  # noqa: SLF001
    app._transcript.append_message("  ✻ Cooked")  # noqa: SLF001 — a line between turns


def test_todo_updates_reach_the_panel_and_stay_as_the_model_left_them(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    todos = [{"content": "first", "status": "completed"},
             {"content": "second", "status": "pending"}]
    _turn(app, [("todo_list", {"todos": todos})])
    assert app._plan_panel.is_visible and app._plan_panel.todos == todos  # noqa: SLF001
    text = plain(getattr(app._plan_panel._text, "value", ""))  # noqa: SLF001
    assert "● first" in text and "○ second" in text, "an unfinished item is not drawn as done"
    app._cmd_new("")  # noqa: SLF001
    assert not app._plan_panel.is_visible  # noqa: SLF001


def test_replay_redraws_every_turn_and_shifts_the_ones_after(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    thought = {"name": "thinking_block", "thinking": "hidden plan", "reasoning_duration_s": 1.0}
    _turn(app, [("info", thought), ("llm_end", {"name": "final_thought", "content": "answer one"})])
    _turn(app, [("info", thought), ("llm_end", {"name": "final_thought", "content": "answer two"})])
    before = plain("\n".join(app._transcript.snapshot()))  # noqa: SLF001
    assert before.count("∴ Thought") == 2
    app._cmd_thinking("")  # noqa: SLF001 — hide thinking: each turn loses entries
    hidden = [plain(x) for x in app._transcript.snapshot()]  # noqa: SLF001
    assert not any("∴" in ln for ln in hidden)
    assert [ln for ln in hidden if "answer" in ln or "Cooked" in ln or "question" in ln] == [
        " > question", " ⏺ answer one", "  ✻ Cooked", " > question", " ⏺ answer two", "  ✻ Cooked"]
    app._cmd_thinking("")  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+t", ctrl=True, char="t"))  # noqa: SLF001
    shown = plain("\n".join(app._transcript.snapshot()))  # noqa: SLF001
    assert shown.count("hidden plan") == 2 and shown.count("answer two") == 1
    assert shown.index("answer one") < shown.index("answer two")


def test_clone_forgets_old_turn_positions(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    _turn(app, [("llm_end", {"name": "final_thought", "content": "one"})])
    assert app._turns  # noqa: SLF001
    app._cmd_clone("")  # noqa: SLF001
    assert app._turns == []  # noqa: SLF001


def _real_session(tmp_path: Path, monkeypatch, responses: list):
    from tests.test_progress_handler import _session

    return _session(tmp_path, monkeypatch, responses)


def _wait(app):
    from tests.test_progress_handler import _wait_idle

    _wait_idle(app)


def test_one_cooked_line_per_turn_even_across_an_approval(tmp_path, monkeypatch):
    app = _real_session(tmp_path, monkeypatch, [
        _call("write_file", {"file_path": "/out.txt", "content": "x"}, "c1"),
        AIMessage(content="done"),
    ])
    original = app._bridge.resume  # noqa: SLF001

    def reject(_value):
        original({"decisions": [{"type": "reject", "message": "The user rejected this tool call."}]})

    app._on_submit("write it")  # noqa: SLF001
    _wait(app)
    assert app._exec_approval is not None  # noqa: SLF001
    assert "Cooked" not in plain("\n".join(app._transcript.snapshot()))  # noqa: SLF001
    # the clock is stopped while the approval panel waits for the user
    assert app._turn_started_at == 0.0 and app._turn_elapsed > 0  # noqa: SLF001
    app._bridge.resume = reject  # noqa: SLF001
    app._finish_exec_approval({"decision": "reject"})  # noqa: SLF001
    _wait(app)
    lines = [plain(ln) for ln in app._transcript.snapshot()]  # noqa: SLF001
    cooked = [ln for ln in lines if "✻ Cooked for" in ln]
    assert len(cooked) == 1 and cooked[0].endswith("tokens")
    assert lines.index(cooked[0]) > next(i for i, ln in enumerate(lines) if "done" in ln)
    assert not any("模型没有返回任何内容" in ln for ln in lines), "the model did answer"


def test_a_turn_with_nothing_from_the_model_says_so(tmp_path, monkeypatch):
    app = _real_session(tmp_path, monkeypatch, [AIMessage(content="")])
    app._on_submit("hello")  # noqa: SLF001
    _wait(app)
    text = plain("\n".join(app._transcript.snapshot()))  # noqa: SLF001
    assert "✻ Cooked for" in text and "模型没有返回任何内容（0 token）" in text


# ── the busy word ──────────────────────────────────────────────────────────


def test_busy_word_carries_this_runs_tokens():
    from circle.ink.components.footer import FooterPane

    captured: list[str] = []
    footer = FooterPane(thinking_text_cb=captured.append)
    footer.update(input_tokens=5000, output_tokens=100)
    footer._start_timer()  # noqa: SLF001
    try:
        footer.update(input_tokens=6200, output_tokens=400, status="running", llm_phase="")
        footer._refresh()  # noqa: SLF001
        label = captured[-1]
        assert "↑ 1.2k · ↓ 300 tokens" in label and label.split("…")[0] == footer._verb  # noqa: SLF001
        footer.update(llm_phase="output", output_token_count=40)
        footer._refresh()  # noqa: SLF001
        assert "↓ 300(+40) tokens" in captured[-1] and captured[-1].endswith("生成回答中")
    finally:
        footer.shutdown()
