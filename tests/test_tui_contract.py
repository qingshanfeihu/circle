"""The interaction contract (2026-09-29): one frame, a card for blocking questions, a fifth
lamp, one mode word in the frame's corner, a popup for lists that do not block.

What is pinned here is behaviour the user can see: which zone a piece of information goes
to, who holds the keyboard, and what the frame looks like while it is somebody's turn.
"""

from __future__ import annotations

import re

import pytest

from circle.ink import theme
from circle.ink.components.dialog_card import (
    CardLine,
    CardOption,
    CardSpec,
    PopupItem,
    card_rows,
    popup_rows,
    visible_width,
    wrap,
)
from circle.ink.components.dialog_frame import build_loop_frame
from circle.ink.components.exec_approval_view import ExecApprovalSession, SessionApprovalsSession
from circle.ink.parse_keypress import KeyPress
from circle.ink.string_width import string_width
from tests.test_plan_and_turns import _fake_session

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def plain(text: str) -> str:
    return ANSI.sub("", text)


# ── the fifth lamp ─────────────────────────────────────────────────────────


def test_waiting_lamp_is_cyan_and_steady_while_running_blinks():
    wait_a = theme.status_light("wait", now=0.0)
    wait_b = theme.status_light("wait", now=0.6)
    assert wait_a == wait_b, "waiting for you does not blink"
    assert theme.SGR_WAIT in wait_a and theme.LIGHT_GLYPH in wait_a
    assert theme.status_light("running", now=0.0) != theme.status_light("running", now=0.6)
    assert theme.status_light("wait", now=0.0) != theme.status_light("running", now=0.0)
    assert "wait" in theme.LIGHT_STATES


# ── the frame: turn colour and the mode word ───────────────────────────────


def test_mode_word_sits_at_the_bottom_right_and_keeps_the_frame_closed():
    pal = theme.palette()
    for elapsed in (None, 1.5):
        top, left, right, bottom = build_loop_frame(50, elapsed=elapsed, label="Brewing", mode="read-only",
                                                    mode_sgr=pal.green)
        edge = plain(bottom)
        assert string_width(edge) == 50 and string_width(plain(top)) == 50
        assert edge.startswith("╰") and edge.endswith(" read-only ─╯")
        assert f"{pal.green} read-only " in bottom, "the word keeps its own colour, not the rainbow's"


def test_a_static_frame_takes_the_border_colour_for_your_turn():
    pal = theme.palette()
    top, left, right, bottom = build_loop_frame(30, elapsed=None, border=pal.yellow)
    for part in (top, left, right, bottom):
        assert pal.yellow in part and "38;2" not in part, "yellow and still, never the rainbow"


def test_no_mode_word_means_a_plain_bottom_edge():
    _top, _l, _r, bottom = build_loop_frame(30, elapsed=None)
    assert plain(bottom) == "╰" + "─" * 28 + "╯"


# ── the card ───────────────────────────────────────────────────────────────


def _spec(**over) -> CardSpec:
    base = dict(title="Bash needs your permission",
                body=[CardLine("$ pytest tests/test_quicksort.py -q", "em"), CardLine("in the workspace", "dim")],
                options=[CardOption("Allow once"), CardOption("Allow this exact command for this session"),
                         CardOption("Reject and explain")],
                focus=1)
    base.update(over)
    return CardSpec(**base)


def test_card_rows_are_a_solid_rectangle_with_the_waiting_lamp_in_the_title():
    rows = card_rows(_spec(), 60)
    assert all(visible_width(r) == 60 for r in rows)
    text = [plain(r) for r in rows]
    assert text[0].startswith(" ● Bash needs your permission")
    assert theme.SGR_WAIT in rows[0], "the title's lamp is the cyan waiting lamp"
    assert text[1].startswith("   $ pytest") and text[2].startswith("   in the workspace")
    assert text[3].strip() == "", "a blank row separates the question from the menu"
    assert [t[:3] for t in text[4:7]] == [" 1 ", " 2 ", " 3 "], "the key column is its own column"
    assert "y/a/n" not in " ".join(text) and "enter" not in " ".join(text), "nothing teaches keys"


def test_the_focused_option_is_painted_whole_with_sel_bg():
    pal = theme.palette()
    rows = card_rows(_spec(focus=2), 60)
    bg_param = pal.sel_bg[2:-1]  # the SGR parameters of sel_bg
    focused = rows[6]
    assert _every_cell_has(focused, bg_param, skip=""), "the whole row: key, label and padding"
    assert all(bg_param not in r for r in rows[4:6]), "only the focused row"


def test_a_long_command_wraps_and_is_never_cut():
    command = "$ " + " ".join(f"--flag-{i}=value{i}" for i in range(20))
    rows = card_rows(_spec(body=[CardLine(command, "em")]), 50)
    body = " ".join(plain(r).strip() for r in rows[1:-4])
    for i in range(20):
        assert f"--flag-{i}=value{i}" in body, "the user has to read the whole command to approve it"
    assert all(visible_width(r) == 50 for r in rows)


def test_wrap_counts_display_width_so_cjk_wraps_at_the_right_column():
    lines = wrap("测试文件放哪里" * 5, 10)
    assert all(string_width(ln) <= 10 for ln in lines) and "".join(lines) == "测试文件放哪里" * 5


def test_popup_rows_use_the_panel_background_and_focus_one_row():
    pal = theme.palette()
    rows = popup_rows("Models", [PopupItem("a", "x", current=True), PopupItem("bb", "y")], 1, 40,
                      info=["context line"])
    text = [plain(r) for r in rows]
    assert text[0].strip() == "Models" and text[1].strip() == "context line"
    assert "current" in text[2] and all(visible_width(r) == 40 for r in rows)
    assert pal.sel_bg in rows[3] and pal.sel_bg not in rows[2]


# ── the approval card's keys ───────────────────────────────────────────────


def _approval(**payload):
    got: list[dict] = []
    renders: list[int] = []
    base = {"tool": "execute", "body": "$ ls", "scope": "this exact command", "allow_always": True}
    base.update(payload)
    session = ExecApprovalSession(base, render=lambda: renders.append(1), on_finish=got.append)
    return session, got, renders


def test_options_name_their_scope_and_forced_calls_cannot_be_remembered():
    session, _got, _r = _approval()
    labels = [o.label for o in session.card_spec().options]
    assert labels == ["Allow once", "Allow this exact command for this session", "Reject and explain"]
    forced, _g, _r2 = _approval(allow_always=False)
    assert [o.label for o in forced.card_spec().options] == ["Allow once", "Reject and explain"]
    assert session.card_spec().title == "Bash needs your permission"


@pytest.mark.parametrize("key,decision", [("1", "approve"), ("y", "approve"), ("2", "always"), ("a", "always"),
                                          ("n", "reject")])
def test_digits_and_the_hidden_mnemonics_answer_at_once(key, decision):
    session, got, _r = _approval()
    assert session.handle_key(key, key) is True
    assert got == [{"decision": decision}]


def test_esc_rejects_and_enter_confirms_the_focused_row():
    session, got, _r = _approval()
    session.handle_key("escape", "")
    assert got == [{"decision": "reject"}]
    session, got, _r = _approval()
    session.handle_key("down", "")
    session.handle_key("enter", "\r")
    assert got == [{"decision": "always"}]


def test_up_and_down_wrap_around_the_menu():
    session, _got, renders = _approval()
    session.handle_key("up", "")
    assert session.card_spec().focus == 2 and renders
    session.handle_key("down", "")
    assert session.card_spec().focus == 0


def test_printable_keys_are_swallowed_so_a_stray_letter_cannot_answer_or_type():
    session, got, _r = _approval()
    for key in ("x", "z", "q", "5", "space", "backspace"):
        assert session.handle_key(key, key if len(key) == 1 else "") is True
    assert got == [], "nothing was decided by keys that are not the card's"


def test_control_keys_and_scrolling_pass_through_to_the_session():
    session, got, _r = _approval()
    for key in ("ctrl+c", "ctrl+d", "ctrl+o", "pageup", "pagedown", "home", "end"):
        assert session.handle_key(key, "") is False, key
    assert got == []


def test_reject_and_explain_opens_a_reason_row_and_sends_the_text_with_the_rejection():
    session, got, renders = _approval()
    session.handle_key("3", "3")
    assert session.in_input and got == [] and session.card_spec().input_row
    session.submit_reason("  use pytest -x instead ")
    assert got == [{"decision": "reject", "message": "use pytest -x instead"}]


def test_an_empty_reason_is_a_plain_rejection_and_esc_goes_back_to_the_options():
    session, got, _r = _approval()
    session.handle_key("3", "3")
    session.cancel_input()
    assert not session.in_input and got == []
    session.handle_key("3", "3")
    session.submit_reason("   ")
    assert got == [{"decision": "reject", "message": ""}]


def test_approvals_popup_takes_arrows_digits_enter_and_esc():
    done: list[str] = []
    page = SessionApprovalsSession(lines=["[always] execute · pytest"],
                                   options=[{"key": "revoke:0", "label": "Revoke: pytest"},
                                            {"key": "close", "label": "Close"}],
                                   render=lambda: None, on_finish=done.append)
    text = [plain(r) for r in page.render_lines(60)]
    assert text[0].strip() == "Session approvals" and "Revoke: pytest" in " ".join(text)
    page.handle_key("down", "")
    page.handle_key("enter", "\r")
    assert done == ["close"]
    page.handle_key("escape", "")
    assert done[-1] == "close"
    assert page.handle_key("1", "1") and done[-1] == "revoke:0"


# ── the session: one frame, whoever's turn it is ───────────────────────────


@pytest.fixture
def app(tmp_path, monkeypatch):
    session = _fake_session(tmp_path, monkeypatch)
    session._app._width, session._app._height = 100, 30  # noqa: SLF001
    return session


def _approve_payload(app, name="execute", body="$ pytest -q"):
    return {"tool": name, "title": name, "body": body, "policy": "runs a command in the workspace",
            "allow_always": True, "scope": "this exact command", "more": 0, "tint": ""}


def test_the_card_takes_over_the_frame_and_hides_the_plan_box(app):
    app._plan_panel.update([{"content": "step", "status": "in_progress"}], width=100)  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert app._dialog.style.height == 3 and app._plan_panel.is_visible  # noqa: SLF001
    idle_top = app._dialog_top_text.value  # noqa: SLF001
    assert theme.palette().yellow not in idle_top

    app._prompt.set_value("half-typed")  # noqa: SLF001
    app._begin_exec_approval(_approve_payload(app))  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    rows = app._dialog_body_text.value.split("\n")  # noqa: SLF001
    assert len(rows) >= 6 and "needs your permission" in plain(rows[0])
    assert app._dialog.style.height == 2 + len(rows), "the prompt row is gone, the card is the frame"  # noqa: SLF001
    assert app._dialog_mid.style.display == "none"  # noqa: SLF001
    assert theme.palette().yellow in app._dialog_top_text.value, "your turn: yellow"  # noqa: SLF001
    assert "38;2" not in app._dialog_top_text.value, "and still, not the rainbow"  # noqa: SLF001
    assert not app._plan_panel.is_visible, "the plan box gives way to the question"  # noqa: SLF001
    assert app._prompt.value == "", "the draft is parked while the card is up"  # noqa: SLF001
    assert app._ask_saved_prompt == "half-typed"  # noqa: SLF001

    app._finish_exec_approval({"decision": "reject"})  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert app._dialog.style.height == 3 and app._plan_panel.is_visible  # noqa: SLF001


def test_keys_typed_while_the_card_is_up_never_reach_the_composer(app):
    app._begin_exec_approval(_approve_payload(app))  # noqa: SLF001
    app._handle_key(KeyPress(key="x", char="x"))  # noqa: SLF001
    app._handle_key(KeyPress(key="w", char="w"))  # noqa: SLF001
    assert app._prompt.value == "" and app._exec_approval is not None  # noqa: SLF001


def test_reject_and_explain_routes_typing_to_the_prompt_row_and_sends_it(app):
    app._approval_queue = [("i1", {"name": "execute", "args": {"command": "rm -rf build"}})]  # noqa: SLF001
    app._approval_decisions = {"i1": []}  # noqa: SLF001
    blocked: list = []
    app._bridge.announce_blocked = lambda call, reason: blocked.append(reason)  # noqa: SLF001
    app._begin_exec_approval(_approve_payload(app, body="$ rm -rf build"))  # noqa: SLF001
    app._handle_key(KeyPress(key="3", char="3"))  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert app._exec_approval.in_input  # noqa: SLF001
    assert app._dialog_mid.style.display != "none", "the reason row is the frame's last row"  # noqa: SLF001
    for ch in "keep build":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    assert app._prompt.value == "keep build"  # noqa: SLF001
    resumed: list = []
    app._interrupt_order = ["i1"]  # noqa: SLF001
    app._resume_with = resumed.append  # noqa: SLF001
    app._handle_key(KeyPress(key="enter", char="\r"))  # noqa: SLF001
    (decision,) = resumed[0]["decisions"]
    assert decision["type"] == "reject" and "keep build" in decision["message"]
    assert "keep build" in blocked[0], "the model is told why, not just no"
    assert app._exec_approval is None and app._prompt.value == ""  # noqa: SLF001


def test_mode_word_is_read_only_or_auto_and_nothing_for_the_default(app):
    pal = theme.palette()
    assert app._mode_word() == ("", "")  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert plain(app._dialog_bottom_text.value) == "╰" + "─" * 98 + "╯"  # noqa: SLF001
    app._approvals.set_yolo(app._thread_id, True)  # noqa: SLF001
    assert app._mode_word() == ("auto", pal.yellow)  # noqa: SLF001
    app._plan_mode = True  # noqa: SLF001
    assert app._mode_word() == ("read-only", pal.green), "the stronger restriction wins the one slot"  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert plain(app._dialog_bottom_text.value).endswith(" read-only ─╯")  # noqa: SLF001


def test_busy_frame_runs_the_rainbow_and_the_card_stops_it(app, monkeypatch):
    monkeypatch.setenv("CIRCLE_TUI_SHIMMER", "1")
    app._dialog_label = "Brewing… · 3.0s · ↓ 12"  # noqa: SLF001
    app._dialog_phase_origin = 1.0  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    busy = app._dialog_top_text.value  # noqa: SLF001
    assert "38;2" in busy and "Brewing" in plain(busy)
    app._begin_exec_approval(_approve_payload(app))  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    waiting = app._dialog_top_text.value  # noqa: SLF001
    assert "38;2" not in waiting and "Brewing" not in plain(waiting), "no busy word on your turn"


def test_the_user_echo_row_is_a_blue_marker_then_emphasised_words(app):
    from circle.tui.session_app import _user_rows

    rows = _user_rows("first\nsecond")
    assert plain(rows[0]) == " › first" and plain(rows[1]) == "   second"
    assert theme.palette().blue in rows[0]


def test_an_interrupted_turn_is_a_dim_cross_not_a_parenthesis(app):
    from circle.tui.session_app import _stop_line

    assert plain(_stop_line()) == f" {theme.GLYPH_ERROR} Interrupted"
    assert theme.palette().red not in _stop_line(), "stopped is not failed"


# ── typing-idle: a card waits for you to stop typing ───────────────────────


class _FakeTimer:
    made: list = []

    def __init__(self, delay, fn):
        self.delay, self.fn, self.daemon = delay, fn, False
        _FakeTimer.made.append(self)

    def start(self):
        pass


@pytest.fixture
def timers(monkeypatch):
    from circle.tui import session_app

    _FakeTimer.made = []
    monkeypatch.setattr(session_app.threading, "Timer", _FakeTimer)
    return _FakeTimer.made


def _queue(app, *commands):
    """Queue real approval requests the way an interrupt does, and capture the resume."""
    ids = [f"i{n}" for n in range(len(commands))]
    app._approval_queue = [(i, {"name": "execute", "args": {"command": c}})  # noqa: SLF001
                           for i, c in zip(ids, commands)]
    app._approval_decisions = {i: [] for i in ids}  # noqa: SLF001
    app._interrupt_order = ids  # noqa: SLF001
    app._bridge.announce_blocked = lambda *_a, **_k: None  # noqa: SLF001
    resumed: list = []
    app._bridge.resume = resumed.append  # noqa: SLF001 — the real _resume_with runs (it restores the draft)
    return resumed


def test_a_card_waits_until_the_draft_has_been_idle_for_a_second(app, timers):
    import time

    resumed = _queue(app, "ls")
    app._prompt.set_value("half a sentence")  # noqa: SLF001
    app._last_key_at = time.monotonic()  # noqa: SLF001 — typing right now
    app._next_approval()  # noqa: SLF001
    assert app._exec_approval is None and app._prompt.value == "half a sentence", "the draft is untouched"  # noqa: SLF001
    assert len(timers) == 1 and 0.9 < timers[0].delay <= 1.1

    app._last_key_at -= 5  # noqa: SLF001 — the user stopped
    timers[0].fn()
    assert app._exec_approval is not None and app._prompt.value == ""  # noqa: SLF001
    app._handle_key(KeyPress(key="1", char="1"))  # noqa: SLF001
    assert resumed == [{"decisions": [{"type": "approve"}]}]
    assert app._prompt.value == "half a sentence", "the draft comes back after the card"  # noqa: SLF001


def test_more_typing_defers_the_card_again(app, timers):
    import time

    _queue(app, "ls")
    app._prompt.set_value("typing")  # noqa: SLF001
    app._last_key_at = time.monotonic()  # noqa: SLF001
    app._next_approval()  # noqa: SLF001
    app._last_key_at = time.monotonic()  # noqa: SLF001 — still typing when the timer fires
    timers[0].fn()
    assert app._exec_approval is None and len(timers) == 2


def test_a_deferred_card_that_was_cancelled_never_appears(app, timers):
    import time

    _queue(app, "ls")
    app._prompt.set_value("typing")  # noqa: SLF001
    app._last_key_at = time.monotonic()  # noqa: SLF001
    app._next_approval()  # noqa: SLF001
    app._dismiss_user_panels()  # noqa: SLF001 — ctrl+c cancelled the turn
    app._last_key_at -= 5  # noqa: SLF001 — and the user is idle again
    timers[0].fn()
    assert app._exec_approval is None and len(timers) == 1, "a cancelled turn must not grow a stale card"  # noqa: SLF001
    assert app._prompt.value == "typing", "and the draft is where they left it"  # noqa: SLF001


def test_yolo_turned_on_while_the_card_was_held_back_approves_instead_of_asking(app, timers):
    import time

    resumed = _queue(app, "ls", "pwd")
    app._prompt.set_value("typing")  # noqa: SLF001
    app._last_key_at = time.monotonic()  # noqa: SLF001
    app._next_approval()  # noqa: SLF001
    app._approvals.set_yolo(app._thread_id, True)  # noqa: SLF001
    app._last_key_at -= 5  # noqa: SLF001
    timers[0].fn()
    assert app._exec_approval is None, "auto mode: no question"  # noqa: SLF001
    assert resumed == [{"i0": {"decisions": [{"type": "approve"}]}, "i1": {"decisions": [{"type": "approve"}]}}]


def test_an_empty_draft_gets_the_card_at_once(app):
    _queue(app, "ls")
    app._next_approval()  # noqa: SLF001
    assert app._exec_approval is not None  # noqa: SLF001


# ── the card owns the keyboard, the cursor and the paste ─────────────────


def test_a_paste_cannot_get_past_the_card_but_reaches_the_reason_row(app):
    from circle.ink.parse_keypress import PasteEvent

    _queue(app, "ls")
    app._next_approval()  # noqa: SLF001
    app._handle_input(PasteEvent(text="secret pasted text"))  # noqa: SLF001
    assert app._prompt.value == "", "the prompt row is hidden: nothing may land in it"  # noqa: SLF001
    app._handle_key(KeyPress(key="3", char="3"))  # noqa: SLF001
    app._handle_input(PasteEvent(text="use -x"))  # noqa: SLF001
    assert app._prompt.value == "use -x", "but the reason row takes it"  # noqa: SLF001


def test_a_long_paste_in_the_draft_survives_the_card(app):
    from circle.ink.parse_keypress import PasteEvent

    resumed = _queue(app, "ls")
    app._handle_input(PasteEvent(text="\n".join(f"row {i}" for i in range(40))))  # noqa: SLF001
    draft = app._prompt.value  # noqa: SLF001
    assert draft.startswith("[Pasted text")
    app._next_approval()  # noqa: SLF001
    app._handle_key(KeyPress(key="y", char="y"))  # noqa: SLF001
    assert resumed and app._prompt.value == draft  # noqa: SLF001
    assert "row 39" in app._prompt.expand_pasted_refs(app._prompt.value), "the paste still expands"  # noqa: SLF001


def test_no_terminal_cursor_is_declared_while_the_prompt_row_is_hidden(app):
    _queue(app, "ls", "pwd")
    app._next_approval()  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert app._app.cursor.get_absolute_position() is None
    app._handle_key(KeyPress(key="1", char="1"))  # noqa: SLF001 — answers card 1; card 2 arrives
    assert app._exec_approval is not None  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert app._app.cursor.get_absolute_position() is None, "not on the second card's title either"


def test_an_exotic_digit_neither_answers_nor_kills_the_input_thread(app):
    for glyph in ("²", "①", "٣"):
        session, got, _r = _approval()
        assert session.handle_key(glyph, glyph) is True and got == []
    page = SessionApprovalsSession(lines=[], options=[{"key": "close", "label": "Close"}],
                                   render=lambda: None, on_finish=lambda _k: None)
    assert page.handle_key("²", "²") is False, "not a digit answer, and no ValueError"
    from circle.ink.components.ask_user_view import AskUserSession

    ask = AskUserSession([{"question": "A?", "options": [{"label": "x"}]}], render=lambda: None,
                         on_answer=lambda _a: None)
    assert ask.handle_key("²", "²") is True


def test_the_approvals_popup_yields_to_a_card_and_dies_with_a_cancelled_turn(app):
    app._begin_approvals_page()  # noqa: SLF001
    assert app._approvals_page is not None and app._ask_panel.is_visible  # noqa: SLF001
    _queue(app, "ls")
    app._next_approval()  # noqa: SLF001
    assert app._approvals_page is None and not app._ask_panel.is_visible, "esc must mean the card's esc"  # noqa: SLF001
    app._begin_approvals_page()  # noqa: SLF001
    app._dismiss_user_panels()  # noqa: SLF001
    assert app._approvals_page is None, "a cancelled turn leaves no popup holding the keyboard"  # noqa: SLF001


def test_a_reason_typed_before_ctrl_c_does_not_linger_in_the_composer(app):
    _queue(app, "ls")
    app._next_approval()  # noqa: SLF001
    app._handle_key(KeyPress(key="3", char="3"))  # noqa: SLF001
    for ch in "no because":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    assert app._prompt.value == "no because"  # noqa: SLF001
    app._dismiss_user_panels()  # noqa: SLF001
    assert app._prompt.value == "", "the next enter must not send the abandoned reason"  # noqa: SLF001


def test_a_tall_body_is_cut_to_keep_the_menu_on_a_short_screen():
    body = [CardLine(f"line {i}", "text") for i in range(40)]
    spec = _spec(body=body, focus=0)
    rows = card_rows(spec, 60, max_rows=14)
    text = [plain(r) for r in rows]
    assert len(rows) <= 14
    assert text[0].startswith(" ● Bash needs your permission"), "the title stays"
    assert any("… +" in t and "lines" in t for t in text), "and it says how much was cut"
    assert [t[:3] for t in text[-3:]] == [" 1 ", " 2 ", " 3 "], "the options are never clipped away"
    assert len(card_rows(spec, 60)) > 40, "without a limit nothing is cut"


def test_the_question_row_names_the_question_even_when_only_the_raw_input_survives():
    from circle.display_lexicon import tool_arg_summary, tool_short_name

    raw = "{'questions': [{'question': 'Which test framework?', 'options': [{'label': 'pytest'}]}]}"
    assert tool_short_name("question") == "Question"
    assert tool_arg_summary("question", {"raw": raw}) == "Which test framework?"
    assert tool_arg_summary("question", {"questions": [{"question": "Where do tests go?"}]}) == "Where do tests go?"


# ── a background must ride in every segment (ink rebuilds each inline SGR from the base) ──


def _every_cell_has(row: str, param: str, skip: str = "│┌┐└┘─") -> bool:
    """Every visible cell of ``row`` is drawn under an SGR containing ``param`` (ink applies
    each inline SGR on top of the base style only, so a later one replaces an earlier one)."""
    current = ""
    for token in re.split(r"(\x1b\[[0-9;]*m)", row):
        if token.startswith("\x1b["):
            current = "" if token == "\x1b[0m" else token
        elif token and not set(token) <= set(skip) and param not in current:
            return False
    return True


def _every_cell_has_a_background(row: str, skip: str = "│┌┐└┘─") -> bool:
    return _every_cell_has(row, "48;2", skip)


def test_plan_box_rows_are_tinted_end_to_end_not_just_the_first_cell():
    from circle.ink.components.plan_panel import plan_lines

    todos = [{"content": f"item {i}", "status": s} for i, s in
             enumerate(["completed", "in_progress", "pending", "pending", "pending", "pending"])]
    lines = plan_lines(todos, width=60)
    for row in lines[1:-1]:
        assert _every_cell_has_a_background(row), plain(row)


def test_card_rows_keep_their_tint_across_lamp_body_and_padding():
    pal = theme.palette()
    rows = card_rows(_spec(tint=pal.write_bg), 60)
    for row in rows[:3]:
        assert _every_cell_has_a_background(row), plain(row)


# ── hints appear exactly where content is folded, and nowhere else ─────────


def test_a_key_hint_shows_only_where_something_is_hidden():
    from circle.tui.content_blocks import render_thinking_line

    assert plain(render_thinking_line(body="x", done=True, duration_s=1.0)).endswith("ctrl+t")
    assert "ctrl+t" not in plain(render_thinking_line(body="", done=True, duration_s=1.0))
    assert "ctrl+t" not in plain(render_thinking_line(body="x", done=True, expanded=True))


def test_view_toggles_and_receipts_are_flashes_never_transcript_lines(app):
    before = list(app._transcript.snapshot())  # noqa: SLF001
    app._toggle_tool_outputs()  # noqa: SLF001
    app._toggle_thinking()  # noqa: SLF001
    assert list(app._transcript.snapshot()) == before, "toggling a view leaves no line behind"  # noqa: SLF001
    assert app._footer._toast_text == "Thinking expanded"  # noqa: SLF001
    app._flash("Copied 3 chars")  # noqa: SLF001
    assert app._footer._toast_text == "Copied 3 chars"  # noqa: SLF001


def test_a_failure_stays_in_the_transcript_as_a_red_cross(app):
    app._fail("Could not switch model: boom")  # noqa: SLF001
    last = plain(app._transcript.snapshot()[-1])  # noqa: SLF001
    assert last == f" {theme.GLYPH_ERROR} Could not switch model: boom"
    assert theme.palette().red in app._transcript.snapshot()[-1]  # noqa: SLF001


# ── rendering bugs the review found ────────────────────────────────────────


def test_wrap_does_not_start_a_line_with_the_space_it_broke_at():
    assert wrap("hello world foo", 11) == ["hello world", "foo"]
    assert wrap("aaaa bbbb", 4) == ["aaaa", "bbbb"]


def test_an_option_note_wraps_with_its_label_and_is_never_cut():
    note = "keeps slow tests apart so the default pytest run stays fast for everyone"
    spec = _spec(options=[CardOption("tests/integration", note=note), CardOption("flat")], focus=1)
    rows = card_rows(spec, 40)
    assert all(visible_width(r) == 40 for r in rows)
    text = " ".join(plain(r).strip() for r in rows)
    assert "…" not in text and "for everyone" in text and "keeps slow tests apart" in text
    option_rows = [plain(r) for r in rows if plain(r).startswith((" 1", "  "))][1:]
    assert all(r.startswith("   ") for r in option_rows if not r.startswith(" 1")), "continuations align to the label"


def test_two_digit_keys_do_not_push_the_label_column():
    rows = card_rows(_spec(options=[CardOption(f"opt{i}") for i in range(11)], focus=0), 40)
    labels = [plain(r) for r in rows if "opt" in plain(r)]
    assert len({r.index("opt") for r in labels}) == 1, "one label column for keys 1..11"


def test_waiting_rows_never_outgrow_the_screen():
    from circle.tui.transcript_view import ViewOptions, _pending_entry, _tool_row
    from circle.tui.message_model import make_tool_use_block

    long_cmd = "find / -name '*.py' -not -path '*/node_modules/*' -exec grep -l something {} +"
    for width in (40, 60, 80):
        row = plain(_pending_entry({"name": "execute", "args": {"command": long_cmd}}, width))
        assert string_width(row) <= width and row.endswith("waiting for you"), (width, row)
        block = make_tool_use_block(tool_use_id="q", name="question", status="running",
                                    input={"args": {"questions": [{"question": "Which " * 30}]}})
        row = plain(_tool_row(block.content[0] if hasattr(block, "content") else block, None, ViewOptions(width=width)))
        assert string_width(row) <= width and row.endswith("waiting for you"), (width, row)


def test_a_cancelled_question_stops_saying_it_waits_for_you():
    from circle.tui.message_model import make_tool_use_block
    from circle.tui.transcript_view import ViewOptions, _tool_row

    block = make_tool_use_block(tool_use_id="q", name="question", status="error", input={})
    block = block.content[0] if hasattr(block, "content") else block
    assert "waiting for you" not in plain(_tool_row(block, None, ViewOptions()))


@pytest.mark.parametrize("width", [20, 24, 40, 60, 80, 215])
def test_the_header_never_outgrows_the_screen_and_drops_the_hint_first(app, width):
    app.settings.auth.model = "claude-opus-4-5-20251101-with-a-very-long-suffix"
    app._sync_header(width)  # noqa: SLF001
    row = plain(app._header_text.value).rstrip("\n")  # noqa: SLF001
    assert string_width(row) <= width, (width, row)
    assert row.lstrip().startswith("circle"), "the identity always survives"
    if width < 60:
        assert "?" not in row, "the hint is what gives way first"
    elif width >= 100:
        assert row.rstrip().endswith("? for shortcuts")


def test_the_home_prefix_is_a_path_boundary_not_a_string_prefix(app, monkeypatch, tmp_path):
    from pathlib import Path

    home = tmp_path / "me"
    monkeypatch.setattr(Path, "home", staticmethod(lambda: home))
    app.workspace = tmp_path / "meX" / "proj"
    app._sync_header(120)  # noqa: SLF001
    assert "~X" not in plain(app._header_text.value)  # noqa: SLF001


def test_strip_names_keep_their_id_tail_and_the_unit_goes_before_the_name():
    from circle.tui.agent_strip import render_agent_strip
    from tests.test_agent_strip import card

    rows = [card("c1", name="general-purpose", description="left side"),
            card("c2", name="general-purpose", description="right side")]
    for width in (40, 50, 60):
        lines = [plain(ln) for ln in render_agent_strip(rows, width=width, now=1005.0)]
        assert all(string_width(ln) <= width for ln in lines), (width, lines)
        names = [ln.split()[1] for ln in lines[1:3]]
        assert names[0] != names[1], f"parallel agents stay distinguishable at {width}: {names}"
    tight = [plain(ln) for ln in render_agent_strip(rows, width=40, now=1005.0)]
    assert "tokens" not in tight[1], "the unit word is dropped before the name is cut"
    assert "general-purpose·c1" in tight[1] and "general-purpose·c2" in tight[2], "so the names stay whole"


def test_the_detail_band_has_one_space_after_its_lamp():
    from circle.tui.agent_detail import render_detail_band
    from tests.test_agent_strip import card

    lines, _spans = render_detail_band(card("c1", name="explore")[1], index=1, total=2, width=80, now=1005.0)
    assert plain(lines[0]).startswith(" ● explore"), plain(lines[0])


@pytest.mark.parametrize("width", [17, 24, 30])
def test_the_mode_word_survives_a_narrow_frame(width):
    _t, _l, _r, bottom = build_loop_frame(width, elapsed=None, mode="read-only")
    assert plain(bottom).endswith(" read-only ─╯") and string_width(plain(bottom)) == width


def test_the_plan_lamp_blinks_between_frames(app, monkeypatch):
    from circle.ink import theme as theme_mod

    app._plan_panel.update([{"content": "run", "status": "in_progress"}], width=100)  # noqa: SLF001
    seen = set()
    for now in (0.0, 0.6, 1.2, 1.8):
        monkeypatch.setattr(theme_mod.time, "monotonic", lambda now=now: now)
        app._sync_dialog_frame()  # noqa: SLF001
        seen.add(app._plan_panel._text.value)  # noqa: SLF001
    assert len(seen) == 2, "two lamp phases, redrawn by the frame hook"


# ── coverage the review found missing ───────────────────────────────────────


def test_the_question_card_swallows_printable_keys_too():
    from circle.ink.components.ask_user_view import AskUserSession

    got: list = []
    ask = AskUserSession([{"question": "A?", "options": [{"label": "x"}, {"label": "y"}]}],
                         render=lambda: None, on_answer=got.append)
    for key in ("z", "q", "w", "space_bar"):
        assert ask.handle_key(key, key if len(key) == 1 else "") is True
    assert got == []


def test_a_call_that_cannot_be_remembered_swallows_a_and_two_means_explain():
    session, got, _r = _approval(allow_always=False)
    session.handle_key("a", "a")
    assert got == [] and not session.in_input
    session.handle_key("2", "2")
    assert session.in_input, "with no 'for this session' row, option 2 is Reject and explain"


def test_question_mark_on_an_empty_prompt_shows_the_shortcuts(app):
    seen: list = []
    app._dispatch_slash = lambda name, args: seen.append(name)  # noqa: SLF001
    app._handle_key(KeyPress(key="?", char="?"))  # noqa: SLF001
    assert seen == ["hotkeys"]
    seen.clear()
    app._prompt.set_value("what is")  # noqa: SLF001
    app._handle_key(KeyPress(key="?", char="?"))  # noqa: SLF001
    assert seen == [] and app._prompt.value.endswith("?"), "in a sentence it is just a question mark"  # noqa: SLF001


def test_fold_lines_carry_their_hint():
    from circle.ink.components.ask_user_view import AskUserSession

    ask = AskUserSession([{"question": "\n".join(f"line {i}" for i in range(12)), "options": [{"label": "x"}]}],
                         render=lambda: None, on_answer=lambda _a: None)
    spec = ask.card_spec()
    assert any(line.text.endswith("lines · ctrl+o") for line in spec.body)
