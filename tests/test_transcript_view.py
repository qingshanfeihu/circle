"""Snapshot → transcript entries: one tool-row form for every outcome, results under
``⎿``, muted recoverable errors, pending approvals, thinking title and duration."""

from __future__ import annotations

import json
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
    assert text[0].splitlines()[1:] == ["   ⎿ Read 3 lines · ctrl+o"], "the body stays folded, and says how to open it"
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


def test_expanded_results_show_all_lines():
    output = "\n".join(f"l{i}" for i in range(40))
    s = snap(call("a", "execute", {"command": "seq 40"}), result("a", output, name="execute"))
    lines = plain(render_turn(s, ViewOptions(tools_expanded=True)))[0].splitlines()
    assert lines[1] == "   ⎿ l0" and lines[2] == "     l1"
    assert lines[-1] == "     l39"


def test_collapsed_long_result_line_has_a_physical_row_limit():
    output = "x" * 10_000
    s = snap(call("a", "execute", {"command": "print data"}),
             result("a", output, name="execute"))
    collapsed = plain(render_turn(s, ViewOptions(width=40)))[0].splitlines()
    assert len(collapsed) <= 6
    fold = re.fullmatch(r"     … \+(\d+) chars · ctrl\+o", collapsed[-1])
    assert fold, collapsed[-1]
    shown = "".join(line[5:] for line in collapsed[1:-1])
    assert set(shown) == {"x"} and len(shown) + int(fold.group(1)) == len(output)

    expanded = plain(render_turn(s, ViewOptions(width=40, tools_expanded=True)))[0].splitlines()
    assert " chars" not in "\n".join(expanded) and "…" not in "\n".join(expanded)
    assert "".join(line[5:] for line in expanded[1:]) == output


def test_bounded_read_keeps_actual_range_but_hides_body_until_expanded():
    body = "\n".join(f"{line}  source {line}" for line in range(301, 346))
    s = snap(call("r", "read_file", {"file_path": "/root/references/authoring.md",
                                     "offset": 301, "limit": 100}),
             result("r", f"@@ lines 301-345 of 345 @@\n{body}"))
    collapsed = plain(render_turn(s, ViewOptions()))[0]
    assert "Read(…/references/authoring.md:301-345)" in collapsed
    assert collapsed.splitlines()[1:] == ["   ⎿ @@ lines 301-345 of 345 @@ · ctrl+o"]
    assert "301  source" not in collapsed
    narrow = plain(render_turn(s, ViewOptions(width=40)))[0]
    assert "Read(…/authoring.md:301-345)" in narrow.splitlines()[0]
    assert len(narrow.splitlines()[0]) <= 40
    expanded = plain(render_turn(s, ViewOptions(tools_expanded=True)))[0]
    assert "301  source 301" in expanded and "345  source 345" in expanded


def test_structured_results_show_diagnostics_and_retain_unknown_fields():
    output = json.dumps({
        "ok": False, "status": "rejected", "autoid": "42",
        "violations": [{"code": "criterion_lowering_mismatch", "locus": "steps[8]",
                        "detail": "cannot lower"}],
        "unrecognized": {"nested": 7},
    })
    s = snap(call("x", "cex_author_submit_case", {"batch": "b", "autoid": "42"}),
             result("x", output, name="cex_author_submit_case"))
    collapsed = plain(render_turn(s, ViewOptions()))[0]
    assert "status: rejected" in collapsed
    assert "criterion_lowering_mismatch" in collapsed
    expanded = plain(render_turn(s, ViewOptions(tools_expanded=True)))[0]
    assert "unrecognized:" in expanded and '"nested": 7' in expanded
    python_repr = snap(call("p", "custom_lookup", {"name": "x"}),
                       result("p", "{'ok': False, 'status': 'rejected', 'detail': 'bad input'}",
                              name="custom_lookup"))
    assert "status: rejected" in plain(render_turn(python_repr, ViewOptions()))[0]


def test_tool_summaries_keep_meaningful_identifiers_without_overflow():
    s = snap(call("a", "execute", {"command": "python3 - <<'EOF'\n# inspect case.xlsx receipt\nEOF"}),
             result("a", "done", name="execute"),
             call("b", "cex_lang_query", {"kind": "param", "name": "sdns on"}),
             result("b", "ok", name="cex_lang_query"),
             call("c", "cex_author_submit_case", {"batch": "slb-list-v2", "autoid": "245861"}),
             result("c", "ok", name="cex_author_submit_case"))
    text = plain(render_turn(s, ViewOptions(width=80)))
    assert "Bash(python3 - · inspect case.xlsx receipt)" in text[0]
    assert "cex_lang_query(kind=param, name='sdns on')" in text[1]
    assert "cex_author_submit_case(slb-list-v2 · 245861)" in text[2]
    narrow = plain(render_turn(s, ViewOptions(width=50)))
    assert all(len(entry.splitlines()[0]) <= 50 for entry in narrow)


def test_running_and_pending_calls_have_rows():
    s = snap(call("a", "ls", {"path": "/"}, status="running"))
    entries = render_turn(s, ViewOptions(pending_calls=[{"name": "write_file",
                                                        "args": {"file_path": "/a.txt"}}]))
    text = plain(entries)
    assert text[0].endswith("Ls(/)")
    assert text[1].endswith("Write(/a.txt)  waiting for you")


def test_thinking_and_its_answer_are_one_block_two_answers_are_two():
    s = snap(make_assistant_message(uuid="t", content=make_thinking_block(
        "**Planning**\n\nsome steps", title="Planning", duration_s=2.0, done=True)),
        make_assistant_message(uuid="x", content=make_text_block("Done **now**.")),
        streaming="still typing")
    text = plain(render_turn(s, ViewOptions()))
    assert text[0] == " ∴ Thought 2.0s · Planning  ctrl+t", "duration after Thought, title after ·, then the one hint"
    assert text[1].startswith(f" {theme.GLYPH_AGENT} Done now."), "∴ then ⏺ is one answer block"
    assert text[2] == "" and text[3].endswith("still typing"), "two ⏺ entries are two blocks"
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
    assert text == [f" {theme.GLYPH_ERROR} boom", "", f" {theme.GLYPH_ERROR} slow"]


def test_extension_renderers_replace_result_lines_and_fall_back_on_failure():
    s = snap(call("a", "echo_ro", {"x": 1}), result("a", '{"echo": 1}', name="echo_ro"))

    def good(update):
        return [f"   CARD {update.tool_name} {update.tool_output}"]

    def broken(_update):
        raise RuntimeError("renderer bug")

    assert plain(render_turn(s, ViewOptions(renderer_for=lambda n: good)))[0].endswith(
        'CARD echo_ro {"echo": 1}')
    assert "⎿" in plain(render_turn(s, ViewOptions(renderer_for=lambda n: broken)))[0]
    many = lambda _update: [f"   CARD {number}" for number in range(10)]
    collapsed = plain(render_turn(s, ViewOptions(renderer_for=lambda n: many)))[0]
    expanded = plain(render_turn(s, ViewOptions(renderer_for=lambda n: many,
                                                tools_expanded=True)))[0]
    assert "CARD 5" in collapsed and "CARD 6" not in collapsed and "+4 lines" in collapsed
    assert "CARD 9" in expanded


def test_final_text_is_the_last_main_answer():
    s = snap(make_assistant_message(uuid="x", content=make_text_block("first")),
             make_assistant_message(uuid="y", content=make_text_block("second")),
             make_assistant_message(uuid="z", content=make_text_block("sub"), parent_tool_use_id="p"))
    assert final_text(s) == "second"
