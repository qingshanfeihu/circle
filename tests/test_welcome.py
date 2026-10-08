"""The welcome block, and setup and trust asked in the session's own frame.

The welcome is the first thing in every session's transcript: the logo, the identity, what
the folder brings (each with a lamp) and its recent sessions. Setup and trust are cards in
the one frame under it, so the screen never changes between the first question and the
conversation.
"""

from __future__ import annotations

import re
import subprocess
import threading
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from circle import __version__, session_index
from circle.ink import theme
from circle.ink.components.dialog_card import CardLine, CardOption, CardSpec, card_rows
from circle.ink.components.transcript import Transcript
from circle.ink.components.welcome import (
    LOGO_ROWS,
    WelcomeInfo,
    WelcomeItem,
    logo_rows,
    welcome_rows,
)
from circle.ink.parse_keypress import KeyPress, PasteEvent
from circle.probe import ProbeResult
from circle.settings import (
    CircleSettings,
    ModelAuth,
    is_folder_trusted,
    load_settings,
    save_settings,
    trust_folder,
)
from circle.testing import ScriptedModel
from circle.trust import FolderItem, folder_inventory
from circle.tui.controllers import InitController, InitStep, TrustController, loads_summary
from circle.tui.session_app import CircleSessionApp

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def plain(rows) -> list[str]:
    return [ANSI.sub("", row).rstrip() for row in rows]


@pytest.fixture(autouse=True)
def _palette(monkeypatch):
    monkeypatch.delenv("COLORFGBG", raising=False)
    monkeypatch.delenv("CIRCLE_OAUTH_MOCK", raising=False)
    monkeypatch.setattr(theme, "query_terminal_palette", lambda timeout=0.25: None)
    saved = theme._detected  # noqa: SLF001
    theme.set_palette(theme.build_palette(*theme.DEFAULT_DARK))
    yield
    theme._detected = saved  # noqa: SLF001
    theme.reset_palette()


def _rgb(sgr: str) -> tuple[int, int, int]:
    body = sgr.split("[", 1)[1].rstrip("m").split(";")
    return tuple(int(x) for x in body[2:5])


# ── the logo ──────────────────────────────────────────────────────────────

def test_the_logo_is_the_rainbow_ring_of_logo_svg():
    rows = logo_rows()
    assert len(rows) == LOGO_ROWS
    shapes = [ANSI.sub("", row) for row in rows]
    assert all(len(shape) == LOGO_ROWS * 2 for shape in shapes)
    # round and hollow: the middle of the middle rows is empty, the rim is not
    middle = shapes[LOGO_ROWS // 2]
    assert middle[LOGO_ROWS - 1:LOGO_ROWS + 1] == "  " and middle[0] != " " and middle[-1] != " "
    assert shapes[0].strip() and shapes[-1].strip()

    def colour_at(row: int, col: int) -> tuple[int, int, int]:
        codes = re.findall(r"\x1b\[[0-9;]*m.", rows[row])
        code = codes[col]
        return _rgb(code[:-1])

    top = colour_at(0, LOGO_ROWS)                     # blue
    right = colour_at(LOGO_ROWS // 2, LOGO_ROWS * 2 - 1)  # purple
    bottom = colour_at(LOGO_ROWS - 1, LOGO_ROWS)      # red
    left = colour_at(LOGO_ROWS // 2, 0)               # orange
    assert top[2] > 200 and top[0] < 80
    assert right[0] > 150 and right[2] > 180
    assert bottom[0] > 200 and bottom[2] < 140
    assert left[0] > 200 and left[2] < 80


# ── the welcome rows ──────────────────────────────────────────────────────

def _info(**kw) -> WelcomeInfo:
    base = dict(version="0.3.1", model="glm-5.3", endpoint="open.bigmodel.cn",
                folder="~/Public/circle/compile-excel-skills", branch="main",
                items=[WelcomeItem("instructions", "AGENTS.md", "ok"),
                       WelcomeItem("skills", "3 in .circle/skills", "ok")],
                recent=[("why does the export test fail on windows?", "2h"), ("clean up", "13d")], more=6)
    base.update(kw)
    return WelcomeInfo(**base)


def test_the_welcome_shows_who_where_what_the_folder_brings_and_its_recent_sessions():
    rows = plain(welcome_rows(_info(), 100))
    text = "\n".join(rows)
    assert "circle 0.3.1" in rows[1] and "glm-5.3 · open.bigmodel.cn" in rows[2]
    assert "~/Public/circle/compile-excel-skills (main)" in rows[3]
    assert " ● instructions  AGENTS.md" in rows
    assert " ● skills        3 in .circle/skills" in rows
    assert "   recent" in rows
    assert "… +6 more · /resume" in text
    # the ages are one right-aligned column
    ages = [row for row in rows if row.endswith(("2h", "13d"))]
    assert len({len(row) for row in ages}) == 1
    assert rows[-1] == ""  # one blank row before the first message


def test_before_setup_and_trust_nothing_is_lit_and_no_model_is_named():
    info = _info(model="", endpoint="", items=[WelcomeItem("skills", "3 in .circle/skills")], recent=[], more=0)
    rows = welcome_rows(info, 100)
    text = "\n".join(plain(rows))
    assert "not connected yet" in text and "recent" not in text
    skills = next(row for row in rows if ANSI.sub("", row).startswith("   skills"))
    assert theme.LIGHT_GLYPH not in skills
    assert theme.palette().faint in skills


def test_a_failed_extension_is_a_red_lamp_with_the_reason_under_it():
    info = _info(items=[WelcomeItem("extensions", "1 in .circle/extensions", "error",
                                    ["xlsx: ModuleNotFoundError: No module named 'openpyxl'"])])
    rows = welcome_rows(info, 100)
    lamp = next(row for row in rows if "extensions" in row)
    assert theme.status_light("error") in lamp
    reason = plain(rows)[plain(rows).index(ANSI.sub("", lamp).rstrip()) + 1]
    assert reason.strip().startswith("xlsx: ModuleNotFoundError")


def test_a_narrow_terminal_drops_the_logo_and_cuts_long_titles():
    rows = plain(welcome_rows(_info(), 44))
    assert rows[0] == " circle 0.3.1"
    assert all(len(row) <= 44 for row in rows)
    assert any("…" in row and row.endswith("2h") for row in rows)
    assert not any("▟" in row or "█" in row for row in rows)


def test_the_welcome_is_drawn_in_the_palette_that_is_current():
    dark = welcome_rows(_info(), 100)
    theme.set_palette(theme.build_palette(*theme.DEFAULT_LIGHT))
    light = welcome_rows(_info(), 100)
    assert plain(dark) == plain(light)
    assert dark[1] != light[1]  # "circle" is em: white on dark, black on light


# ── what the folder brings ────────────────────────────────────────────────

def _folder(root: Path) -> Path:
    repo = root / "repo"
    ws = repo / "pkg"
    (repo / ".agents" / "skills" / "shared").mkdir(parents=True)
    (repo / ".agents" / "skills" / "shared" / "SKILL.md").write_text("---\nname: shared\ndescription: d\n---\n")
    (ws / ".circle" / "skills" / "diff").mkdir(parents=True)
    (ws / ".circle" / "skills" / "diff" / "SKILL.md").write_text("---\nname: diff\ndescription: d\n---\n")
    (ws / ".circle" / "commands").mkdir(parents=True)
    (ws / ".circle" / "commands" / "review.md").write_text("Review it")
    (ws / ".circle" / "extensions" / "xlsx").mkdir(parents=True)
    (ws / ".circle" / "extensions" / "xlsx" / "extension.py").write_text("def register(api):\n    pass\n")
    (ws / ".circle" / "settings.json").write_text("{}")
    (ws / "AGENTS.md").write_text("# rules\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    return ws


def test_the_inventory_is_what_the_session_loads_from_the_folder(tmp_path: Path):
    ws = _folder(tmp_path)
    home = tmp_path / "home"
    (home / "extensions" / "mine").mkdir(parents=True)  # yours, not the folder's
    (home / "extensions" / "mine" / "extension.py").write_text("def register(api):\n    pass\n")
    (home / "skills" / "own").mkdir(parents=True)
    (home / "skills" / "own" / "SKILL.md").write_text("---\nname: own\ndescription: d\n---\n")
    items = {item.kind: item for item in folder_inventory(ws, home)}
    assert list(items) == ["instructions", "skills", "commands", "extensions", "settings"]
    assert items["instructions"].names == ("AGENTS.md",)
    assert items["skills"].count == 2 and set(items["skills"].names) == {"diff", "shared"}  # up to the git root
    # paths inside the folder, written as the system writes them (".circle\\commands" on Windows)
    assert items["commands"].count == 1 and items["commands"].where == str(Path(".circle", "commands"))
    assert items["extensions"].names == ("xlsx",) and items["extensions"].where == str(Path(".circle", "extensions"))
    assert items["settings"].where == str(Path(".circle", "settings.json"))


def test_paths_under_your_home_folder_are_written_with_a_tilde(monkeypatch, tmp_path: Path):
    import os

    from circle.tui.controllers import _home_path

    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert _home_path(tmp_path / ".circle" / "settings.json") == "~" + os.sep + str(Path(".circle", "settings.json"))
    assert _home_path(tmp_path.parent / "elsewhere") == str(tmp_path.parent / "elsewhere")


def test_an_ordinary_folder_brings_nothing(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "README.md").write_text("hi")
    assert folder_inventory(tmp_path, tmp_path / "home") == []


def test_the_trust_card_says_what_trusting_loads(tmp_path: Path):
    ws = _folder(tmp_path)
    card = TrustController(CircleSettings(), ws, home=tmp_path / "home").card_spec()
    text = " ".join(" ".join(plain(card_rows(card, 98))).split())  # the lines wrap at 76 columns
    assert card.title == "Trust this folder?"
    assert "Trusting also loads its AGENTS.md, 2 skills, 1 command, 1 extension and its settings." in text
    assert "The extension runs its own code when circle starts." in text
    assert [opt.label for opt in card.options] == ["Trust and continue", "Quit"]
    empty = tmp_path / "plain"
    empty.mkdir()
    text = "\n".join(plain(card_rows(TrustController(CircleSettings(), empty).card_spec(), 98)))
    assert "The folder brings no instructions, skills, commands or extensions." in text


def test_the_summary_reads_as_a_sentence():
    assert loads_summary([FolderItem("skills", 1, "x")]) == "1 skill"
    assert loads_summary([FolderItem("instructions", 2, "x", ("AGENTS.md", "CLAUDE.md")),
                          FolderItem("commands", 3, "y")]) == "its AGENTS.md and CLAUDE.md and 3 commands"


# ── the transcript's head ─────────────────────────────────────────────────

def test_the_head_sits_above_the_messages_and_is_not_one_of_them():
    t = Transcript()
    t.append_message("one")
    t.set_head(["w1", "w2", ""])
    t.append_message("two")
    assert t.snapshot() == ["one", "two"] and t.message_count() == 2
    assert [child.value for child in t.node.children] == ["w1", "w2", "", "one", "two"]
    t.update_message_at(0, "ONE")
    t.replace_range(1, 1, ["2a", "2b"])
    assert [child.value for child in t.node.children] == ["w1", "w2", "", "ONE", "2a", "2b"]
    assert t.row_of(0) == 3 and t.message_at_row(0) == 0 and t.message_at_row(4) == 1
    t.set_head(["only"])
    assert [child.value for child in t.node.children] == ["only", "ONE", "2a", "2b"]
    t.clear()
    assert t.snapshot() == [] and [child.value for child in t.node.children] == ["only"]
    t.restore(["back"])
    assert [child.value for child in t.node.children] == ["only", "back"]
    t.update_last_message("BACK")
    assert t.snapshot() == ["BACK"] and t.head == ["only"]


def test_update_last_message_never_touches_the_head():
    t = Transcript()
    t.set_head(["welcome"])
    t.update_last_message("x")
    assert t.head == ["welcome"] and [child.value for child in t.node.children] == ["welcome"]


# ── the card's new parts ──────────────────────────────────────────────────

def test_a_card_can_hold_a_searched_list_a_disabled_option_and_coloured_parts():
    pal = theme.palette()
    listed = CardSpec("Which model?", body=[CardLine("", segments=(("24 models at ", "dim"), ("host", "text")))],
                      options=[CardOption("glm-5.3"), CardOption("glm-4.6v", note="vision")], focus=1,
                      keys=False, position="(2/24)", input_row=True)
    rows = card_rows(listed, 60)
    shown = plain(rows)
    assert shown[1] == "   24 models at host"
    assert pal.dim + "24 models at " in rows[1] and pal.text + "host" in rows[1]
    assert shown[3].startswith("   glm-5.3") and shown[4].startswith("   glm-4.6v") and "vision" in shown[4]
    assert pal.sel_bg in rows[4] and pal.sel_bg not in rows[3]
    assert shown[5] == "   (2/24)" and shown[6] == ""  # then the input row, one blank row apart
    menu = CardSpec("How?", options=[CardOption("API URL + KEY"),
                                     CardOption("OAuth sign-in", note="not available yet", enabled=False)])
    rows = card_rows(menu, 60)
    assert pal.faint + "OAuth sign-in" in rows[-1]
    long = CardSpec("T", body=[CardLine("word " * 30)], measure=40)
    assert max(len(row) for row in plain(card_rows(long, 98))) <= 3 + 40


def test_the_running_lamp_titles_a_card_that_waits_for_circle():
    card = CardSpec("Looking for models…", lamp="running")
    assert card_rows(card, 40, )[0] != card_rows(CardSpec("Looking for models…"), 40)[0]


# ── setup's model list ────────────────────────────────────────────────────

def test_typing_under_the_model_list_searches_it_and_enter_takes_the_marked_row(tmp_path: Path):
    init = InitController(home=tmp_path, persist=False)
    init.step, init.mode, init.status = InitStep.PICK_MODEL, "api_key", "discovered 3 models (openai)"
    init.base_url, init.models = "https://api.example/v1", ["glm-5.3", "glm-5.3-air", "kimi-k2"]
    init.set_query("glm air")
    assert [opt.label for opt in init.card_spec().options] == ["glm-5.3-air", 'use "glm air"']
    init.move_choice(1)
    init.set_query("glm-5.4")
    card = init.card_spec()
    assert [opt.label for opt in card.options] == ['use "glm-5.4"'] and card.options[0].note == "not listed"
    init.pick_choice()
    assert init.done and init.auth.model == "glm-5.4"


def test_the_model_list_shows_a_window_and_where_you_are(tmp_path: Path):
    init = InitController(home=tmp_path, persist=False)
    init.step, init.status = InitStep.PICK_MODEL, "discovered 20 models (openai)"
    init.models = [f"m{i:02d}" for i in range(20)]
    for _ in range(12):
        init.move_choice(1)
    card = init.card_spec()
    assert len(card.options) == 8 and card.options[card.focus].label == "m12"
    assert card.position == "(13/20)"


def test_oauth_is_listed_but_cannot_be_chosen_while_it_is_not_built(tmp_path: Path):
    init = InitController(home=tmp_path)
    card = init.card_spec()
    assert card.options[1].note == "not available yet" and not card.options[1].enabled
    init.move(1)
    assert init.model_focus == 0
    init.submit_line("2")
    assert init.step == InitStep.AUTH_MODE
    init.confirm()
    assert init.step == InitStep.API_URL


# ── setup and trust in the session's frame ─────────────────────────────────

def _key(app: CircleSessionApp, key: str, char: str = "") -> None:
    app._handle_key(KeyPress(key=key, char=char))  # noqa: SLF001


def _type(app: CircleSessionApp, text: str) -> None:
    for ch in text:
        _key(app, ch, ch)


def _fresh(tmp_path: Path, monkeypatch, probe=None) -> CircleSessionApp:
    """A first run: nothing set up, a folder never trusted, the screen up before connecting."""
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    (ws / "AGENTS.md").write_text("# rules\n")
    monkeypatch.setattr("circle.tui.session_app.build_chat_model",
                        lambda settings, **_kw: ScriptedModel(responses=[AIMessage(content="ok")] * 3))
    app = CircleSessionApp(load_settings(home), ws, home=home, connect=False)
    app._probe_endpoint = probe or (lambda url, key: ProbeResult("openai", ["model-a", "model-b"], base_url=url))  # noqa: SLF001
    app._welcome_on = True  # noqa: SLF001
    app._refresh_welcome_data()  # noqa: SLF001
    app._begin_gate()  # noqa: SLF001
    return app


def _card_text(app: CircleSessionApp) -> str:
    card = app._active_card()  # noqa: SLF001
    return "\n".join(plain(card_rows(card, 98))) if card is not None else ""


def _wait(condition, timeout: float = 5.0) -> None:
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        if condition():
            return
        time.sleep(0.02)
    raise AssertionError("timed out")


def test_first_run_is_answered_in_the_frame_from_setup_to_the_session(tmp_path: Path, monkeypatch):
    asked = threading.Event()
    answer = threading.Event()

    def probe(url, key):
        asked.set()
        answer.wait(5)
        return ProbeResult("openai", ["model-a", "model-b"], base_url=url, status="ok")

    app = _fresh(tmp_path, monkeypatch, probe)
    assert "How does Circle reach your model?" in _card_text(app)
    app._sync_dialog_frame()  # noqa: SLF001
    head = "\n".join(plain(app._transcript.head))  # noqa: SLF001
    assert "not connected yet" in head and "instructions  AGENTS.md" in head
    app._sync_dialog_frame()  # noqa: SLF001
    assert app._header_text.value.strip() == ""  # noqa: SLF001  the welcome says who and where
    assert app._footer.node.style.display == "none"  # noqa: SLF001  no meters before a session

    _key(app, "x", "x")  # printable keys go nowhere on a menu
    assert app._prompt.value == ""  # noqa: SLF001
    _key(app, "enter")
    assert "What is the API's base URL?" in _card_text(app)
    _type(app, "https://api.example/v1")
    _key(app, "enter")
    assert "What is the API key?" in _card_text(app) and app._prompt.masked  # noqa: SLF001
    app._handle_input(PasteEvent(text="sk-pasted"))  # noqa: SLF001
    _key(app, "enter")  # returns at once: the endpoint is asked off the input thread
    assert asked.wait(5)
    assert "Looking for models…" in _card_text(app)
    assert app._active_card().lamp == "running"  # noqa: SLF001
    answer.set()
    _wait(lambda: "Which model?" in _card_text(app))
    assert "2 models at api.example" in _card_text(app)
    _key(app, "down")
    _key(app, "enter")
    assert "Trust this folder?" in _card_text(app)
    app._sync_dialog_frame()  # noqa: SLF001
    head = "\n".join(plain(app._transcript.head))  # noqa: SLF001
    assert "model-b · api.example" in head
    assert "instructions  AGENTS.md" in head  # what trust is about stays listed above the card
    _key(app, "y", "y")
    assert app._gate is None  # noqa: SLF001
    settings = load_settings(app.home)
    assert settings.auth.model == "model-b" and is_folder_trusted(settings, app.workspace)

    app._connect_now()  # noqa: SLF001
    assert app._connected  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    head = app._transcript.head  # noqa: SLF001
    assert theme.status_light("ok") in next(row for row in head if "instructions" in row)
    assert "for shortcuts" in app._header_text.value  # noqa: SLF001
    assert app._footer.node.style.display == "flex"  # noqa: SLF001


def test_declining_trust_leaves_with_exit_code_one_and_trusts_nothing(tmp_path: Path, monkeypatch):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    save_settings(CircleSettings(initialized=True, auth=ModelAuth(
        mode="api_key", protocol="openai", base_url="https://one.example/v1", model="m1")), home)
    app = CircleSessionApp(load_settings(home), ws, home=home, connect=False)
    app._begin_gate()  # noqa: SLF001
    assert isinstance(app._gate, TrustController)  # noqa: SLF001
    app._app._running = True  # noqa: SLF001
    _key(app, "down")
    _key(app, "enter")
    assert app._gate_exit == 1 and not app._app._running  # noqa: SLF001
    assert not is_folder_trusted(load_settings(home), ws)


def _trusted(tmp_path: Path, monkeypatch) -> CircleSessionApp:
    home, ws = tmp_path / "home", tmp_path / "ws"
    (ws / ".circle" / "extensions" / "xlsx").mkdir(parents=True)
    (ws / ".circle" / "extensions" / "xlsx" / "extension.py").write_text("import no_such_module_here\n")
    settings = CircleSettings(initialized=True, auth=ModelAuth(
        mode="api_key", protocol="openai", base_url="https://one.example/v1", model="m1"))
    settings = trust_folder(settings, ws)
    save_settings(settings, home)
    for i in range(5):
        session_index.record(home, f"circle-old{i}", ws, title=f"talk {i}", model="m1")
    model = ScriptedModel(responses=[AIMessage(content=f"r{i}") for i in range(5)])
    app = CircleSessionApp(load_settings(home), ws, home=home, connect=False, model_override=model)
    app._welcome_on = True  # noqa: SLF001
    app._refresh_welcome_data()  # noqa: SLF001
    return app


def test_the_folder_rows_blink_while_connecting_and_say_what_failed_once_connected(tmp_path: Path, monkeypatch):
    app = _trusted(tmp_path, monkeypatch)
    app._connecting = True  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    row = next(r for r in app._transcript.head if "extensions" in r)  # noqa: SLF001
    assert "33m" + theme.LIGHT_GLYPH in row  # the running lamp, in its bright or its dim phase
    app._connecting = False  # noqa: SLF001
    app._connect_now()  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    head = app._transcript.head  # noqa: SLF001
    row = next(r for r in head if "extensions" in r)
    assert theme.status_light("error") in row
    assert any("xlsx: ModuleNotFoundError" in ANSI.sub("", r) for r in head)
    shown = "\n".join(plain(head))
    assert "recent" in shown and "… +2 more · /resume" in shown


def test_what_you_send_while_it_connects_is_sent_once_it_has(tmp_path: Path, monkeypatch):
    app = _trusted(tmp_path, monkeypatch)
    _type(app, "hello")
    _key(app, "enter")
    assert app._early_submits == ["hello"] and app._prompt.value == ""  # noqa: SLF001
    sent = []
    monkeypatch.setattr(app, "_on_submit", lambda text, **kw: sent.append(text))
    app._connect_now()  # noqa: SLF001
    assert sent == ["hello"] and app._early_submits == []  # noqa: SLF001


def test_the_header_takes_the_identity_once_the_welcome_scrolls_away(tmp_path: Path, monkeypatch):
    app = _trusted(tmp_path, monkeypatch)
    app._connect_now()  # noqa: SLF001
    app._app._width, app._app._height = 100, 20  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    header = ANSI.sub("", app._header_text.value)  # noqa: SLF001
    assert "circle " not in header and "for shortcuts" in header
    for i in range(60):
        app._transcript.append_message(f" line {i}")  # noqa: SLF001
    app._transcript.node.rect.width = 100  # noqa: SLF001
    app._transcript.node.rect.height = 10  # noqa: SLF001
    app._transcript.scroll_to(None)  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    header = ANSI.sub("", app._header_text.value)  # noqa: SLF001
    assert f"circle {__version__} · m1" in header and "for shortcuts" in header
