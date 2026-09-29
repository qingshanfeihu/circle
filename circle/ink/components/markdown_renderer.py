"""markdown 渲染器：一切颜色只从 ``theme.palette()`` 取（2026-09-24 终版设计，demo final 模式）。

**为什么终稿不再用 rich 的 code_theme 上色**:pygments 主题（ansi_light / monokai 都是）
按自己的色表给代码涂前景/背景——写死的颜色在用户自己的深浅终端主题上必有一边糊掉
（monokai 浅灰白前景在浅底不可见、ansi_light 的黑底在浅底呈灰块阴影）。终版设计：
代码块/行内代码只铺主题 ``panel_bg`` + 正文 ``text`` 色，不做语法着色。实现上给 rich
一个按调色板现搭的 pygments Style（背景=panel_bg、根 Token=text 色；rich 对缺省
Token 前景会补 ``#000000``，必须显式给根 Token 上色）+ 一条 ``markdown.code``
控制台样式覆盖，并把 ``color_system`` 钉在 truecolor——调色板自身恒发真彩，不随
TERM/COLORTERM 降级，输出才与屏上其余 panel_bg 完全一致且与运行环境无关。
"""

from __future__ import annotations

import re
import unicodedata
from itertools import pairwise

from ..string_width import char_width, string_width
from ..theme import palette, rgb_to_hex, sgr_to_rgb
from ..theme import sgr_join as _sgr_join

_UNDERLINE = "\x1b[4m"
_STRIKE = "\x1b[9m"
_ITALIC = "\x1b[3m"

_NON_SGR_RE = re.compile(r"\x1b\[[0-9;]*[^m0-9;\x1b]")
_FENCE_RE = re.compile(r"^(?P<indent> *)(?P<fence>`{3,}|~{3,})(?P<info>.*)$")
_HEADER_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_HR_RE = re.compile(r"^(\s*)([-*_])\s*\2\s*\2[\s\2]*$")
_OL_RE = re.compile(r"^(\s*)\d+\.\s+(.+)$")
_UL_RE = re.compile(r"^(\s*)[-*+]\s+(.+)$")
_QUOTE_RE = re.compile(r"^(\s*)>\s?(.*)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_URL_RE = re.compile(r"(?<!\w)(?:https?://|www\.)[^\s<>]+")
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")
_STRIKE_RE = re.compile(r"~~(.+?)~~")
_TASK_RE = re.compile(r"^\[([ xX])\]\s+(.+)$")
_TABLE_SEPARATOR_RE = re.compile(r":?-+:?")
_BACKTICK_RUN_RE = re.compile(r"`+")
_SGR_SPLIT_RE = re.compile(r"(\x1b\[[0-9;]*m)")

_MODEL_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_SGR_TEXT_RE = re.compile(r"\x1b\[[0-9;]*m")


def _punctuation(char: str) -> bool:
    return bool(char) and unicodedata.category(char)[0] in "PS"


def _delimiter_sides(text: str, start: int, end: int, marker: str) -> tuple[bool, bool]:
    before = text[start - 1] if start else " "
    after = text[end] if end < len(text) else " "
    left = not after.isspace() and (
        not _punctuation(after) or before.isspace() or _punctuation(before)
    )
    right = not before.isspace() and (
        not _punctuation(before) or after.isspace() or _punctuation(after)
    )
    if marker == "_":
        return left and (not right or _punctuation(before)), right and (
            not left or _punctuation(after)
        )
    return left, right


def _replace_emphasis(text: str, marker: str, size: int, style: str,
                      reset: str) -> str:
    """Apply one delimiter width only where CommonMark flanking permits it."""
    runs = list(re.finditer(re.escape(marker) + "+", text))
    stack: list[re.Match[str]] = []
    pairs: list[tuple[re.Match[str], re.Match[str]]] = []
    for run in runs:
        if len(run.group()) != size:
            continue
        escape_start = run.start()
        while escape_start and text[escape_start - 1] == "\\":
            escape_start -= 1
        if (run.start() - escape_start) % 2:
            continue
        can_open, can_close = _delimiter_sides(text, run.start(), run.end(), marker)
        if can_close and stack and stack[-1].end() < run.start():
            pairs.append((stack.pop(), run))
        elif can_open:
            stack.append(run)
    if not pairs:
        return text
    opens: dict[int, int] = {}
    closes: dict[int, int] = {}
    consumed: set[int] = set()
    for opener, closer in pairs:
        opens[opener.end()] = opens.get(opener.end(), 0) + 1
        closes[closer.start()] = closes.get(closer.start(), 0) + 1
        consumed.update(range(opener.start(), opener.end()))
        consumed.update(range(closer.start(), closer.end()))
    out: list[str] = []
    depth = 0
    for index in range(len(text) + 1):
        if index in closes:
            depth -= closes[index]
            out.append(style if depth else reset)
        if index in opens:
            depth += opens[index]
            out.append(style)
        if index < len(text) and index not in consumed:
            out.append(text[index])
    return "".join(out)


def _fence_open(line: str) -> tuple[str, int, str, int] | None:
    match = _FENCE_RE.match(line)
    if match is None:
        return None
    fence = match.group("fence")
    info = match.group("info").strip()
    if fence[0] == "`" and "`" in info:
        return None
    return fence[0], len(fence), info.split(maxsplit=1)[0] if info else "", len(match.group("indent"))


def _fence_close(line: str, marker: str, count: int) -> bool:
    stripped = line.strip()
    return len(stripped) >= count and set(stripped) == {marker}


class MarkdownRenderer:
    def __init__(self, width: int = 80):
        self._width = max(width, 20)

    def set_width(self, width: int) -> None:
        self._width = max(width, 20)

    def render_streaming(self, text: str) -> str:
        if not text:
            return ""
        pal = palette()
        text = _MODEL_ANSI_RE.sub("", text)
        lines = text.split("\n")
        result: list[str] = []
        roles: list[str] = []

        def _emit(rendered: str, role: str) -> None:
            # 多行产物(代码块框)拆行入账,角色随行携带——rhythm 裁决按行做。
            for part in rendered.split("\n"):
                result.append(part)
                roles.append(role if part.strip() else "blank")

        in_code = False
        code_lines: list[str] = []
        code_lang = ""
        code_marker = ""
        code_count = 0
        code_indent = 0

        index = 0
        while index < len(lines):
            line = lines[index]
            if in_code and _fence_close(line, code_marker, code_count):
                _emit(self._fmt_code_block(code_lines, code_lang, pal), "code_body")
                code_lines = []
                code_lang = ""
                in_code = False
                index += 1
                continue
            if in_code:
                code_lines.append(line[min(len(line) - len(line.lstrip(" ")), code_indent):])
                index += 1
                continue
            fence = _fence_open(line)
            if fence is not None:
                code_marker, code_count, code_lang, code_indent = fence
                in_code = True
                index += 1
                continue
            if index + 1 < len(lines):
                table = self._table_spec(line, lines[index + 1])
                if table is not None:
                    headers, alignments = table
                    index += 2
                    rows: list[list[str]] = []
                    while index < len(lines):
                        cells = self._table_cells(lines[index])
                        if cells is None:
                            break
                        rows.append((cells + [""] * len(headers))[:len(headers)])
                        index += 1
                    _emit(self._render_table(headers, alignments, rows, pal), "table")
                    continue
            rendered, role = self._render_line(line, pal)
            _emit(rendered, role)
            index += 1

        if in_code:
            lang_tag = f"{pal.dim}```{code_lang}{pal.reset}" if code_lang else f"{pal.dim}```{pal.reset}"
            _emit(lang_tag, "code_open")
            for cl in code_lines:
                _emit(f"  {pal.blue}{cl}{pal.reset}", "code_body")

        # 与 rich 终稿的块级纵向节奏对齐(终版 P1):流式预览与落定后不跳动。
        return "\n".join(self._apply_block_rhythm(result, roles))

    @staticmethod
    def _apply_block_rhythm(lines: list[str], roles: list[str]) -> list[str]:
        """块级 margin 裁决:标题/代码块/列表/引用/分隔线的前后各 1 空行,
        块内与相邻同块 0 空行,连续空行压缩为 1——与 rich Markdown 的
        纵向节奏一致(终版 P1:流式预览与终稿落定节奏相同)。"""
        out: list[str] = []
        out_roles: list[str] = []
        for text, role in zip(lines, roles):
            plain = _SGR_TEXT_RE.sub("", text)
            if role == "code_body" and plain.startswith("┌─"):
                role = "code_open"
            elif role == "code_body" and plain.startswith("└─"):
                role = "code_close"
            if not plain.strip():
                role = "blank"
            if role == "blank":
                if out and out_roles[-1] != "blank":
                    out.append("")
                    out_roles.append("blank")
                continue
            if out and out_roles[-1] != "blank":
                prev = out_roles[-1]
                contiguous = (
                    role == prev
                    or (prev in ("code_open", "code_body")
                        and role in ("code_body", "code_close"))
                )
                if not contiguous:
                    out.append("")
                    out_roles.append("blank")
            out.append(text)
            out_roles.append(role)
        return out

    def _render_line(self, line: str, pal) -> tuple[str, str]:
        hm = _HEADER_RE.match(line)
        if hm:
            level = len(hm.group(1))
            text = self._inline(hm.group(2), pal)
            if level == 1:
                return f"{_sgr_join(pal.em, _UNDERLINE)}{text}{pal.reset}", "heading"
            elif level == 2:
                return f"{pal.em}{text}{pal.reset}", "heading"
            else:
                return f"{pal.dim}{text}{pal.reset}", "heading"

        if _HR_RE.match(line):
            return f"{pal.dim}{'─' * min(self._width, 40)}{pal.reset}", "hr"

        qm = _QUOTE_RE.match(line)
        if qm:
            indent = qm.group(1)
            content = self._inline(qm.group(2), pal)
            return f"{indent}{pal.dim}│{pal.reset} {content}", "quote"

        ol_m = _OL_RE.match(line)
        if ol_m:
            indent = ol_m.group(1)
            num_prefix = line[len(indent):].split(".", 1)[0]
            content = self._list_content(ol_m.group(2), pal)
            return f"{indent}{num_prefix}. {content}", "list"

        ul_m = _UL_RE.match(line)
        if ul_m:
            indent = ul_m.group(1)
            content = self._list_content(ul_m.group(2), pal)
            prefix = "" if _TASK_RE.match(ul_m.group(2)) else "• "
            return f"{indent}{prefix}{content}", "list"

        return self._inline(line, pal), "text"

    def _inline(self, text: str, pal) -> str:
        # Keep inline code literal: emphasis and deletion markers inside it are text.
        code: list[str] = []
        links: list[tuple[str, str]] = []
        urls: list[str] = []

        def protect(match: re.Match[str]) -> str:
            code.append(f"{pal.blue}{match.group(1)}{pal.reset}")
            return f"\ufff0{len(code) - 1}\ufff1"

        text = _INLINE_CODE_RE.sub(protect, text)

        def protect_link(match: re.Match[str]) -> str:
            links.append((match.group(1), match.group(2)))
            return f"\ufff2{len(links) - 1}\ufff3"

        text = _LINK_RE.sub(protect_link, text)

        def protect_url(match: re.Match[str]) -> str:
            urls.append(match.group())
            return f"\ufff4{len(urls) - 1}\ufff5"

        text = _URL_RE.sub(protect_url, text)

        def emphasis(value: str) -> str:
            for marker in ("*", "_"):
                value = _replace_emphasis(value, marker, 2, pal.em, pal.reset)
            value = _STRIKE_RE.sub(
                lambda m: f"{_sgr_join(pal.faint, _STRIKE)}{m.group(1)}{pal.reset}", value)
            for marker in ("*", "_"):
                value = _replace_emphasis(value, marker, 1,
                                          _sgr_join(pal.text, _ITALIC), pal.reset)
            return value

        text = emphasis(text)
        for index, (label, url) in enumerate(links):
            styled_label = emphasis(_URL_RE.sub(protect_url, label))
            styled = f"{_UNDERLINE}{styled_label}{pal.reset} {pal.dim}({url}){pal.reset}"
            text = text.replace(f"\ufff2{index}\ufff3", styled)
        for index, styled in enumerate(code):
            text = text.replace(f"\ufff0{index}\ufff1", styled)
        for index, url in enumerate(urls):
            text = text.replace(f"\ufff4{index}\ufff5", url)
        return text

    def _list_content(self, text: str, pal) -> str:
        task = _TASK_RE.match(text)
        if task is None:
            return self._inline(text, pal)
        checked = task.group(1).lower() == "x"
        mark = f"{pal.green if checked else pal.dim}{'☑' if checked else '☐'}{pal.reset}"
        return f"{mark} {self._inline(task.group(2), pal)}"

    @staticmethod
    def _code_span_end(raw: str, start: int) -> int:
        """Only a matching backtick run makes pipes inside a code span literal."""
        opener = _BACKTICK_RUN_RE.match(raw, start)
        if opener is None:
            return 0
        for closer in _BACKTICK_RUN_RE.finditer(raw, opener.end()):
            if len(closer.group()) == len(opener.group()) and (
                closer.start() == 0 or raw[closer.start() - 1] != "\\"
            ):
                return closer.end()
        return 0

    @staticmethod
    def _table_cells(line: str) -> list[str] | None:
        raw = line.strip()
        if "|" not in raw:
            return None
        cells: list[str] = []
        current: list[str] = []
        code_end = 0
        separators = 0
        trailing_separator = False
        index = 0
        while index < len(raw):
            char = raw[index]
            if char == "\\" and index + 1 < len(raw) and raw[index + 1] == "|":
                current.append("|")
                index += 2
                continue
            if char == "`" and index >= code_end and (
                index == 0 or raw[index - 1] != "\\"
            ):
                code_end = MarkdownRenderer._code_span_end(raw, index)
            if char == "|" and index >= code_end:
                cells.append("".join(current).strip())
                current = []
                separators += 1
                trailing_separator = index == len(raw) - 1
            else:
                current.append(char)
            index += 1
        cells.append("".join(current).strip())
        if raw.startswith("|"):
            cells.pop(0)
        if trailing_separator:
            cells.pop()
        return cells if separators else None

    @classmethod
    def _table_spec(cls, header: str, separator: str) -> tuple[list[str], list[str]] | None:
        headers = cls._table_cells(header)
        markers = cls._table_cells(separator)
        if not headers or not markers or len(headers) != len(markers):
            return None
        if not all(_TABLE_SEPARATOR_RE.fullmatch(marker) for marker in markers):
            return None
        aligns = ["center" if marker.startswith(":") and marker.endswith(":")
                  else "right" if marker.endswith(":") else "left" for marker in markers]
        return headers, aligns

    @staticmethod
    def _visible_width(text: str) -> int:
        return string_width(_SGR_TEXT_RE.sub("", text))

    @staticmethod
    def _wrap_styled(text: str, width: int, reset: str) -> list[str]:
        parts: list[str] = []
        current = ""
        active = ""
        used = 0
        for token in _SGR_SPLIT_RE.split(text):
            if not token:
                continue
            if _SGR_TEXT_RE.fullmatch(token):
                current += token
                active = "" if token == reset else token
                continue
            for char in token:
                cell_width = char_width(char)
                if used and used + cell_width > width:
                    parts.append(current + (reset if active else ""))
                    current = active
                    used = 0
                current += char
                used += cell_width
        parts.append(current)
        return parts

    @staticmethod
    def _column_widths(desired: list[int], budget: int) -> list[int]:
        widths = [min(value, max(2, budget // len(desired))) for value in desired]
        remaining = budget - sum(widths)
        while remaining > 0 and any(width < want for width, want in zip(widths, desired)):
            for index, want in enumerate(desired):
                if remaining == 0:
                    break
                if widths[index] < want:
                    widths[index] += 1
                    remaining -= 1
        return widths

    def _render_table(self, headers: list[str], alignments: list[str],
                      rows: list[list[str]], pal) -> str:
        count = len(headers)
        budget = self._width - (3 * count + 1)
        if budget < 2 * count:
            # A terminal too narrow for one character per column gets a vertical
            # key/value layout, still without clipping any cell content.
            vertical = []
            for row in rows or [[""] * count]:
                for header, cell in zip(headers, row):
                    styled = f"{pal.em}{header}{pal.reset}: {self._inline(cell, pal)}"
                    vertical.extend(self._wrap_styled(styled, self._width, pal.reset))
            return "\n".join(vertical)
        styled = [[self._inline(cell, pal) for cell in row] for row in [headers, *rows]]
        desired = [max(2, *(self._visible_width(row[col]) for row in styled))
                   for col in range(count)]
        widths = self._column_widths(desired, budget)

        def rule(left: str, middle: str, right: str) -> str:
            return f"{pal.dim}{left}{middle.join('─' * (width + 2) for width in widths)}{right}{pal.reset}"

        def render_row(cells: list[str], *, heading: bool) -> list[str]:
            wrapped = [self._wrap_styled(f"{pal.em}{cell}{pal.reset}" if heading else cell,
                                         width, pal.reset)
                       for cell, width in zip(cells, widths)]
            result = []
            for line_index in range(max(map(len, wrapped))):
                fragments = []
                for col, width in enumerate(widths):
                    part = wrapped[col][line_index] if line_index < len(wrapped[col]) else ""
                    gap = width - self._visible_width(part)
                    align = alignments[col]
                    left = gap if align == "right" else gap // 2 if align == "center" else 0
                    fragments.append(f" {' ' * left}{part}{' ' * (gap - left)} ")
                result.append(f"{pal.dim}│{pal.reset}" +
                              f"{pal.dim}│{pal.reset}".join(fragments) +
                              f"{pal.dim}│{pal.reset}")
            return result

        lines = [rule("┌", "┬", "┐"), *render_row(styled[0], heading=True),
                 rule("├", "┼", "┤")]
        for row in styled[1:]:
            lines.extend(render_row(row, heading=False))
        lines.append(rule("└", "┴", "┘"))
        return "\n".join(lines)

    def _fmt_code_block(self, lines: list[str], lang: str, pal) -> str:
        parts: list[str] = []
        if lang:
            parts.append(f"{pal.dim}┌─ {lang}{pal.reset}")
        else:
            parts.append(f"{pal.dim}┌─{pal.reset}")
        for ln in lines:
            parts.append(f"  {pal.blue}{ln}{pal.reset}")
        parts.append(f"{pal.dim}└─{pal.reset}")
        return "\n".join(parts)

    def render_final(self, text: str) -> str:
        if not text:
            return ""
        lines = text.splitlines()
        if (_STRIKE_RE.search(text) or any(_TASK_RE.match(match.group(2))
                                            for line in lines
                                            if (match := _UL_RE.match(line) or _OL_RE.match(line)))
                or any(self._table_spec(first, second) is not None
                       for first, second in pairwise(lines))):
            return self.render_streaming(text)
        try:
            return self._rich_render(text)
        except Exception:  # noqa: BLE001 — rich is optional; streaming renderer is the fallback
            return self.render_streaming(text)

    def _rich_render(self, text: str) -> str:
        from io import StringIO

        from pygments.style import Style as _PygStyle
        from pygments.token import Token as _PygToken
        from rich.console import Console
        from rich.markdown import Markdown
        from rich.style import Style as _RichStyle
        from rich.theme import Theme as _RichTheme

        pal = palette()
        panel_rgb = sgr_to_rgb(pal.panel_bg)
        if panel_rgb is None:
            raise ValueError(f"panel_bg 不是真彩 SGR: {pal.panel_bg!r}")
        panel_hex = rgb_to_hex(panel_rgb)
        fg_hex = pal.fg_hex

        # 按调色板现搭的"零语法色"代码主题：背景=panel_bg，全部 Token 用正文色。
        code_style = type(
            "_PaletteCodeStyle",
            (_PygStyle,),
            {"background_color": panel_hex, "styles": {_PygToken: fg_hex}},
        )
        console_theme = _RichTheme(
            {"markdown.code": _RichStyle(color=fg_hex, bgcolor=panel_hex)}
        )

        buf = StringIO()
        console = Console(
            file=buf,
            width=self._width,
            force_terminal=True,
            no_color=False,
            color_system="truecolor",
            theme=console_theme,
            highlight=False,
        )
        md = Markdown(text, code_theme=code_style)
        console.print(md, end="")
        rendered = buf.getvalue()
        rendered = _NON_SGR_RE.sub("", rendered)
        return rendered.rstrip("\n")
