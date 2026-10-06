"""The input box grows with the draft, as pi's editor: line breaks start rows, long lines
wrap at spaces, ↑ ↓ move between rows, and past a limit the box scrolls."""

from __future__ import annotations

from circle.ink.app import InkApp
from circle.ink.components.prompt_input import PromptInput, cursor_row, visual_lines
from circle.ink.parse_keypress import KeyPress
from tests.test_plan_and_turns import _fake_session
from tests.test_tui_contract import plain


def _texts(value, width):
    """The rows as they read; a space a row breaks after stays at its end, unseen."""
    return [value[s:e].rstrip(" ") for s, e in visual_lines(value, width)]


def test_rows_break_at_line_breaks_and_wrap_at_spaces():
    assert _texts("first↵second", 20) == ["first", "second"]
    assert _texts("one two three four", 9) == ["one two", "three", "four"]
    assert _texts("abcdefghijkl", 5) == ["abcde", "fghij", "kl"]
    assert _texts("中文中文中文", 4) == ["中文", "中文", "中文"], "wide characters take two columns"
    rows = visual_lines("ab↵cd", 10)
    assert [cursor_row(rows, c) for c in range(6)] == [0, 0, 0, 1, 1, 1]


def test_the_box_shows_rows_and_moves_between_them():
    prompt = PromptInput(cursor_manager=InkApp(alt_screen=False).cursor)
    prompt.set_width(23)  # 20 columns of text after " › "
    prompt.set_value("first row↵second row is longer than the box")
    assert prompt.rows_shown == 3  # "first row", "second row is longer", "than the box"
    assert prompt.node.children[0].value.split("\n")[0] == " › first row"
    assert prompt.move_vertical(-1) and prompt.move_vertical(-1)
    assert not prompt.move_vertical(-1), "the first row: ↑ is for the history"
    assert prompt.cursor_pos <= len("first row")
    prompt.max_rows = 2
    prompt.set_value("a↵b↵c↵d↵e")
    assert prompt.rows_shown == 2
    assert prompt.node.children[0].value.split("\n") == ["   d", "   e"], "it follows the cursor"


def test_the_frame_grows_with_the_draft(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 40, 30  # noqa: SLF001
    for ch in "one":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._handle_key(KeyPress(key="shift+enter", shift=True))  # noqa: SLF001
    for ch in "two":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert app._dialog.style.height == 4 and app._dialog_mid.style.height == 2  # noqa: SLF001
    app._handle_key(KeyPress(key="up"))  # noqa: SLF001
    assert app._prompt.cursor_pos == 3, "↑ moved to the first row, not into the history"  # noqa: SLF001
    assert plain(app._dialog_left_text.value).split("\n") == ["│", "│"]  # noqa: SLF001


def test_up_from_a_long_row_lands_on_the_row_above():
    prompt = PromptInput(cursor_manager=InkApp(alt_screen=False).cursor)
    prompt.set_width(13)  # 10 columns of text
    prompt.set_value("abcdefgh ijklmnopqr")
    assert prompt.move_vertical(-1)
    rows = visual_lines(prompt.value, 10)
    assert cursor_row(rows, prompt.cursor_pos) == 0, "one press is one row"
