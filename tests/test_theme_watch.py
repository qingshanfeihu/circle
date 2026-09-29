"""``theme = auto`` follows the terminal while Circle runs: the terminal's answers to a colour
query and its colour-scheme pushes are parsed, compared with the last reading, and repaint the
screen only when something really changed."""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import pytest

from circle.ink import theme
from circle.ink.app import InkApp
from circle.ink.parse_keypress import (
    ColorReportEvent,
    ColorSchemeEvent,
    InputParser,
    KeyPress,
)
from circle.ink.theme_watch import ThemeWatcher
from circle.settings import load_settings
from tests.test_slash_behaviors import _app
from tests.test_theme_matching import _paint, _sub

DARK = ("#c0caf5", "#1a1b26")
LIGHT = ("#1a1a1a", "#fcfbf9")


@pytest.fixture(autouse=True)
def _restore_theme():
    saved = theme.detected_palette()
    yield
    theme._detected = saved  # noqa: SLF001
    theme.reset_palette()


def _osc(code: str, rgb: str, end: str = "\x07") -> str:
    r, g, b = (rgb[i:i + 2] for i in (1, 3, 5))
    return f"\x1b]{code};rgb:{r}{r}/{g}{g}/{b}{b}{end}"


# ── the parser ────────────────────────────────────────────────────────────────

def test_parser_reads_colour_answers_ending_in_bel_or_st():
    parser = InputParser()
    assert parser.feed(_osc("11", "#1a1b26")) == [ColorReportEvent(slot=11, color="#1a1b26")]
    assert parser.feed(_osc("10", "#c0caf5", "\x1b\\")) == [ColorReportEvent(slot=10, color="#c0caf5")]
    assert parser.feed(_osc("4;5", "#bb9af7")) == [ColorReportEvent(slot=5, color="#bb9af7")]


def test_parser_reads_the_colour_scheme_push():
    parser = InputParser()
    assert parser.feed("\x1b[?997;1n") == [ColorSchemeEvent(dark=True)]
    assert parser.feed("\x1b[?997;2n") == [ColorSchemeEvent(dark=False)]


@pytest.mark.parametrize("reply", ["\x1b[?2031;2$y", "\x1b[?997;3n", "\x1b[?1;2c", "\x1b[?u"])
def test_other_private_replies_are_never_typed_as_keys(reply):
    assert InputParser().feed(reply) == []


def test_a_bad_colour_answer_is_ignored():
    assert InputParser().feed("\x1b]11;rgb:zz/zz/zz\x07") == []
    assert InputParser().feed("\x1b]4;x;rgb:0000/0000/0000\x07") == []


def test_ordinary_typing_still_parses():
    assert InputParser().feed("n") == [KeyPress(key="n", char="n")]


# ── the watcher ───────────────────────────────────────────────────────────────

class _Rig:
    def __init__(self, mode="auto", **kwargs):
        self.writes: list[str] = []
        self.changes = 0
        self.live = True
        self.watch = ThemeWatcher(
            write=self.writes.append, active=lambda: self.live,
            on_change=self._changed, settle=0.01, **kwargs)
        self.watch._mode = mode  # noqa: SLF001

    def _changed(self):
        self.changes += 1

    def answer(self, fg, bg):
        self.watch.handle(ColorReportEvent(slot=10, color=fg))
        self.watch.handle(ColorReportEvent(slot=11, color=bg))
        self.watch.flush()


def test_a_different_reading_repaints_once():
    theme.set_detected(*DARK, {})
    rig = _Rig()
    rig.answer(*LIGHT)
    assert rig.changes == 1
    assert theme.detected_palette()[1] == "#fcfbf9"


def test_the_same_reading_does_not_repaint():
    theme.set_detected(*DARK, {})
    rig = _Rig()
    rig.answer(*DARK)
    assert rig.changes == 0


def test_answers_arriving_apart_are_taken_together():
    theme.set_detected(*DARK, {})
    rig = _Rig()
    rig.watch.handle(ColorReportEvent(slot=10, color=LIGHT[0]))
    assert rig.changes == 0  # the background has not come yet
    rig.watch.handle(ColorReportEvent(slot=11, color=LIGHT[1]))
    rig.watch.flush()
    assert rig.changes == 1


def test_palette_slots_are_merged_into_the_reading():
    theme.set_detected(*DARK, {5: (1, 2, 3)})
    rig = _Rig()
    rig.watch.handle(ColorReportEvent(slot=11, color="#000000"))
    rig.watch.handle(ColorReportEvent(slot=4, color="#102030"))
    rig.watch.flush()
    fg, bg, slots = theme.detected_palette()
    assert bg == "#000000" and fg == DARK[0]
    assert slots == {5: (1, 2, 3), 4: (16, 32, 48)}


@pytest.mark.parametrize("mode", ["dark", "light"])
def test_a_forced_theme_does_not_listen(mode):
    theme.set_detected(*DARK, {})
    rig = _Rig(mode=mode)
    rig.answer(*LIGHT)
    assert rig.changes == 0
    assert theme.detected_palette()[1] == DARK[1]


def test_a_push_makes_it_ask_at_once():
    rig = _Rig()
    rig.watch.handle(ColorSchemeEvent(dark=False))
    assert rig.writes == [theme.COLOR_QUERY]


def test_it_does_not_ask_while_the_screen_is_lent_out_or_the_theme_is_forced():
    rig = _Rig()
    rig.live = False
    rig.watch.ask()
    forced = _Rig(mode="light")
    forced.watch.ask()
    assert rig.writes == [] and forced.writes == []


def test_switching_back_to_auto_asks_again():
    rig = _Rig(mode="light")
    rig.watch.set_mode("auto")
    assert rig.writes == [theme.COLOR_QUERY]
    rig.watch.set_mode("terminal")  # the old name of auto
    assert rig.watch.mode == "auto"


def _wait_for(condition, seconds=2.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.01)
    return condition()


def test_it_polls_a_terminal_that_answers():
    theme.set_detected(*DARK, {})
    rig = _Rig(interval=0.01)
    rig.watch.start("auto")
    try:
        assert _wait_for(lambda: len(rig.writes) >= 6)
    finally:
        rig.watch.stop()


def test_it_stops_asking_a_terminal_that_never_answers():
    theme.reset_palette()
    theme._detected = None  # noqa: SLF001
    rig = _Rig(interval=0.01, give_up_after=3)
    rig.watch.start("auto")
    try:
        assert _wait_for(lambda: len(rig.writes) >= 4)  # one on start, three polls
        time.sleep(0.15)
        assert len(rig.writes) == 4
    finally:
        rig.watch.stop()


def test_stop_ends_the_polling():
    theme.set_detected(*DARK, {})
    rig = _Rig(interval=0.01)
    rig.watch.start("auto")
    assert _wait_for(lambda: len(rig.writes) >= 2)
    rig.watch.stop()
    time.sleep(0.05)
    seen = len(rig.writes)
    time.sleep(0.1)
    assert len(rig.writes) == seen


# ── the screen ───────────────────────────────────────────────────────────────

class _FakeTerminal:
    columns, rows, input_fd = 80, 24, -1

    def __init__(self):
        self.out: list[str] = []

    def set_raw_mode(self, enable):  # noqa: FBT001
        pass

    def write(self, data):
        self.out.append(data)

    def restore(self):
        pass


def test_the_screen_asks_for_scheme_reports_only_when_told_to_and_always_switches_them_off():
    from circle.ink.termio.dec import DCS_REPORTS, ECS

    ink = InkApp(alt_screen=True, mouse=False)
    ink._terminal = _FakeTerminal()  # noqa: SLF001
    ink._running = True  # noqa: SLF001
    ink.color_scheme_reports = True
    ink._suspended = False  # noqa: SLF001
    ink.set_color_scheme_reports(False)
    ink.set_color_scheme_reports(True)
    joined = "".join(ink._terminal.out)  # noqa: SLF001
    assert joined == DCS_REPORTS + ECS
    ink.stop()
    assert ink._terminal.out[-1].count(DCS_REPORTS) == 1  # noqa: SLF001


def test_the_screen_is_not_active_while_lent_to_an_editor():
    ink = InkApp(alt_screen=False, mouse=False)
    assert not ink.active
    ink._running = True  # noqa: SLF001
    assert ink.active
    ink._suspended = True  # noqa: SLF001
    assert not ink.active


def _quiet_app(tmp_path, monkeypatch, name="a"):
    monkeypatch.delenv("COLORFGBG", raising=False)
    monkeypatch.setattr(theme, "query_terminal_palette", lambda timeout=0.25: DARK + ({},))
    theme.init_palette_from_terminal("auto")
    return _app(_sub(tmp_path, name), monkeypatch)


def test_the_session_follows_the_terminal_when_it_changes(tmp_path: Path, monkeypatch):
    app = _quiet_app(tmp_path, monkeypatch)
    assert theme.palette().is_dark
    app._handle_input(ColorReportEvent(slot=10, color=LIGHT[0]))  # noqa: SLF001
    app._handle_input(ColorReportEvent(slot=11, color=LIGHT[1]))  # noqa: SLF001
    app._theme_watch.flush()  # noqa: SLF001
    assert not theme.palette().is_dark
    assert theme.palette().bg_hex == LIGHT[1]


def test_following_the_terminal_paints_what_starting_in_that_theme_paints(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("COLORFGBG", raising=False)
    monkeypatch.setattr(theme, "query_terminal_palette", lambda timeout=0.25: LIGHT + ({},))
    theme.init_palette_from_terminal("auto")
    started = _app(_sub(tmp_path, "a"), monkeypatch)
    started._transcript.append_message(" › hello")  # noqa: SLF001
    expected = _paint(started)

    monkeypatch.setattr(theme, "query_terminal_palette", lambda timeout=0.25: DARK + ({},))
    theme.init_palette_from_terminal("auto")
    followed = _app(_sub(tmp_path, "b"), monkeypatch)
    followed._transcript.append_message(" › hello")  # noqa: SLF001
    followed._handle_input(ColorReportEvent(slot=10, color=LIGHT[0]))  # noqa: SLF001
    followed._handle_input(ColorReportEvent(slot=11, color=LIGHT[1]))  # noqa: SLF001
    followed._theme_watch.flush()  # noqa: SLF001
    got = _paint(followed)

    def styles(rows):  # the header shows the folder, which differs; the footer holds the receipt
        return [[cell[1] for cell in row] for i, row in enumerate(rows) if i < len(rows) - 2]

    assert styles(got) == styles(expected)


def test_a_forced_theme_ignores_the_terminal(tmp_path: Path, monkeypatch):
    app = _quiet_app(tmp_path, monkeypatch)
    app._on_submit("/themes dark")  # noqa: SLF001
    app._handle_input(ColorReportEvent(slot=10, color=LIGHT[0]))  # noqa: SLF001
    app._handle_input(ColorReportEvent(slot=11, color=LIGHT[1]))  # noqa: SLF001
    app._theme_watch.flush()  # noqa: SLF001
    assert theme.palette().is_dark


def test_auto_picks_up_what_the_terminal_became_while_the_theme_was_forced(tmp_path: Path, monkeypatch):
    app = _quiet_app(tmp_path, monkeypatch)
    app._on_submit("/themes light")  # noqa: SLF001
    assert not theme.palette().is_dark
    app._on_submit("/themes auto")  # noqa: SLF001
    assert theme.palette().is_dark  # the cached reading of the terminal
    assert app._theme_watch.mode == "auto"  # noqa: SLF001
    assert app._app.color_scheme_reports  # noqa: SLF001
    app._on_submit("/themes light")  # noqa: SLF001
    assert not app._app.color_scheme_reports  # noqa: SLF001


def test_terminal_is_still_accepted_as_the_name_of_auto(tmp_path: Path, monkeypatch):
    app = _quiet_app(tmp_path, monkeypatch)
    app._on_submit("/themes terminal")  # noqa: SLF001
    assert app.settings.theme == "auto"
    assert load_settings(app.home).theme == "auto"


def test_old_settings_files_say_terminal_and_mean_auto(tmp_path: Path):
    import json

    from circle.settings import CircleSettings, save_settings

    save_settings(CircleSettings(), tmp_path)
    path = tmp_path / "settings.json"
    raw = json.loads(path.read_text())
    for written, meant in (("terminal", "auto"), ("dark", "dark"), ("light", "light"), ("weird", "auto")):
        raw["theme"] = written
        path.write_text(json.dumps(raw))
        assert load_settings(tmp_path).theme == meant
