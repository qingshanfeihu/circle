"""GFM in the live transcript and expanded agent reasoning."""

from __future__ import annotations

import re

import pytest

from circle.ink.components.markdown_renderer import MarkdownRenderer
from circle.ink.string_width import char_width, string_width
from circle.ink.theme import palette, sgr_join
from circle.tui.agent_detail import render_detail_lines
from circle.tui.content_blocks import render_thinking_line
from circle.tui.message_model import (
    MessageSnapshot,
    make_assistant_message,
    make_text_block,
)
from circle.tui.transcript_view import ViewOptions, render_turn

SGR = re.compile(r"\x1b\[[0-9;]*m")


def _plain(value: str) -> str:
    return SGR.sub("", value)


def _bar_columns(line: str) -> list[int]:
    position = 0
    columns = []
    for char in line:
        if char == "│":
            columns.append(position)
        position += char_width(char)
    return columns


def test_table_aligns_chinese_and_marks_the_header() -> None:
    source = ("开头\n\n| 名称 | 状态 | 数量 |\n| :--- | :---: | ---: |\n"
              "| 虚拟服务 | 正常运行 | 12 |\n| 甲 | 待检查 | 3 |\n\n结尾")
    rendered = MarkdownRenderer(width=36).render_streaming(source)
    lines = _plain(rendered).splitlines()
    table = [line for line in lines if line.startswith(("┌", "├", "│", "└"))]
    assert table and len({string_width(line) for line in table}) == 1
    assert string_width(table[0]) <= 36
    cells = [line for line in table if line.startswith("│")]
    assert all(_bar_columns(line) == _bar_columns(cells[0]) for line in cells)
    assert "虚拟服务" in cells[1] and "正常运行" in cells[1]
    assert palette().em in next(line for line in rendered.splitlines() if "名称" in line)
    assert "| :---" not in rendered and "开头\n\n┌" in _plain(rendered)
    assert "┘\n\n结尾" in _plain(rendered)


def test_wide_cells_wrap_without_losing_text_or_exceeding_width() -> None:
    long_text = "非常长的中文内容abcdefghijk更多中文"
    rendered = MarkdownRenderer(width=25).render_streaming(
        f"| 字段 | 说明 |\n| :--- | ---: |\n| {long_text} | 右侧 |"
    )
    lines = _plain(rendered).splitlines()
    assert all(string_width(line) <= 25 for line in lines)
    body = lines[3:-1]
    recovered = "".join(line.split("│")[1].strip() for line in body)
    assert recovered == long_text
    assert len(body) > 1


def test_alignment_markers_pad_left_center_and_right() -> None:
    lines = _plain(MarkdownRenderer(width=33).render_streaming(
        "| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |"
    )).splitlines()
    cells = [cell[1:-1] for cell in lines[-2].split("│")[1:-1]]
    padding = [(len(cell) - len(cell.lstrip()), len(cell) - len(cell.rstrip()))
               for cell in cells]
    assert padding[0][0] == 0 and padding[0][1] > 0
    assert abs(padding[1][0] - padding[1][1]) <= 1
    assert padding[2][0] > 0 and padding[2][1] == 0


@pytest.mark.parametrize("separator", ["|:-:|", "|--|", "|-|"])
def test_short_gfm_table_delimiters_are_accepted(separator: str) -> None:
    rendered = _plain(MarkdownRenderer(width=25).render_streaming(
        f"| Name |\n{separator}\n| value |"
    ))
    assert "┌" in rendered and "value" in rendered
    assert separator not in rendered


def test_table_continues_across_an_empty_row() -> None:
    rendered = _plain(MarkdownRenderer(width=25).render_streaming(
        "| A | B |\n| - | - |\n| first | row |\n|   |   |\n| last | row |"
    ))
    rows = [line for line in rendered.splitlines() if line.startswith("│")]
    assert len(rows) == 4
    assert "first" in rows[1] and "last" in rows[3]
    assert rows[2].count("│") == 3
    assert "|   |   |" not in rendered


@pytest.mark.parametrize("header,body", [
    ("| don`t | Right |", "| first | second |"),
    ("| Left | Right |", "| don`t | second |"),
])
def test_unpaired_backtick_does_not_swallow_table_pipes(header: str, body: str) -> None:
    rendered = _plain(MarkdownRenderer(width=35).render_streaming(
        f"{header}\n| - | - |\n{body}\n| later | row |"
    ))
    rows = [line for line in rendered.splitlines() if line.startswith("│")]
    assert len(rows) == 3
    assert "don`t" in rendered and "later" in rows[-1]
    assert all(row.count("│") == 3 for row in rows)


def test_tasks_and_strikethrough_keep_inline_code_literal() -> None:
    source = "- [ ] pending\n- [x] done\n1. [X] review\n\n~~removed~~ and `~~literal~~`"
    renderer = MarkdownRenderer(width=40)
    rendered = renderer.render_streaming(source)
    plain = _plain(rendered)
    assert "☐ pending" in plain and "☑ done" in plain and "1. ☑ review" in plain
    assert "[ ]" not in plain and "[x]" not in plain and "[X]" not in plain
    assert "removed and ~~literal~~" in plain
    assert re.search(r"\x1b\[[0-9;]*9mremoved", rendered)
    assert renderer.render_final(source) == rendered


def test_existing_inline_formats_still_render() -> None:
    rendered = MarkdownRenderer(width=55).render_streaming(
        "**bold** *italic* `code` [link](https://example.test)"
    )
    assert _plain(rendered) == "bold italic code link (https://example.test)"
    assert palette().em in rendered and palette().blue in rendered
    assert sgr_join(palette().text, "\x1b[3m") in rendered
    assert "\x1b[4m" in rendered
    linked_code = MarkdownRenderer(width=55).render_streaming("[use `code`](https://example.test)")
    assert _plain(linked_code) == "use code (https://example.test)"


def test_emphasis_keeps_intraword_underscores_spaced_stars_urls_and_code() -> None:
    source = ("Updated tool_result_prune.py; set CIRCLE_HOME and ANTHROPIC_API_KEY; "
              "see https://example.com/some_path_here and https://example.com/a*b*c; "
              "x = a * b * c; "
              "`inline_code * literal *`; *italic* and _italic_.")
    # Wide enough for the whole line: this test is about emphasis, not wrapping.
    rendered = MarkdownRenderer(width=240).render_streaming(source)
    assert _plain(rendered) == ("Updated tool_result_prune.py; set CIRCLE_HOME and "
                                "ANTHROPIC_API_KEY; see https://example.com/some_path_here "
                                "and https://example.com/a*b*c; "
                                "x = a * b * c; inline_code * literal *; italic and italic.")
    assert rendered.count(sgr_join(palette().text, "\x1b[3m")) == 2


def test_nested_flanking_stars_pair_inside_out() -> None:
    rendered = MarkdownRenderer(width=60).render_streaming("*foo *bar* baz*")
    assert _plain(rendered) == "foo bar baz"
    assert rendered.count(sgr_join(palette().text, "\x1b[3m")) == 3


def test_url_used_as_link_label_remains_literal() -> None:
    source = "[https://example.com/a*b*c](https://example.com/a*b*c)"
    rendered = MarkdownRenderer(width=80).render_streaming(source)
    assert _plain(rendered) == "https://example.com/a*b*c (https://example.com/a*b*c)"


@pytest.mark.parametrize("fence", ["```c++", "~~~python", "  ```c++"])
def test_fenced_code_keeps_identifier_and_arithmetic_literal(fence: str) -> None:
    source = f"- code sample\n{fence}\n  int my_var = other_var * 2 * x;\n{fence.split('c++')[0].split('python')[0]}\nafter"
    rendered = MarkdownRenderer(width=80).render_streaming(source)
    assert "int my_var = other_var * 2 * x;" in _plain(rendered)
    assert "int myvar" not in _plain(rendered)
    assert palette().blue in next(line for line in rendered.splitlines() if "int my_var" in line)
    assert "after" in _plain(rendered)


def test_partial_stream_turns_into_the_same_final_table() -> None:
    renderer = MarkdownRenderer(width=28)
    header = "| 标题 | Value |"
    separator = "| :--- | ---: |"
    assert header in _plain(renderer.render_streaming(header))
    partial = _plain(renderer.render_streaming(f"{header}\n{separator}\n| 临时 |"))
    assert "临时" in partial and "┌" in partial
    complete = f"{header}\n{separator}\n| 临时 | 10 |"
    assert renderer.render_streaming(complete) == renderer.render_final(complete)
    assert "10" in _plain(renderer.render_final(complete))


def test_escaped_pipes_code_and_fences_do_not_break_table_parsing() -> None:
    source = "| Key | Text |\n| --- | --- |\n| `a|b` | escaped\\|pipe |"
    plain = _plain(MarkdownRenderer(width=30).render_streaming(source))
    assert "a|b" in plain and "escaped|pipe" in plain
    assert all(string_width(line) <= 30 for line in plain.splitlines())
    fenced = _plain(MarkdownRenderer(width=30).render_streaming(
        "```md\n| a | b |\n| --- | --- |\n```"
    ))
    assert "| --- | --- |" in fenced and "┬" not in fenced


def test_too_many_columns_use_a_wrapped_vertical_layout() -> None:
    source = ("| A | B | C | D | E | F | G | H |\n"
              "| --- | --- | --- | --- | --- | --- | --- | --- |\n"
              "| one | two | three | four | five | six | seven | eight |")
    rendered = _plain(MarkdownRenderer(width=20).render_streaming(source))
    assert "A: one" in rendered and "H: eight" in rendered
    assert all(string_width(line) <= 20 for line in rendered.splitlines())


def test_transcript_and_expanded_agent_views_share_the_renderer() -> None:
    source = "| 中文 | Value |\n| :--- | ---: |\n| 很长的中文单元格 | 20 |\n\n- [x] 已完成 ~~旧值~~"
    snap = MessageSnapshot(messages=(make_assistant_message(
        uuid="answer", content=make_text_block(source), timestamp="",
    ),))
    transcript = _plain("\n".join(render_turn(snap, ViewOptions(width=35))))
    assert "┌" in transcript and "☑ 已完成 旧值" in transcript
    assert all(string_width(line) <= 35 for line in transcript.splitlines())

    card = {"status": "running", "start_ts": 1.0, "description": "inspect",
            "transcript": [{"kind": "thinking_body", "text": source, "chars": len(source),
                            "round": 1, "done": False}]}
    detail = _plain("\n".join(render_detail_lines(card, expanded=True, width=35)))
    assert "┌" in detail and "☑ 已完成 旧值" in detail
    main_thinking = _plain(render_thinking_line(body=source, done=False,
                                                expanded=True, width=35))
    assert "┌" in main_thinking and "☑ 已完成 旧值" in main_thinking


def test_gfm_styles_use_only_theme_colors() -> None:
    pal = palette()
    rendered = MarkdownRenderer(width=35).render_streaming(
        "| Head |\n| --- |\n| text |\n\n- [x] done\n- [ ] todo\n~~gone~~"
    )
    codes = set(SGR.findall(rendered))
    assert codes <= {pal.dim, pal.em, pal.green, pal.faint, pal.reset,
                     sgr_join(pal.faint, "\x1b[9m")}


def test_prose_wraps_between_words_and_code_keeps_its_lines() -> None:
    source = ("Fixed operator precedence in stats.py and both tests pass now.\n\n"
              "- a list item long enough to wrap under its own text\n"
              "> a quote long enough to wrap under its own bar\n\n"
              "```\nkeep this long code line exactly as it is written here\n```")
    assert _plain(MarkdownRenderer(width=24).render_streaming(source)).split("\n") == [
        "Fixed operator", "precedence in stats.py", "and both tests pass now.", "",
        "• a list item long", "  enough to wrap under", "  its own text", "",
        "│ a quote long enough to", "│ wrap under its own bar", "",
        "┌─", "  keep this long code line exactly as it is written here", "└─"]
    long_word = _plain(MarkdownRenderer(width=20).render_streaming("x " + "y" * 30)).split("\n")
    # A word wider than the line starts a new line and is cut there, as wrap-ansi does.
    assert long_word == ["x", "y" * 20, "y" * 10]
