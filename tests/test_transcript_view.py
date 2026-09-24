"""Snapshot → transcript entries: one tool-row form for every outcome, results under
``⎿``, muted recoverable errors, pending approvals, thinking title and duration."""

from __future__ import annotations

import re

import pytest

from circle.ink import theme
from circle.tui.message_model import (
    MessageSnapshot,
    make_assistant_message,
    make_payload_block,
    make_system_message,
    make_text_block,
    make_thinking_block,
    make_tool_result_block,
    make_tool_use_block,
    make_user_message,
)
from circle.tui.transcript_view import ViewOptions, final_text, render_turn

ANSI = re.compile(r"\x1b\[[0-9;]*m")


@pytest.fixture(autouse=True)
def _palette():
    theme.reset_palette()
    theme.set_palette(theme.build_palette("#d6dee6", "#10151a"))
    yield
    theme.reset_palette()


def plain(entries):
    return [ANSI.sub("", e) for e in entries]


def call(uid, name, args, status="done"):
    return make_assistant_message(uuid=uid, content=make_tool_use_block(
        tool_use_id=uid, name=name, input={"raw": "", "args": args}, status=status))


def result(uid, output, *, status="", recoverable=False, is_error=None, name="read_file"):
    payload = {}
    if status:
        payload["status"] = status
    if recoverable:
        payload["recoverable"] = True
    error = is_error if is_error is not None else status == "error"
    return make_user_message(uuid=f"{uid}:r", content=make_tool_result_block(
        tool_use_id=uid, output=output, is_error=error, name=name, payload=payload))


def snap(*messages, streaming=None):
    return MessageSnapshot(messages=tuple(messages), streaming_text=streaming)


def test_tool_row_and_result_share_one_form():
    s = snap(call("a", "read_file", {"file_path": "/src/pkg/mod.py"}),
             result("a", "line1\nline2\nline3"),
             call("b", "execute", {"command": "rm -rf build"}),
             result("b", "The user rejected this tool call.", status="error", name="execute"))
    entries = render_turn(s, ViewOptions())
    text = plain(entries)
    assert text[0].splitlines()[0].endswith("Read(…/pkg/mod.py)")
    assert text[0].splitlines()[1] == "   ⎿ line1 (ctrl+o 展开 +2 行)"
    assert text[1].splitlines()[0].endswith("Bash(rm -rf build)")
    assert "The user rejected this tool call." in text[1]
    pal = theme.palette()
    assert theme.status_light("ok") in entries[0] and theme.status_light("error") in entries[1]
    assert f"{pal.red}The user rejected" in entries[1]
    assert "" not in entries, "consecutive tool rows take no blank line"


def test_words_in_output_do_not_decide_errors():
    s = snap(call("a", "grep", {"pattern": "error"}),
             result("a", "parser.py:12: raise error", name="grep", is_error=False))
    entry = render_turn(s, ViewOptions())[0]
    assert theme.status_light("ok") in entry and theme.status_light("error") not in entry


def test_recoverable_failures_are_muted_not_red():
    s = snap(call("a", "read_file", {}),
             result("a", "Tool call 'read_file' was not run: invalid arguments", status="error",
                    recoverable=True))
    entry = render_turn(s, ViewOptions())[0]
    pal = theme.palette()
    assert pal.muted_strike in entry and pal.red not in entry
    assert theme.status_light("error") not in entry


def test_expanded_results_show_more_lines_with_a_cap():
    output = "\n".join(f"l{i}" for i in range(40))
    s = snap(call("a", "execute", {"command": "seq 40"}), result("a", output, name="execute"))
    lines = plain(render_turn(s, ViewOptions(tools_expanded=True)))[0].splitlines()
    assert lines[1] == "   ⎿ l0" and lines[2] == "     l1"
    assert lines[-1] == "     … +10 行"


def test_running_and_pending_calls_have_rows():
    s = snap(call("a", "ls", {"path": "/"}, status="running"))
    entries = render_turn(s, ViewOptions(pending_calls=[{"name": "write_file",
                                                        "args": {"file_path": "/a.txt"}}]))
    text = plain(entries)
    assert text[0].endswith("Ls(/)")
    assert text[1].endswith("Write(/a.txt) 等待审批")


def test_thinking_answer_and_streaming_blocks_are_separated():
    s = snap(make_assistant_message(uuid="t", content=make_thinking_block(
        "**Planning**\n\nsome steps", title="Planning", duration_s=2.0, done=True)),
        make_assistant_message(uuid="x", content=make_text_block("Done **now**.")),
        streaming="still typing")
    text = plain(render_turn(s, ViewOptions()))
    assert text[0].startswith(" ∴ Thought: Planning · 2")
    assert text[1] == "" and text[2].startswith(f" {theme.GLYPH_AGENT} Done now.")
    assert text[-1].endswith("still typing")
    expanded = plain(render_turn(s, ViewOptions(thinking_expanded=True)))
    assert "some steps" in expanded[0]
    assert not any("∴" in e for e in plain(render_turn(s, ViewOptions(show_thinking=False))))


def test_errors_warnings_and_hidden_rows():
    s = snap(make_system_message(uuid="e", content=make_payload_block("error", {"text": "boom"})),
             make_system_message(uuid="w", content=make_payload_block("warn", {"text": "slow"})),
             call("t", "write_todos", {"todos": "[]"}),
             make_assistant_message(uuid="sub", content=make_text_block("inner"),
                                    parent_tool_use_id="task-1"))
    text = plain(render_turn(s, ViewOptions()))
    assert text == [f" {theme.GLYPH_ERROR} boom", "", " △ slow"]


def test_extension_renderers_replace_result_lines_and_fall_back_on_failure():
    s = snap(call("a", "echo_ro", {"x": 1}), result("a", '{"echo": 1}', name="echo_ro"))

    def good(update):
        return [f"   CARD {update.tool_name} {update.tool_output}"]

    def broken(_update):
        raise RuntimeError("renderer bug")

    assert plain(render_turn(s, ViewOptions(renderer_for=lambda n: good)))[0].endswith(
        'CARD echo_ro {"echo": 1}')
    assert "⎿" in plain(render_turn(s, ViewOptions(renderer_for=lambda n: broken)))[0]


def test_final_text_is_the_last_main_answer():
    s = snap(make_assistant_message(uuid="x", content=make_text_block("first")),
             make_assistant_message(uuid="y", content=make_text_block("second")),
             make_assistant_message(uuid="z", content=make_text_block("sub"), parent_tool_use_id="p"))
    assert final_text(s) == "second"
