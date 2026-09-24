"""Colors come from ``theme.palette()`` only, retired glyphs stay retired (ported from
InfoTest ``tests/tui/test_glyph_scheme_b.py``), and the E8a fixes: error lines, the
selection background, merged inline SGR, the quiet dialog frame and the shimmer switch.

Scanning goes through ``ast`` and looks only at string constants that can reach the
screen; comments and docstrings may name a retired glyph to explain why it is retired.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from circle.ink import theme
from circle.ink.components import dialog_frame
from circle.ink.components.markdown_renderer import MarkdownRenderer

ROOT = Path(__file__).resolve().parents[1] / "circle"
RENDER_FILES: tuple[Path, ...] = tuple(sorted((ROOT / "ink" / "components").glob("*.py"))) + tuple(
    ROOT / "tui" / name for name in (
        "session_app.py", "agent_strip.py", "content_blocks.py", "slash_commands.py",
        "harness_bridge.py"))
# theme.py 是取色唯一真源；dialog_frame.py 的彩虹渐变是唯一登记的例外
WHITELIST = frozenset({ROOT / "ink" / "theme.py", ROOT / "ink" / "components" / "dialog_frame.py"})
COLOR_FILES = tuple(p for p in RENDER_FILES if p not in WHITELIST)

HEX_RE = re.compile(r"#[0-9a-fA-F]{6}\b")
TRUECOLOR_RE = re.compile(r"(?:38|48);2;")
FORBIDDEN_SGR = ("\x1b[31m", "\x1b[32m", "\x1b[33m", "\x1b[34m", "\x1b[35m", "\x1b[36m",
                 "\x1b[2m", "\x1b[2;34m", "\x1b[2;9m", "\x1b[5m")


def _docstrings(tree: ast.AST) -> set[int]:
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", None) or []
            if (body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant)
                    and isinstance(body[0].value.value, str)):
                ids.add(id(body[0].value))
    return ids


def screen_strings(path: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    skip = _docstrings(tree)
    return [(n.lineno, n.value) for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in skip]


@pytest.mark.parametrize("path", COLOR_FILES, ids=lambda p: p.name)
def test_colors_come_from_the_palette(path: Path):
    hits = [(ln, t) for ln, t in screen_strings(path)
            if HEX_RE.search(t) or TRUECOLOR_RE.search(t) or any(s in t for s in FORBIDDEN_SGR)]
    assert not hits, f"{path.name} hardcodes colors: {hits}"


@pytest.mark.parametrize("path", RENDER_FILES, ids=lambda p: p.name)
def test_retired_glyphs_stay_retired(path: Path):
    hits = [(ln, t) for ln, t in screen_strings(path)
            if any(g in t for g in theme.RETIRED_GLYPHS) or "[error]" in t or "[interrupted]" in t]
    assert not hits, f"{path.name} renders retired glyphs: {hits}"


def test_the_scanner_catches_what_it_should(tmp_path: Path):
    probe = tmp_path / "probe.py"
    probe.write_text('"""docstring may say ✓ and #ff0000."""\n'
                     'A = "✓ done"\nB = "\\x1b[38;2;1;2;3m"\nC = "#ff0000"\nD = "\\x1b[2m"\n',
                     encoding="utf-8")
    values = [t for _, t in screen_strings(probe)]
    assert any("✓" in v for v in values) and any(TRUECOLOR_RE.search(v) for v in values)
    assert any(HEX_RE.search(v) for v in values) and any("\x1b[2m" in v for v in values)
    assert not any("docstring" in v for v in values)


@pytest.fixture
def light_palette():
    theme.reset_palette()
    theme.set_palette(theme.build_palette("#3c4148", "#f7f8fa"))
    yield theme.palette()
    theme.reset_palette()


def test_sgr_join_merges_codes_into_one_sequence():
    assert theme.sgr_join("\x1b[48;5;1m", "\x1b[2m", "", "not-sgr") == "\x1b[48;5;1;2m"
    assert theme.sgr_join() == ""


def test_error_and_warning_lines_use_the_palette(light_palette):
    from circle.tui import session_app

    line = session_app._error_line("boom")  # noqa: SLF001
    assert line == f" {light_palette.red}{theme.GLYPH_ERROR}{light_palette.reset} boom"
    assert session_app._warn_line("careful").startswith(f" {light_palette.yellow}△")  # noqa: SLF001
    assert session_app._faint("x") == f"{light_palette.faint}x{light_palette.reset}"  # noqa: SLF001


def test_strip_rows_carry_background_and_foreground_in_one_sgr(light_palette):
    from circle.tui.agent_strip import render_agent_strip

    rows = render_agent_strip([{"name": "explore", "action": "reading", "started": 0}],
                              width=60, now=5)
    joined = theme.sgr_join(light_palette.panel_bg, light_palette.faint)
    assert rows[1].startswith(joined)
    assert f"{light_palette.panel_bg}{light_palette.faint}" not in "".join(rows)


def test_thinking_header_merges_color_and_italic(light_palette):
    from circle.tui.content_blocks import render_thinking_line

    line = render_thinking_line(body="", done=False, expanded=False)
    assert line.startswith(" " + theme.sgr_join(light_palette.reason, "\x1b[3m"))


def test_quiet_frame_uses_the_palette_and_shimmer_off_keeps_it_quiet(light_palette, monkeypatch):
    top, left, _right, bottom = dialog_frame.build_loop_frame(20, elapsed=None)
    assert top.startswith(light_palette.faint) and left == f"{light_palette.faint}│{light_palette.reset}"
    monkeypatch.setenv("CIRCLE_TUI_SHIMMER", "0")
    busy_top, *_ = dialog_frame.build_loop_frame(20, elapsed=1.0, label="Working")
    quiet_codes = {light_palette.faint, light_palette.text, light_palette.reset}
    assert "Working" in busy_top
    assert set(re.findall(r"\x1b\[[0-9;]*m", busy_top)) <= quiet_codes
    monkeypatch.setenv("CIRCLE_TUI_SHIMMER", "1")
    rainbow_top, *_ = dialog_frame.build_loop_frame(20, elapsed=1.0, label="Working")
    assert not set(re.findall(r"\x1b\[[0-9;]*m", rainbow_top)) <= quiet_codes


def test_selection_background_is_wired_from_the_palette():
    from circle.ink.screen import StylePool

    pool = StylePool()
    assert pool._selection_bg_codes == []  # noqa: SLF001 — 接线前不写死任何色值
    source = (ROOT / "tui" / "session_app.py").read_text(encoding="utf-8")
    assert "style_pool.set_selection_bg([palette().sel_bg])" in source


def test_markdown_streaming_render_only_uses_palette_codes(light_palette):
    out = MarkdownRenderer(width=60).render_streaming("# Title\n\n**bold** and `code`\n\n- item")
    codes = set(re.findall(r"\x1b\[[0-9;]*m", out))
    allowed = {light_palette.em, light_palette.blue, light_palette.reset, light_palette.dim,
               light_palette.text, light_palette.faint, "\x1b[4m", "\x1b[1m"}
    assert codes and codes <= allowed | {c for c in codes if c.startswith(light_palette.em[:-1])}


def test_footer_sticky_error_and_warning_render_with_the_palette(light_palette):
    from circle.ink.components.footer import FooterPane

    footer = FooterPane()
    footer.update(status="error")
    footer.set_sticky_error("endpoint refused the request")
    footer.set_obs_warning("tracing off")
    status = footer._status_line.value  # noqa: SLF001
    hint = footer._hint_line.value  # noqa: SLF001
    assert f"{light_palette.red}{theme.GLYPH_ERROR} endpoint refused" in status
    assert f"{light_palette.yellow}tracing off" in hint
    footer.shutdown()
