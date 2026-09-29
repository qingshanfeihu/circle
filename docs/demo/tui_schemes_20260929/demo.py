"""Circle TUI 方案 demo：十一个标准场景，每个区一页，ANSI 直出。

这是设计稿，不是从组件生成的：文字排版（卡片、计划块、在途条）由本脚本自己画，只借用了 ink 的
Output / Screen 写屏、theme 调色板、灯和彩虹框的取色函数。真实界面以 circle/ 里的组件为准，
契约见 docs/development/tui-contract.md；两者有出入时以契约和组件为准。

用法（仓根下）：

    ~/.venvs/circle-main/bin/python docs/demo/tui_schemes_20260929/demo.py show [--lang en|zh]   # 幻灯片 ←→ 翻页 q 退出
    ~/.venvs/circle-main/bin/python docs/demo/tui_schemes_20260929/demo.py <场景|all> [--width N] [--lang en|zh]

分区（先定这个，字形颜色都是它的下游）：

  转录     发生过的事：你的话、模型的话、思考、工具与结果、状态变更通知、终帧、回合用量。永久，滚动。
  常驻     正在成立的状态：页眉、页脚、模式词、忙碌词、子代理条。状态在就显示，消失就撤，不进历史。
  计划区   模型维护的活文档，独立一区：对话框上方一个封闭块（方角，和圆角的焦点框区分），
           默认 5 个完整行，窗口跟随当前项，滚轮翻看（幻灯片里 ↑↓ 也行），下沿右角标 2–6 / 14。
           对话框接管期间整块隐藏，答完恢复——轮到你的时候屏幕上只有问题。
  对话框   阻塞回合、必须由你回答的问题：审批、提问、机密录入、trust。接管唯一的框，答完恢复。
  弹窗     不阻塞回合的选择列表：/models、/resume、斜杠补全、/approvals。框上方，panel 底，选完或 esc 即撤。
  页面     整屏接管的只读视图：子代理详情。esc 回主视图，底部栈不动。
  一闪     操作回执：已复制、草稿已保存。页脚右侧 1.2 秒，不进历史。

宽度与对齐：

  宽度     每帧读真实列数。≥ 100 标准；< 100 收缩：页眉只留身份、子代理条先缩「在做什么」列。
  换行/截断 正文（你的话、模型的话、问题、命令、选项、通知）换行，续行对齐所在行的文字列，绝不截断。
           状态行（工具行、结果摘要、计划行、子代理行、页眉、页脚、忙碌词）单行，超宽按优先级截断：
           先丢右侧整个组件，再截可变段（参数、在做什么、路径从左截保留尾巴），灯、名字、数字永不截。
  对齐     列按显示宽度算（中文 2 格）。左：标记列 1、文字列 3、子行连接符 3、子文字 5；框内各 +1。
           右：靠右的东西统一止于倒数第 2 列（页眉提示、页脚一闪、顶栏按钮、模式词、子代理行计量）。
           数字列右对齐；名字列按本屏最长者定宽；铺底色或在框内的行补空格到整宽，块才是矩形。

装置：

  灯 ●     一行的状态：黄闪跑着 / 绿成了 / 红败了 / 青常亮等你 / 不点没跑。
  底色     一块是谁的：读蓝 / 写绿（含 Bash）/ 思考与计划洋红 / 子代理青。
  彩虹     轮到谁：流动是模型的回合，黄色静止是你的回合，淡色是空闲。
  框       只有一个；边框上只放两个状态词——忙碌词左上、模式词右下（read-only / auto，默认逐项审批不显示）。
  口吻     界面词英文、小写、短；内容不翻。键位提示只在页眉右侧和有内容被折起的地方（`· ctrl+o`）。
           ↑↓ 自带 tokens 含义不写单位。
"""
from __future__ import annotations

import argparse
import os
import re
import select
import shutil
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from circle.ink import theme  # noqa: E402
from circle.ink.components.dialog_frame import _color_at, _sgr, build_loop_frame  # noqa: E402
from circle.ink.string_width import string_width  # noqa: E402

LANG = "en"
COMPACT_MAX = 100          # 低于此宽进入收缩态
PLAN_ROWS = 5              # 计划块默认显示的完整行数
PLAN_SPAN: tuple[int, int] | None = None   # 本帧计划块占的屏幕行区间（滚轮命中用）
SCENES = ("idle", "working", "lamps", "permit", "ask", "popup", "plan", "agents", "detail", "abort", "now")
TITLES = {
    "idle": "静默 → 模式词 read-only",
    "working": "进行中 → 忙碌词 · auto",
    "lamps": "灯的五态 → 图例",
    "permit": "审批 → 对话框",
    "ask": "提问 → 对话框",
    "popup": "选模型 → 弹窗",
    "plan": "计划区 → 封闭块 · 5 行 · 滚轮 / ↑↓ 翻看",
    "agents": "子代理 → 常驻条",
    "detail": "子代理详情 → 页面",
    "abort": "中止与出错 → 转录 · 一闪",
    "now": "改前（对照，画的是旧界面）",
}

Seg = tuple[str, str]  # (text, sgr)
_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_T0 = time.monotonic()


def _t(zh: str, en: str) -> str:
    return en if LANG == "en" else zh


def _elapsed() -> float:
    return time.monotonic() - _T0


# ---------------------------------------------------------------------------
# 宽度：测量、截断、换行、补齐
# ---------------------------------------------------------------------------

def _w(text: str) -> int:
    return string_width(_ANSI.sub("", text))


def _fit(text: str, width: int, keep: str = "head") -> str:
    """截断到 width 格，… 收尾。keep="tail" 保留尾巴（路径用），… 打头。"""
    if width <= 0:
        return ""
    if _w(text) <= width:
        return text
    if width == 1:
        return "…"
    if keep == "tail":
        out: list[str] = []
        col = 0
        for ch in reversed(text):
            cw = string_width(ch)
            if col + cw > width - 1:
                break
            out.append(ch)
            col += cw
        return "…" + "".join(reversed(out))
    out = []
    col = 0
    for ch in text:
        cw = string_width(ch)
        if col + cw > width - 1:
            break
        out.append(ch)
        col += cw
    return "".join(out) + "…"


def _pad(text: str, width: int, align: str = "left") -> str:
    gap = width - _w(text)
    if gap <= 0:
        return text
    return text + " " * gap if align == "left" else " " * gap + text


def _wrap(text: str, width: int) -> list[str]:
    """按显示宽度换行；拉丁词尽量在空格断，中文逐字断。"""
    if width <= 0 or _w(text) <= width:
        return [text]
    lines: list[str] = []
    cur: list[str] = []
    col = 0
    last_space = -1
    for ch in text:
        cw = string_width(ch)
        if col + cw > width:
            if last_space > 0 and (len(cur) - last_space) < width * 0.4 and ch.isascii():
                lines.append("".join(cur[:last_space]).rstrip())
                cur = cur[last_space + 1:]
            else:
                lines.append("".join(cur))
                cur = []
            col = string_width("".join(cur))
            last_space = -1
        cur.append(ch)
        col += cw
        if ch == " ":
            last_space = len(cur) - 1
    if cur:
        lines.append("".join(cur))
    return [ln for ln in lines if ln.strip()] or [""]


def row(pal, width: int, segs: list[Seg], bg: str = "", pad: bool = False) -> str:
    """段列依次着色；最后放不下的段按尾截断；有底色或 pad 时补空格到整宽；行尾 reset。"""
    parts: list[str] = []
    used = 0
    for text, sgr in segs:
        room = width - used
        if room <= 0:
            break
        text = _fit(text, room)
        used += _w(text)
        code = theme.sgr_join(bg, sgr) if bg else sgr
        parts.append(f"{code}{text}" if code else f"{pal.reset}{text}")
    if used < width and (bg or pad):
        parts.append(f"{bg or pal.reset}{' ' * (width - used)}")
    parts.append(pal.reset)
    return "".join(parts)


def line(pal, width: int, marker: Seg, text: list[Seg], bg: str = "", indent: int = 0) -> str:
    """标记列 1 + 文字列 3；indent 把整行右移（框内 1）。"""
    return row(pal, width, [(" " * (1 + indent), ""), marker, (" ", ""), *text], bg=bg)


def prose(pal, width: int, marker: Seg, text: str, sgr: str, bg: str = "", indent: int = 0) -> list[str]:
    """正文：换行，续行对齐文字列，绝不截断。"""
    col = 3 + indent
    out = []
    for i, ln in enumerate(_wrap(text, width - col - 1)):
        if i == 0:
            out.append(line(pal, width, marker, [(ln, sgr)], bg=bg, indent=indent))
        else:
            out.append(row(pal, width, [(" " * col, ""), (ln, sgr)], bg=bg))
    return out


def child(pal, width: int, text: list[Seg], bg: str = "") -> str:
    """子行：连接符 ⎿ 列 3，子文字列 5。"""
    return row(pal, width, [("   ", ""), ("⎿", "\x1b[2m"), (" ", ""), *text], bg=bg)


def _split(pal, width: int, left: list[Seg], right: list[Seg], bg: str = "") -> str:
    """左右两组，右组止于倒数第 2 列；放不下时右组整个丢，左组尾截。"""
    lw = sum(_w(t) for t, _ in left)
    rw = sum(_w(t) for t, _ in right)
    if right and lw + rw + 2 <= width:
        return row(pal, width, [*left, (" " * (width - lw - rw - 1), ""), *right, (" ", "")], bg=bg, pad=True)
    return row(pal, width, left, bg=bg, pad=bool(bg))


# ---------------------------------------------------------------------------
# 装置
# ---------------------------------------------------------------------------

def lamp(state: str) -> Seg:
    if state == "wait":
        return (theme.LIGHT_GLYPH, theme.SGR_BLUE)
    raw = theme.status_light(state, now=time.monotonic(), reset=False)
    if raw == " ":
        return (" ", "")
    code, glyph = raw.rsplit("m", 1)
    return (glyph, code + "m")


def tint_of(pal, tool_name: str) -> str:
    if tool_name in ("Read", "Grep", "Glob", "Ls", "WebFetch"):
        return pal.read_bg
    if tool_name in ("Edit", "Write", "Bash", "Patch"):
        return pal.write_bg
    if tool_name == "Task":
        return pal.agent_bg
    if tool_name == "Question":
        return pal.think_bg
    return ""


def _edge(pal, width: int, *, top: bool, elapsed: float | None, word: str = "", word_sgr: str = "",
          border_sgr: str = "") -> str:
    perimeter = 2 * (width + 1)
    corners = ("╭", "╮") if top else ("╰", "╯")
    glyphs = [corners[0], *["─"] * (width - 2), corners[1]]
    label = f" {word} " if word else ""
    label_at = 3 if top else width - 2 - _w(label)
    base = border_sgr or pal.faint
    parts: list[str] = []
    col = 0
    while col < width:
        if label and col == label_at:
            parts.append(f"{pal.reset}{word_sgr or base}{label}")
            col += _w(label)
            continue
        if elapsed is None:
            parts.append(f"{base}{glyphs[col]}")
        else:
            parts.append(_sgr(_color_at(col if top else 2 * width - col, perimeter, elapsed)) + glyphs[col])
        col += 1
    parts.append(pal.reset)
    return "".join(parts)


def frame(pal, width: int, inner: list[str], *, turn: str, busy: str = "", mode: str = "",
          mode_sgr: str = "") -> list[str]:
    """唯一的框。turn ∈ idle / model / you。inner 已是 width-2 宽的整行。"""
    if turn == "model":
        el = _elapsed()
        top = build_loop_frame(width, elapsed=el, label=f" {busy} ")[0]
        side_l = _sgr(_color_at(2 * width + 1, 2 * (width + 1), el)) + "│" + pal.reset
        side_r = _sgr(_color_at(width, 2 * (width + 1), el)) + "│" + pal.reset
        bottom = _edge(pal, width, top=False, elapsed=el, word=mode, word_sgr=mode_sgr)
    else:
        border = pal.yellow if turn == "you" else pal.faint
        top = _edge(pal, width, top=True, elapsed=None, border_sgr=border)
        side_l = side_r = f"{border}│{pal.reset}"
        bottom = _edge(pal, width, top=False, elapsed=None, word=mode, word_sgr=mode_sgr, border_sgr=border)
    return [top, *[f"{side_l}{ln}{side_r}" for ln in inner], bottom]


# ---------------------------------------------------------------------------
# 转录行
# ---------------------------------------------------------------------------

def user(pal, width: int, text: str) -> list[str]:
    return prose(pal, width, ("›", pal.blue), text, pal.em)


def thought(pal, width: int, secs: str, title: str = "") -> str:
    segs: list[Seg] = [(_t(f"思考 {secs}", f"Thought {secs}"), pal.reason)]
    if title:
        segs.append((f" · {title}", pal.reason_dim))
    return line(pal, width, ("∴", pal.reason), segs, bg=pal.think_bg)


def answer(pal, width: int, paragraphs: list[str]) -> list[str]:
    out: list[str] = []
    for i, para in enumerate(paragraphs):
        marker = ("⏺", pal.text) if i == 0 else (" ", "")
        out += prose(pal, width, marker, para, pal.text)
    return out


def tool(pal, width: int, state: str, name: str, arg: str, tail: str = "", indent: int = 0) -> str:
    """工具行：灯 · 名字 · (参数) · 尾注。超宽先截参数，灯、名字、尾注不截。"""
    fixed = 1 + indent + 1 + 1 + _w(name) + 2 + (2 + _w(tail) if tail else 0) + 1
    arg = _fit(arg, width - fixed)
    segs: list[Seg] = [(name, pal.text), (f"({arg})", pal.dim)]
    if tail:
        segs.append((f"  {tail}", theme.SGR_BLUE if state == "wait" else pal.dim))
    return line(pal, width, lamp(state), segs, bg=tint_of(pal, name), indent=indent)


def result(pal, width: int, name: str, text: str, sgr: str = "") -> str:
    return child(pal, width, [(text, sgr or pal.dim)], bg=tint_of(pal, name))


def more(pal, width: int, name: str, n: int) -> str:
    return row(pal, width, [("     ", ""), (_t(f"… 还有 {n} 行 · ctrl+o", f"… +{n} lines · ctrl+o"), pal.dim)],
               bg=tint_of(pal, name))


def cooked(pal, width: int, secs: str, up: str, down: str) -> str:
    return row(pal, width, [("   ", ""), (f"{secs} · ↑ {up} · ↓ {down}", pal.dim)])


def mark(pal, width: int, glyph_sgr: str, text: str, sgr: str) -> list[str]:
    return prose(pal, width, ("✖", glyph_sgr), text, sgr)


def notice(pal, width: int, text: str) -> list[str]:
    return prose(pal, width, (" ", ""), text, pal.faint)


# ---------------------------------------------------------------------------
# 常驻 / 计划区 / 对话框 / 弹窗 / 页面 / 一闪
# ---------------------------------------------------------------------------

def header(pal, width: int) -> list[str]:
    ident = " circle 0.1.0 · qwen3.8-flash · "
    path = "~/Public/circle"
    hint = _t("? 快捷键", "? for shortcuts")
    room = width - _w(ident) - _w(hint) - 2
    if room < 8:  # 收缩态：只留身份，路径从左截
        return [row(pal, width, [(ident + _fit(path, width - _w(ident) - 1, keep="tail"), pal.dim)]), ""]
    return [_split(pal, width, [(ident + _fit(path, room, keep="tail"), pal.dim)], [(hint, pal.faint)]), ""]


def footer(pal, width: int, flash: str = "") -> str:
    return _split(pal, width, [(" ↑ 36.6k · ↓ 560 · ¥0.0145 · ctx 1%", pal.dim)],
                  [(flash, pal.faint)] if flash else [])


def composer(pal, width: int, draft: str = "", *, turn: str, busy: str = "", mode: str = "",
             mode_sgr: str = "") -> list[str]:
    if turn == "model":
        inner = row(pal, width - 2, [(" ", ""), ("›", pal.faint)], pad=True)
    else:
        inner = row(pal, width - 2, [(" ", ""), ("›", pal.blue), (" ", ""), (draft, pal.text), ("▍", pal.text)],
                    pad=True)
    return frame(pal, width, [inner], turn=turn, busy=busy, mode=mode, mode_sgr=mode_sgr)


PLAN_ITEMS = ["检查环境", "梳理需求", "阅读现有代码", "设计方案", "搭建基础结构", "实现核心逻辑", "编写接口",
              "补充错误处理", "编写单元测试", "运行测试并修复", "整理文档", "代码审查", "性能检查", "提交并总结"]
PLAN_DONE, PLAN_CUR = 3, 4


def _plan_state(n: int) -> str:
    return "ok" if n <= PLAN_DONE else ("running" if n == PLAN_CUR else "none")


_plan_offset: int | None = None   # None ＝ 跟随当前项


def _plan_default_offset() -> int:
    return max(0, min(PLAN_CUR - 1 - 2, len(PLAN_ITEMS) - PLAN_ROWS))


def plan_scroll(delta: int) -> None:
    global _plan_offset
    cur = _plan_offset if _plan_offset is not None else _plan_default_offset()
    _plan_offset = max(0, min(cur + delta, len(PLAN_ITEMS) - PLAN_ROWS))


def plan_box(pal, width: int) -> list[str]:
    """计划区：封闭块。方角淡边，标题嵌上沿，PLAN_ROWS 个完整行，窗口跟随当前项，
    下沿右角标可见范围；内部铺洋红（计划是模型自己的东西）。"""
    n = len(PLAN_ITEMS)
    rows = min(PLAN_ROWS, n)
    off = _plan_offset if _plan_offset is not None else _plan_default_offset()
    off = max(0, min(off, n - rows))
    F = pal.faint
    g, gs = lamp("running")
    title = _t(f"计划 {PLAN_DONE}/{n}", f"Plan {PLAN_DONE}/{n}")
    head_w = 3 + 1 + 1 + _w(title) + 1
    top = (f"{F}┌─ {pal.reset}{gs}{g}{pal.reset}{pal.text} {title} {pal.reset}"
           f"{F}{'─' * max(0, width - head_w - 1)}┐{pal.reset}")
    side = f"{F}│{pal.reset}"
    out = [top]
    for j in range(off, off + rows):
        k = j + 1
        sgr = pal.dim if k <= PLAN_DONE else (pal.em if k == PLAN_CUR else pal.text)
        out.append(side + line(pal, width - 2, lamp(_plan_state(k)), [(f"{k:>2}  {PLAN_ITEMS[j]}", sgr)],
                               bg=pal.think_bg) + side)
    rng = f" {off + 1}–{off + rows} / {n} " if n > rows else ""
    bottom = f"{F}└{'─' * max(0, width - 2 - _w(rng) - 2)}{pal.reset}{pal.dim}{rng}{pal.reset}{F}{'─' * 2 if rng else ''}┘{pal.reset}"
    if rng:
        bottom = f"{F}└{'─' * max(0, width - 4 - _w(rng))}{pal.reset}{pal.dim}{rng}{pal.reset}{F}─┘{pal.reset}"
    out.append(bottom)
    return out


def card(pal, width: int, name: str, title: str, body: list[str], options: list[str], focus: int) -> list[str]:
    """对话框：标题行（等你灯）、正文（换行不截）、空行、竖排选项（换行不截）。框内网格 = 标记列 1、文字列 3。"""
    w = width - 2
    tint = tint_of(pal, name)
    inner = [line(pal, w, lamp("wait"), [(title, pal.em)], bg=tint)]
    for i, text in enumerate(body):
        for ln in _wrap(text, w - 4):
            inner.append(row(pal, w, [("   ", ""), (ln, pal.text if i == 0 else pal.dim)], bg=tint))
    inner.append(row(pal, w, [], pad=True))
    for i, label in enumerate(options):
        on = i == focus
        for k, ln in enumerate(_wrap(label, w - 4)):
            key = str(i + 1) if k == 0 else " "
            if on:
                inner.append(row(pal, w, [(f" {key} {ln}", theme.sgr_join(pal.sel_bg, pal.em))], bg=pal.sel_bg))
            else:
                inner.append(row(pal, w, [(" ", ""), (key, pal.dim), (" ", ""), (ln, pal.text)], pad=True))
    return frame(pal, width, inner, turn="you")


def popup(pal, width: int, title: str, rows: list[tuple[str, str, bool]], focus: int) -> list[str]:
    out = [row(pal, width, [(" ", ""), (title, pal.faint)], bg=pal.panel_bg)]
    name_w = max(_w(n) for n, _, _ in rows) + 3
    for i, (name, meta, current) in enumerate(rows):
        tag = _t(" · 当前", " · current") if current else ""
        if i == focus:
            out.append(row(pal, width, [(f"   {_pad(name, name_w)}{meta}{tag}", theme.sgr_join(pal.sel_bg, pal.em))], bg=pal.sel_bg))
        else:
            out.append(row(pal, width, [("   ", ""), (_pad(name, name_w), pal.text), (meta + tag, pal.dim)], bg=pal.panel_bg))
    return out


def strip(pal, width: int, rows: list[tuple[str, str, str, str]], selected: int = -1) -> list[str]:
    """子代理条：名字列按本屏最长者定宽，计量列右对齐止于倒数第 2 列，「在做什么」列吃剩余并先缩。"""
    out = [row(pal, width, [(" ", ""), (_t(f"子代理 · {len(rows)}", f"Agents · {len(rows)}"), pal.faint)], bg=pal.panel_bg)]
    name_w = max(_w(n) for _, n, _, _ in rows)
    meta_w = max(_w(m) for _, _, _, m in rows)
    doing_w = width - 3 - name_w - 2 - meta_w - 2 - 1
    for i, (state, name, doing, meta) in enumerate(rows):
        bg = pal.sel_bg if i == selected else pal.agent_bg
        segs: list[Seg] = [(_pad(name, name_w), pal.text), ("  ", ""), (_pad(_fit(doing, doing_w), doing_w), pal.text),
                           ("  ", ""), (_pad(meta, meta_w, "right"), pal.dim)]
        out.append(line(pal, width, lamp(state), segs, bg=bg))
    return out


def band(pal, width: int, state: str, name: str, task: str, meta: str) -> str:
    """页面顶栏：该子代理的灯 + 身份在左、纯文字按钮在右（按钮永不丢，身份截）。"""
    buttons = _t("主视图 · 上一个 · 下一个", "main · prev · next")
    ident = _fit(f"{name} · {task} · {meta}", width - 3 - _w(buttons) - 3)
    return _split(pal, width, [(" ", ""), lamp(state), (" ", ""), (ident, pal.em)], [(buttons, pal.dim)],
                  bg=pal.panel_bg)


# ---------------------------------------------------------------------------
# 共享 mock 会话
# ---------------------------------------------------------------------------

CMD = "pytest tests/test_quicksort.py -q"
AGENT_ROWS = [("running", "explore", "在读 circle/tui/reducer.py", "12s · 3.1k tokens"),
              ("running", "explore", "在找没有 tests/ 对应的模块", "4s · 0.8k tokens")]


def transcript_base(pal, w: int) -> list[str]:
    L: list[str] = []
    L += user(pal, w, "给 quicksort.py 补上类型标注，写一组 pytest 测试")
    L.append("")
    L.append(thought(pal, w, "6.3s", "先看现有实现再决定测试粒度"))
    L += answer(pal, w, ["先读一下现有实现。"])
    L.append("")
    L.append(tool(pal, w, "ok", "Read", "quicksort.py"))
    L.append(result(pal, w, "Read", _t("31 行", "31 lines")))
    L.append(tool(pal, w, "ok", "Grep", "pytest · pyproject.toml"))
    L.append(result(pal, w, "Grep", '[tool.pytest.ini_options] testpaths = ["tests"]'))
    L.append("")
    L += answer(pal, w, ["实现是经典的三路划分。给函数签名加上 list[int] -> list[int]，"
                         "测试放到 tests/test_quicksort.py，覆盖空表、重复元素、已排序和随机三种输入。"])
    L.append("")
    L.append(tool(pal, w, "ok", "Edit", "quicksort.py"))
    L.append(result(pal, w, "Edit", "+2 −1  def quicksort(arr: list[int]) -> list[int]:"))
    L.append(tool(pal, w, "ok", "Write", "tests/test_quicksort.py"))
    L.append(result(pal, w, "Write", "+18  tests/test_quicksort.py", pal.green))
    L.append(row(pal, w, [("     ", ""), ("+ def test_sorts_random_ints():", pal.green)], bg=pal.write_bg))
    L.append(row(pal, w, [("     ", ""), ("+     data = [3, 1, 2]", pal.green)], bg=pal.write_bg))
    L.append(more(pal, w, "Write", 15))
    return L


def scene_lines(pal, width: int, scene: str) -> tuple[list[str], list[str]]:
    """返回 (转录区行, 底部栈行)。计划块是底部栈的第一件（前面留 1 空行）。"""
    tw = width
    T = transcript_base(pal, tw)
    B: list[str] = []

    def plan_rows(expanded: bool = False) -> list[str]:
        # 对话框接管（等你）期间计划块隐藏，答完恢复。
        if scene in ("lamps", "permit", "ask"):
            return [""]
        return ["", *plan_box(pal, width)]

    done_answer = answer(pal, tw, ["类型标注和测试都写好了。要我现在跑一遍 pytest 吗？"])

    if scene == "idle":
        T += ["", *done_answer, cooked(pal, tw, "41s", "58.2k", "1.9k")]
        B = [*plan_rows(), *composer(pal, width, turn="idle", mode="read-only", mode_sgr=pal.green), footer(pal, width)]

    elif scene == "working":
        T += ["", thought(pal, tw, "1.2s", "跑一遍测试确认"), *answer(pal, tw, ["跑一遍测试。"]), "",
              tool(pal, tw, "running", "Bash", CMD)]
        B = [*plan_rows(), *composer(pal, width, turn="model", busy="Brewing… · 12.4s · ↓ 1.9k",
                                         mode="auto", mode_sgr=pal.yellow), footer(pal, width)]

    elif scene == "lamps":
        T = [*notice(pal, tw, _t("灯 · 一行的状态，五态", "Lamp · the state of one row, five states")), ""]
        T.append(tool(pal, tw, "running", "Bash", CMD, tail=_t("跑着 · 黄，闪", "running · yellow, blinking")))
        T.append(tool(pal, tw, "ok", "Read", "quicksort.py", tail=_t("成了 · 绿", "ok · green")))
        T.append(tool(pal, tw, "error", "Bash", CMD, tail=_t("败了 · 红", "error · red")))
        T.append(tool(pal, tw, "wait", "Bash", CMD, tail=_t("等你 · 青，常亮", "waiting for you · cyan, steady")))
        T.append(tool(pal, tw, "none", "Bash", CMD, tail=_t("没跑 · 不点", "not run · unlit")))
        T.append("")
        T += notice(pal, tw, _t("同一盏灯也用在计划、子代理条和对话框标题上；青灯把「等你」和「跑着」分开。",
                                "The same lamp marks the plan, the agent strip and the dialog title; cyan keeps waiting apart from running."))
        B = [*plan_rows(), *card(pal, width, "Bash", _t("Bash 需要你的许可", "Bash needs your permission"),
                                     [f"$ {CMD}", _t("在 ~/Public/circle 里执行 · 本会话第一次遇到 pytest",
                                                    "Runs in ~/Public/circle · first pytest call this session")],
                                     [_t("允许一次", "Allow once"), _t("本会话 pytest 开头的命令不再问", "Allow pytest… for this session"),
                                      _t("拒绝并说明", "Reject and explain")], 0),
             footer(pal, width)]
        B += strip(pal, width, [("wait", "explore", "在等 Bash 审批", "12s · 3.1k tokens"), AGENT_ROWS[1]])

    elif scene == "permit":
        T += ["", tool(pal, tw, "wait", "Bash", CMD, tail=_t("等你", "waiting for you"))]
        B = [*plan_rows(), *card(pal, width, "Bash", _t("Bash 需要你的许可", "Bash needs your permission"),
                                     [f"$ {CMD}", _t("在 ~/Public/circle 里执行 · 本会话第一次遇到 pytest",
                                                    "Runs in ~/Public/circle · first pytest call this session")],
                                     [_t("允许一次", "Allow once"), _t("本会话 pytest 开头的命令不再问", "Allow pytest… for this session"),
                                      _t("拒绝并说明", "Reject and explain")], 0),
             footer(pal, width, _t("草稿已保存", "Draft saved"))]

    elif scene == "ask":
        T += ["", tool(pal, tw, "wait", "Question", "测试放哪", tail=_t("等你", "waiting for you"))]
        B = [*plan_rows(), *card(pal, width, "Question", _t("模型想确认一件事", "The model has a question"),
                                     ["tests/ 目录不存在。测试文件放哪里？"],
                                     ["新建 tests/ 目录", "和 quicksort.py 放一起", _t("自己回答", "Type your own")], 0),
             footer(pal, width)]

    elif scene == "popup":
        T += ["", *done_answer, cooked(pal, tw, "41s", "58.2k", "1.9k")]
        B = [*plan_rows(),
             *popup(pal, width, _t("模型", "Models"),
                    [("qwen3.8-flash", "anthropic", True), ("glm-5.3", "anthropic", False),
                     ("claude-sonnet-5-5", "anthropic", False), ("deepseek-v4", "openai", False)], 0),
             *composer(pal, width, "/models", turn="idle", mode="read-only", mode_sgr=pal.green), footer(pal, width)]

    elif scene == "plan":
        T += ["", *done_answer, cooked(pal, tw, "41s", "58.2k", "1.9k")]
        T += ["", *notice(pal, tw, _t("计划块默认跟随当前项；在块上滚滚轮（或按 ↑↓）翻看，下沿右角是可见范围。",
                                       "The plan box follows the current item; wheel over it (or ↑↓) to scroll, the range sits bottom-right."))]
        B = [*plan_rows(), *composer(pal, width, turn="idle", mode="read-only", mode_sgr=pal.green), footer(pal, width)]

    elif scene == "agents":
        T += ["", *answer(pal, tw, ["测试通过。顺手查一下仓库里还有哪些没标注的函数，分两路。"]), ""]
        T.append(tool(pal, tw, "running", "Task", "explore · 找出未标注的公开函数"))
        T.append(result(pal, tw, "Task", _t("explore · 3 次调用 · 12s · 3.1k tokens", "explore · 3 calls · 12s · 3.1k tokens")))
        T.append(row(pal, tw, [("     ", ""), lamp("ok"), (" Grep(def .*\\(.*\\):)", pal.dim)], bg=pal.agent_bg))
        T.append(row(pal, tw, [("     ", ""), lamp("running"), (" Read(circle/tui/reducer.py)", pal.dim)], bg=pal.agent_bg))
        T.append(tool(pal, tw, "running", "Task", "explore · 找出没有测试的模块"))
        T.append(result(pal, tw, "Task", _t("explore · 1 次调用 · 4s · 0.8k tokens", "explore · 1 call · 4s · 0.8k tokens")))
        B = [*plan_rows(), *composer(pal, width, turn="model", busy="Pondering… · 14.0s · ↓ 3.9k"), footer(pal, width)]
        B += strip(pal, width, AGENT_ROWS)

    elif scene == "detail":
        T = [band(pal, tw, "running", "explore", "找出未标注的公开函数", "12s · 3.1k tokens"), ""]
        T.append(thought(pal, tw, "2.1s", "先找所有 def，再逐个看签名"))
        T.append(tool(pal, tw, "ok", "Grep", "def .*\\(.*\\):"))
        T.append(result(pal, tw, "Grep", _t("41 处 · 12 个文件", "41 matches · 12 files")))
        T.append(tool(pal, tw, "ok", "Read", "circle/tui/reducer.py"))
        T.append(result(pal, tw, "Read", _t("380 行", "380 lines")))
        T.append(tool(pal, tw, "running", "Read", "circle/tui/session_app.py"))
        B = [*plan_rows(), *composer(pal, width, turn="model", busy="Pondering… · 14.0s · ↓ 3.9k"), footer(pal, width)]
        B += strip(pal, width, AGENT_ROWS, selected=0)

    elif scene == "abort":
        T += ["", tool(pal, tw, "error", "Bash", CMD),
              result(pal, tw, "Bash", "exit 1 · FAILED test_sorts_random_ints - AssertionError", pal.red),
              *mark(pal, tw, pal.red, _t("模型接口返回 502，重试 3 次后放弃", "Model endpoint returned 502 · gave up after 3 retries"), pal.text),
              cooked(pal, tw, "58s", "61.0k", "2.2k"), "",
              *user(pal, tw, "先别跑了，我看看断言"), "",
              thought(pal, tw, "0.8s"),
              *mark(pal, tw, pal.dim, _t("已中止", "Interrupted"), pal.dim),
              cooked(pal, tw, "2s", "0.4k", "0")]
        B = [*plan_rows(), *composer(pal, width, "把随机测试改成固定种子", turn="idle"),
             footer(pal, width, _t("草稿已恢复", "Draft restored"))]

    elif scene == "now":
        T += ["", line(pal, tw, (" ", ""), [(f"Bash({CMD})", pal.text), ("  等待审批", pal.dim)]),
              row(pal, tw, [("  ✻ Cooked for 41s · ↑ 58.2k · ↓ 1.9k tokens", pal.dim)]), "",
              line(pal, tw, ("⏺", pal.em), [("Plan · 3/14 complete", pal.em)]), ""]
        for n, name in enumerate(PLAN_ITEMS[:10], 1):
            st = "done" if n <= 3 else ("cur" if n == 4 else "")
            g = {"done": ("●", pal.green), "cur": ("◉", pal.yellow)}.get(st, ("○", pal.dim))
            T.append(row(pal, tw, [("   ", ""), g, (f" 步骤{n}: {name}", pal.dim if st == "done" else pal.text)]))
        T.append(row(pal, tw, [("   … 下面还有 4 项", pal.dim)]))
        B = ["", line(pal, width, ("△", pal.yellow), [("Permission required", pal.em)]),
             row(pal, width, [("   ◆ ", pal.dim), ("execute", pal.text)]),
             row(pal, width, [(f"   $ {CMD}", pal.text)]),
             row(pal, width, [("   runs a command in the workspace", pal.dim)]), "",
             row(pal, width, [("   ", ""), ("Allow once", pal.yellow), ("  ", ""), ("Allow always", pal.faint),
                              ("  ", ""), ("Reject", pal.faint)]),
             row(pal, width, [("   ⇆ select · enter confirm", pal.faint)]),
             row(pal, width, [(" " * (width - 8), ""), ("PERMIT", pal.faint)])]
        t, l, r, b = build_loop_frame(width, elapsed=_elapsed(), label="Brewing… · 53.1s · ↓ 1.9k tokens")
        B += [t, f"{l}{row(pal, width - 2, [(' > ', pal.text)], pad=True)}{r}", b,
              row(pal, width, [(" ↑ 36.6k · ↓ 560 tokens · qwen3.8-flash · ¥0.0145 · CH63.6% CTX 12.5k/1.0M (1%)", pal.dim)])]
    return T, B


# ---------------------------------------------------------------------------
# 页面组装与渲染：Output → Screen → diff → ANSI
# ---------------------------------------------------------------------------

def render(pal, width: int, lines: list[str]) -> str:
    from circle.ink.output import Output
    from circle.ink.screen import CharPool, Screen, StylePool, diff_screens

    cp, sp = CharPool(), StylePool()
    height = len(lines) + 2
    screen = Screen(width, height, cp, sp)
    out = Output(width, height, cp, sp, screen)
    for y, ln in enumerate(lines):
        if ln:
            out.write(0, y, ln)
    out.apply()
    ops = diff_screens(Screen(width, height, cp, sp), screen, sp, cp)
    by_row: dict[int, list] = {}
    for op in ops:
        by_row.setdefault(op.y, []).append(op)
    parts: list[str] = []
    for r in range(len(lines)):
        for op in by_row.get(r, ()):
            if op.x > 0:
                parts.append(f"\x1b[{op.x + 1}G")
            parts.append(op.content)
        parts.append("\x1b[0m\n")
    return "".join(parts)


def page(pal, width: int, height: int, scene: str, *, banner: bool) -> str:
    global PLAN_SPAN
    T, B = scene_lines(pal, width, scene)
    lines: list[str] = []
    if banner:
        idx = SCENES.index(scene) + 1
        lines.append(row(pal, width, [(f" {idx}/{len(SCENES)}  {TITLES[scene]}  ·  ←→  q ", theme.sgr_join(pal.sel_bg, pal.em))]))
    lines += header(pal, width)
    area = height - 1 - len(lines) - len(B)
    T = T[-area:] if len(T) > area else T + [""] * (area - len(T))
    lines += T
    base = len(lines)
    lines += B
    PLAN_SPAN = None
    for k, ln in enumerate(B):
        if ln.startswith(f"{pal.faint}┌─ "):
            PLAN_SPAN = (base + k, base + k + min(PLAN_ROWS, len(PLAN_ITEMS)) + 1)
            break
    return render(pal, width, lines)


# ---------------------------------------------------------------------------
# 幻灯片（实时重绘：灯会闪、彩虹会流）
# ---------------------------------------------------------------------------

def _poll_key(timeout: float) -> str:
    """timeout 秒内有输入就整段读回（按键或 SGR 鼠标序列），否则空串。"""
    fd = sys.stdin.fileno()
    ready, _, _ = select.select([fd], [], [], timeout)
    if not ready:
        return ""
    ch = os.read(fd, 1)
    if ch == b"\x1b":
        r2, _, _ = select.select([fd], [], [], 0.05)
        if r2:
            ch += os.read(fd, 32)
    return ch.decode(errors="replace")


_MOUSE = re.compile(r"\x1b\[<(\d+);(\d+);(\d+)([Mm])")


def slideshow(pal) -> int:
    import termios
    import tty

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    i = 0
    dirty = True
    try:
        tty.setraw(fd)
        sys.stdout.write("\x1b[?1000h\x1b[?1006h")   # 鼠标按键上报 + SGR 编码：滚轮走 64/65
        while True:
            cols, rows = shutil.get_terminal_size(fallback=(120, 40))
            body = page(pal, max(60, cols), rows, SCENES[i], banner=True).replace("\n", "\r\n")
            sys.stdout.write("\x1b[?2026h" + ("\x1b[2J" if dirty else "") + "\x1b[H" + body + "\x1b[?2026l")
            sys.stdout.flush()
            dirty = False
            k = _poll_key(0.2)
            if not k:
                continue
            m = _MOUSE.search(k)
            if m:
                btn, _x, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
                if btn in (64, 65) and PLAN_SPAN and PLAN_SPAN[0] <= y - 1 <= PLAN_SPAN[1]:
                    plan_scroll(-1 if btn == 64 else 1)
                continue
            if k in ("q", "\x03", "\x04"):
                sys.stdout.write("\x1b[2J\x1b[H")
                return 0
            if k == "\x1b[A":
                plan_scroll(-1)
                continue
            if k == "\x1b[B":
                plan_scroll(1)
                continue
            if k in ("\x1b[D", "b", "k"):
                i = (i - 1) % len(SCENES)
            else:
                i = (i + 1) % len(SCENES)
            dirty = True
    finally:
        sys.stdout.write("\x1b[?1000l\x1b[?1006l")
        sys.stdout.flush()
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scene", help="场景名 / show / all")
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--height", type=int, default=0)
    ap.add_argument("--lang", choices=("zh", "en"), default="en")
    args = ap.parse_args()
    global LANG
    LANG = args.lang
    theme.init_palette_from_terminal()
    pal = theme.palette()
    cols, rows = shutil.get_terminal_size(fallback=(120, 40))
    width = max(60, args.width or cols)
    height = args.height or rows
    if args.scene == "show":
        return slideshow(pal)
    scenes = SCENES if args.scene == "all" else (args.scene,)
    for s in scenes:
        if s not in SCENES:
            ap.error(f"未知场景 {s!r}")
        sys.stdout.write(page(pal, width, height, s, banner=args.scene == "all"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
