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

from ..theme import palette, rgb_to_hex, sgr_join as _sgr_join, sgr_to_rgb

_UNDERLINE = "\x1b[4m"

_NON_SGR_RE = re.compile(r"\x1b\[[0-9;]*[^m0-9;\x1b]")
_FENCE_RE = re.compile(r"^```(\w*)\s*$")
_HEADER_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_HR_RE = re.compile(r"^(\s*)([-*_])\s*\2\s*\2[\s\2]*$")
_OL_RE = re.compile(r"^(\s*)\d+\.\s+(.+)$")
_UL_RE = re.compile(r"^(\s*)[-*+]\s+(.+)$")
_QUOTE_RE = re.compile(r"^(\s*)>\s?(.*)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*|__(.+?)__")
_ITALIC_RE = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)")
_INLINE_CODE_RE = re.compile(r"`([^`]+)`")

_MODEL_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_SGR_TEXT_RE = re.compile(r"\x1b\[[0-9;]*m")


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

        for line in lines:
            fence_m = _FENCE_RE.match(line)
            if fence_m:
                if in_code:
                    _emit(self._fmt_code_block(code_lines, code_lang, pal), "code_body")
                    code_lines = []
                    code_lang = ""
                    in_code = False
                else:
                    in_code = True
                    code_lang = fence_m.group(1)
                continue
            if in_code:
                code_lines.append(line)
                continue
            rendered, role = self._render_line(line, pal)
            _emit(rendered, role)

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
            content = self._inline(ol_m.group(2), pal)
            return f"{indent}{num_prefix}. {content}", "list"

        ul_m = _UL_RE.match(line)
        if ul_m:
            indent = ul_m.group(1)
            content = self._inline(ul_m.group(2), pal)
            return f"{indent}• {content}", "list"

        return self._inline(line, pal), "text"

    def _inline(self, text: str, pal) -> str:
        text = _BOLD_RE.sub(lambda m: f"{pal.em}{m.group(1) or m.group(2)}{pal.reset}", text)
        text = _INLINE_CODE_RE.sub(lambda m: f"{pal.blue}{m.group(1)}{pal.reset}", text)
        text = _LINK_RE.sub(
            lambda m: f"{_UNDERLINE}{m.group(1)}{pal.reset} {pal.dim}({m.group(2)}){pal.reset}",
            text,
        )
        return text

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
        try:
            return self._rich_render(text)
        except Exception:
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
