"""Dark and light terminals: secondary text stays legible, the frame stays visible, and
``/themes`` really switches the palette."""

from __future__ import annotations

from pathlib import Path

import pytest

from circle.ink import theme
from circle.ink.components import dialog_frame
from circle.settings import load_settings
from circle.tui.transcript_view import tool_type_bg_sgr
from tests.test_slash_behaviors import _app, _snap

BACKGROUNDS = ["#10151a", "#000000", "#1e1e2e", "#f7f8fa", "#ffffff", "#fdf6e3", "#c8c8c8"]


@pytest.fixture(autouse=True)
def _restore_theme():
    saved = theme._detected  # noqa: SLF001
    yield
    theme._detected = saved  # noqa: SLF001
    theme.reset_palette()


def _hex_of(sgr: str) -> str:
    body = sgr[2:-1].split(";")
    assert body[:2] == ["38", "2"], sgr
    return "#%02x%02x%02x" % tuple(int(x) for x in body[2:5])


def _bg_hex_of(sgr: str) -> str:
    body = sgr[2:-1].split(";")
    assert body[:2] == ["48", "2"], sgr
    return "#%02x%02x%02x" % tuple(int(x) for x in body[2:5])


def _surfaces(pal) -> dict[str, str]:
    """Where secondary text is drawn: the background, the lists' panel, the tinted blocks."""
    return {"bg": pal.bg_hex, "panel": _bg_hex_of(pal.panel_bg), "read": pal.read_bg_hex,
            "write": pal.write_bg_hex, "think": pal.think_bg_hex, "agent": pal.agent_bg_hex}


SLOT_SETS = [None, {2: (0, 205, 0), 4: (0, 0, 238), 5: (205, 0, 205), 14: (0, 255, 255)},
             {2: (38, 162, 105), 4: (18, 72, 139), 5: (163, 71, 186), 14: (51, 199, 222)}]


@pytest.mark.parametrize("slots", SLOT_SETS)
@pytest.mark.parametrize("bg", BACKGROUNDS + ["#d6dee6"])
def test_secondary_text_keeps_its_contrast_on_any_background(bg, slots):
    """On the background, on the panel the lists are drawn on (their titles are faint) and in
    the tool, thinking and subagent blocks (⎿ results), whatever the terminal's colour slots."""
    fg = "#ffffff" if theme.is_dark_hex(bg) else "#000000"
    pal = theme.build_palette(fg, bg, slots)
    for name, surface in _surfaces(pal).items():
        assert theme.contrast_ratio(_hex_of(pal.dim), surface) >= 4.5, name
        assert theme.contrast_ratio(_hex_of(pal.faint), surface) >= 3.0, name


def test_the_default_palettes_keep_secondary_text_on_every_surface():
    for fg, bg in (theme.DEFAULT_DARK, theme.DEFAULT_LIGHT):
        pal = theme.build_palette(fg, bg)
        for name, surface in _surfaces(pal).items():
            assert theme.contrast_ratio(_hex_of(pal.dim), surface) >= 4.5, name
            assert theme.contrast_ratio(_hex_of(pal.faint), surface) >= 3.0, name


def test_the_light_default_palette_is_no_longer_too_pale():
    pal = theme.build_palette(*theme.DEFAULT_LIGHT)
    bg = theme.DEFAULT_LIGHT[1]
    assert theme.contrast_ratio(_hex_of(pal.faint), bg) >= 3.0


def test_dark_palette_keeps_the_original_blend_where_it_reads():
    """dim stays at 35%. faint at 55% read at 2.97:1 inside a write block, so it is one 5% step
    nearer the text; nothing else moves on dark."""
    fg, bg = theme.DEFAULT_DARK
    pal = theme.build_palette(fg, bg)
    assert _hex_of(pal.dim) == theme.mix(fg, bg, 0.35)
    assert theme.contrast_ratio(theme.mix(fg, bg, 0.55), pal.write_bg_hex) < 3.0
    assert _hex_of(pal.faint) == theme.mix(fg, bg, 0.50)


def test_frame_gradient_is_unchanged_on_dark_and_darkened_on_light():
    dark = dialog_frame._stops_for("#10151a")  # noqa: SLF001
    assert dark == dialog_frame._GRADIENT_STOPS  # noqa: SLF001
    light = dialog_frame._stops_for("#f7f8fa")  # noqa: SLF001
    assert light != dialog_frame._GRADIENT_STOPS  # noqa: SLF001
    for _pos, rgb in light:
        assert theme.contrast_ratio(theme.rgb_to_hex(rgb), "#f7f8fa") >= 3.0
    assert [p for p, _ in light] == [p for p, _ in dialog_frame._GRADIENT_STOPS]  # noqa: SLF001


def test_forced_theme_overrides_a_terminal_that_disagrees():
    theme._detected = ("#d6dee6", "#10151a", {})  # noqa: SLF001
    assert theme.apply_theme("terminal").is_dark
    assert theme.apply_theme("dark").bg_hex == "#10151a"
    forced = theme.apply_theme("light")
    assert not forced.is_dark
    assert forced.bg_hex == theme.normalize_hex(theme.DEFAULT_LIGHT[1])


def test_forced_theme_keeps_the_terminals_own_colours_when_they_agree():
    theme._detected = ("#c0caf5", "#1a1b26", {})  # noqa: SLF001
    assert theme.apply_theme("dark").bg_hex == "#1a1b26"


def test_a_terminal_that_cannot_be_asked_follows_the_setting(monkeypatch):
    monkeypatch.delenv("COLORFGBG", raising=False)
    theme._detected = None  # noqa: SLF001
    assert theme.apply_theme("terminal").is_dark
    assert not theme.apply_theme("light").is_dark
    assert theme.apply_theme("dark").is_dark
    assert theme.apply_theme("nonsense").is_dark  # unknown names behave like terminal


def test_themes_command_switches_the_palette_now(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("COLORFGBG", raising=False)
    theme._detected = None  # noqa: SLF001
    app = _app(tmp_path, monkeypatch)
    app._on_submit("/themes light")  # noqa: SLF001
    assert not theme.palette().is_dark
    assert app.settings.theme == "light"
    assert load_settings(app.home).theme == "light"
    app._on_submit("/themes dark")  # noqa: SLF001
    assert theme.palette().is_dark
    app._on_submit("/themes nope")  # noqa: SLF001
    assert app.settings.theme == "dark"
    assert "Unknown theme" in _snap(app)


def test_session_start_uses_the_saved_theme(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("COLORFGBG", raising=False)
    monkeypatch.setattr(theme, "query_terminal_palette", lambda timeout=0.25: None)
    app = _app(tmp_path, monkeypatch)
    app.settings.theme = "light"
    from circle.tui.session_app import CircleSessionApp
    again = CircleSessionApp(app.settings, app.workspace, home=app.home, model_override=app.model_override)
    assert not theme.palette().is_dark
    assert again.settings.theme == "light"


def _sub(root: Path, name: str) -> Path:
    path = root / name
    path.mkdir()
    return path


def _paint(app, width: int = 90, height: int = 30) -> list[list[tuple[str, tuple[str, ...]]]]:
    """Every cell of the session screen as (character, style codes)."""
    from circle.ink.layout.engine import compute_layout
    from circle.ink.output import Output
    from circle.ink.render import render_tree
    from circle.ink.screen import CharPool, Screen, StylePool

    ink = app._app  # noqa: SLF001
    ink._width, ink._height = width, height  # noqa: SLF001
    ink.before_render()
    compute_layout(ink.root, width, height)
    chars, styles = CharPool(), StylePool()
    screen = Screen(width, height, chars, styles)
    out = Output(width, height, chars, styles, screen)
    render_tree(ink.root, out, chars, styles)
    out.apply()
    rows = []
    for y in range(height):
        row = []
        for x in range(width):
            cell = screen.get_cell(x, y)
            row.append((chars.get(cell.char_id) if cell.char_id else " ", tuple(styles.get(cell.style_id))))
        rows.append(row)
    return rows


def test_switching_live_paints_the_same_screen_as_starting_in_that_theme(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("COLORFGBG", raising=False)
    monkeypatch.setattr(theme, "query_terminal_palette", lambda timeout=0.25: None)

    def scene(app):
        app._transcript.append_message(" › hello")  # noqa: SLF001
        app._transcript.append_message(" ⏺ hi there")  # noqa: SLF001
        app._plan_panel.update(  # noqa: SLF001
            [{"content": "Read", "status": "completed"}, {"content": "Write", "status": "pending"}], width=90)

    def late(app):
        # What is stamped with a colour when it is created: a card cannot be open while you type
        # /themes, so these are always created under the palette that is current.
        app._begin_exec_approval({  # noqa: SLF001
            "tool": "edit_file", "title": "edit_file", "body": "/todo.py",
            "preview": [{"text": "+1 -1", "tone": ""}, {"text": "-  1  a = 1", "tone": "removed"},
                        {"text": "+  1  a = 2", "tone": "added"}],
            "policy": "changes files in the workspace", "allow_always": True,
            "scope": "file changes inside the workspace", "more": 0,
            "tint": tool_type_bg_sgr("edit_file")})

    monkeypatch.setenv("COLORFGBG", "0;15")  # a light terminal that cannot be asked
    theme.reset_palette()
    started_light = _app(_sub(tmp_path, "a"), monkeypatch)
    assert not theme.palette().is_dark
    scene(started_light)
    late(started_light)
    expected = _paint(started_light)

    monkeypatch.delenv("COLORFGBG")
    theme.reset_palette()
    switched = _app(_sub(tmp_path, "b"), monkeypatch)
    assert theme.palette().is_dark
    scene(switched)
    switched._on_submit("/themes light")  # noqa: SLF001
    late(switched)
    got = _paint(switched)

    # The header shows the folder, which differs between the two apps, so compare styles only.
    # The switched app also carries the one-line receipt of the command; mask that row.
    receipt = {i for i, row in enumerate(got) if "Theme →" in "".join(cell[0] for cell in row)}
    assert receipt

    def styles(rows):
        return [None if i in receipt else [cell[1] for cell in row] for i, row in enumerate(rows)]

    assert styles(got) == styles(expected)


def test_reload_applies_a_theme_edited_in_settings_json(tmp_path: Path, monkeypatch):
    import json

    monkeypatch.delenv("COLORFGBG", raising=False)
    theme._detected = None  # noqa: SLF001
    app = _app(tmp_path, monkeypatch)
    assert theme.palette().is_dark
    path = app.home / "settings.json"
    raw = json.loads(path.read_text())
    raw["theme"] = "light"
    path.write_text(json.dumps(raw))
    app._on_submit("/reload")  # noqa: SLF001
    assert not theme.palette().is_dark
