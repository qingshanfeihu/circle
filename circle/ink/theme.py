"""ink TUI 的终端主题自适应调色板 + 全局状态灯。

**为什么不写死颜色**:用户终端主题深浅未知——实测 Ghostty 答 fg=#4c4f69 / bg=#eff1f5
(Catppuccin Latte,浅底),写死的深底灰阶放到浅底上会糊成一片、读不出层次。这里向终端查
OSC 10/11 拿真实前景/背景,其余档位按同一组混合公式从这两个端点派生——**同一套公式深浅
两种主题都成立**:派生量只沿 bg→fg(或 fg→bg)这条线段走,不做任何绝对亮度假设。

**红/黄/绿/蓝不派生**:SGR 31/33/32/36 是终端主题自己定义的 16 色槽位,直接用槽位号,
换主题自动跟随;派生出来的"红"反而会和用户主题打架。

**状态灯全局唯一一套四态**:执行中=黄且闪 / 成功=绿常亮 / 失败=红常亮 / 没执行=不点灯
(仍占一列保持对齐)。底部 strip、主对话行、详情页流水三层共用 ``status_light()``,
不得各写各的图标。

**行首字符：五个字形各管一件事（2026-09-05 用户裁决「已定 B」，07 章 §11.23）**——
此前同一屏能同时出现十三个字形，其中六个各自表示「错」。方案 B 保留有独立含义的
那几个、把重复表示「错」的收成一个:

===========  ==========================  ==================================
字形         职责                        说明
===========  ==========================  ==================================
``●``        状态灯                      有状态的行:编写、工具、进度;四态不变
``⏺``        主 agent 说话                回答块行首，占基准列
``◆``        引擎里程碑                  派发/落卷/合卷/收口一类一次性事件
``▸``        进度                        走秒的行，配转轮 ``⠋⠙⠹…``
``✖``        错与止                      终帧、启动报错、页脚黏住行;**中止**用暗色
                                         ``✖`` 与失败区分，不是另一个字形
===========  ==========================  ==================================

层级连接符 ``⎿ ↳ ⤷ ∴`` 含义不变，**只表示从属关系、不表示状态**;它们的颜色同样
只从 ``palette()``/``status_light()`` 取，不写死。

**已退役**（不得再出现在 ``ink/components`` 与 ``tui/reducer.py`` 的渲染路径上，
守门 ``tests/tui/test_glyph_scheme_b.py``）:``❌``（启动器/CLI 的 stderr 报错行改
``✖``）、``◌``（页脚「无新事件」，槽位改写真实状态）、``✓``（完成改绘绿 ``●``）、
``✗``（并入 ``✖``）、``✉``（后台任务通知卡改 ``◆``）、``[error]``（终帧改 ``✖``）、
``[interrupted]``（中止改暗色 ``✖`` +「已中止」）、``⚙``、``✶``（页脚工作中——
2026-09-24 终版 P6 起忙碌词迁入对话框上沿，不挂字形）。

用法::

    from circle.ink.theme import init_palette_from_terminal, palette, status_light

    init_palette_from_terminal()          # 进程启动、进入渲染循环之前调用一次
    p = palette()
    line = f"{status_light(state)} {p.text}{name}{p.reset}"
"""
from __future__ import annotations

import os
import re
import sys
import threading
import time
from dataclasses import dataclass

__all__ = [
    "Palette",
    "build_palette",
    "palette",
    "set_palette",
    "reset_palette",
    "init_palette_from_terminal",
    "query_terminal_colors",
    "query_terminal_palette",
    "status_light",
    "mix",
    "relative_luminance",
    "is_dark_hex",
    "hex_to_rgb",
    "rgb_to_hex",
    "fg_sgr",
    "bg_sgr",
    "sgr_to_rgb",
    "LIGHT_GLYPH",
    "GLYPH_AGENT",
    "GLYPH_MILESTONE",
    "GLYPH_PROGRESS",
    "GLYPH_ERROR",
    "RETIRED_GLYPHS",
    "LIGHT_GUTTER",
    "BLINK_PERIOD_SEC",
    "LIGHT_STATES",
    "SGR_MUTED_STRIKE",
    "GLYPH_FOOTER_BUSY",
    "marker_line",
    "child_line",
    "sgr_join",
]


SGR_RESET = "\x1b[0m"
SGR_REVERSE = "\x1b[7m"
# 主题定义的 16 色槽位:不派生、不换成真彩,换主题自动跟。
SGR_GREEN = "\x1b[32m"
SGR_YELLOW = "\x1b[33m"
SGR_RED = "\x1b[31m"
SGR_BLUE = "\x1b[36m"
# 闪烁的"暗相":必须是**单条**合并 SGR,不能写成 "\x1b[2m" + "\x1b[33m" 两条。
# 依据 output.py `Output._apply_write` 的行内 SGR 分支——ink 把行内每条 SGR 都按
# `op 基础样式 + [这一条]` 重算(`intern(base_codes + [segment])`),后一条**不叠加**在前
# 一条上;写成两条会让 dim 被 33m 顶掉、暗相和明相长得一样(灯不闪,还查不出原因)。
# 合并成 "\x1b[2;33m" 在物理终端里语义完全相同(dim + 黄前景),在 ink 里是一条码、dim 保住。
SGR_DIM_YELLOW = "\x1b[2;33m"

SGR_REASON = "\x1b[34m"
SGR_REASON_HI = "\x1b[94m"
SGR_REASON_DIM = "\x1b[2;34m"

SGR_MUTED_STRIKE = "\x1b[2;9m"

LIGHT_GLYPH = "●"
GLYPH_AGENT = "⏺"
GLYPH_MILESTONE = "◆"
GLYPH_PROGRESS = "▸"
GLYPH_ERROR = "✖"
# circle 的页脚仍用 ✶ 标工作中，不随 InfoTest 退役它。
GLYPH_FOOTER_BUSY = "✶"
RETIRED_GLYPHS: tuple[str, ...] = ("❌", "◌", "✓", "✗", "✉", "⚙")
LIGHT_GUTTER = 2
BLINK_PERIOD_SEC = 1.15
_BLINK_HALF_SEC = 0.575
LIGHT_STATES = ("running", "ok", "error", "none")


def marker_line(marker: str, text: str) -> str:
    # 行首标记列契约（2026-09-24 终版）：第 1 列页边距、标记列 1、文字列 3。
    # 只拥有间距，不拥有配色——marker/text 由调用点预着色后传入。
    return f" {marker} {text}"


def child_line(connector: str, text: str) -> str:
    # 子行连接符（⎿/↳）列 3、正文列 5：连接符与主 transcript 文字列对齐。
    # 同样只拥有间距；⎿/↳ 在全转录区只以一级子行身份出现（三级嵌套注记不用连接符）。
    return f"   {connector} {text}"


def sgr_join(*codes: str) -> str:
    """多条 SGR 合成一条(ink 行内 SGR 不叠加:底色+前景必须合并成一条再写,
    分两条写只有第一个字符有底、其余露白)。全组件唯一实现,别处不再各抄一份。"""
    params: list[str] = []
    for code in codes:
        if not code or not code.startswith("\x1b[") or not code.endswith("m"):
            continue
        body = code[2:-1]
        if body:
            params.append(body)
    return ("\x1b[" + ";".join(params) + "m") if params else ""


DEFAULT_DARK: tuple[str, str] = ("#d6dee6", "#10151a")
DEFAULT_LIGHT: tuple[str, str] = ("#3c4148", "#f7f8fa")

# 动作类型底色槽:读=4 蓝槽、写=2 绿槽、思考=5 洋红槽、agent=14 亮青槽(浅底
# 主题 4/6 槽同为灰青系不可辨,agent 改 14 槽;选槽依据记录在 07 章 §11.24)。
_TYPE_TINT_SLOTS: dict[str, tuple[int, float]] = {
    "read_bg": (4, 0.15),
    "write_bg": (2, 0.15),
    "think_bg": (5, 0.15),
    "agent_bg": (14, 0.15),
}
_TYPE_SLOT_FALLBACK_RGB: dict[int, tuple[int, int, int]] = {
    2: (60, 160, 90),
    4: (92, 120, 255),
    5: (175, 95, 175),
    14: (0, 205, 205),
}


_HEX_RE = re.compile(r"\A#?([0-9a-fA-F]+)\Z")


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    m = _HEX_RE.match(value.strip())
    if not m:
        raise ValueError(f"not a hex color: {value!r}")
    digits = m.group(1)
    if len(digits) % 3 != 0 or not 3 <= len(digits) <= 12:
        raise ValueError(f"not a hex color: {value!r}")
    n = len(digits) // 3
    scale = (1 << (4 * n)) - 1
    out: list[int] = []
    for i in range(3):
        raw = int(digits[i * n:(i + 1) * n], 16)
        out.append(int(round(raw * 255 / scale)))
    return out[0], out[1], out[2]


def rgb_to_hex(rgb: tuple[int, int, int]) -> str:
    r, g, b = (max(0, min(255, int(round(c)))) for c in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def normalize_hex(value: str) -> str:
    return rgb_to_hex(hex_to_rgb(value))


def mix(a: str, b: str, t: float) -> str:
    t = max(0.0, min(1.0, float(t)))
    ar, ag, ab = hex_to_rgb(a)
    br, bg, bb = hex_to_rgb(b)
    return rgb_to_hex((
        ar + (br - ar) * t,
        ag + (bg - ag) * t,
        ab + (bb - ab) * t,
    ))


def _linearize(channel: int) -> float:
    c = channel / 255.0
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(value: str) -> float:
    r, g, b = hex_to_rgb(value)
    return 0.2126 * _linearize(r) + 0.7152 * _linearize(g) + 0.0722 * _linearize(b)


def is_dark_hex(value: str) -> bool:
    return relative_luminance(value) < 0.5


def fg_sgr(value: str) -> str:
    r, g, b = hex_to_rgb(value)
    return f"\x1b[38;2;{r};{g};{b}m"


def bg_sgr(value: str) -> str:
    r, g, b = hex_to_rgb(value)
    return f"\x1b[48;2;{r};{g};{b}m"


_SGR_TRUECOLOR_RE = re.compile(r"\A\x1b\[(38|48);2;(\d{1,3});(\d{1,3});(\d{1,3})m\Z")


def sgr_to_rgb(seq: str) -> tuple[int, int, int] | None:
    m = _SGR_TRUECOLOR_RE.match(seq)
    if not m:
        return None
    return int(m.group(2)), int(m.group(3)), int(m.group(4))


@dataclass(frozen=True, slots=True)
class Palette:

    text: str
    dim: str
    faint: str
    em: str
    panel_bg: str
    sel_bg: str
    line: str
    outline: str
    fg_hex: str
    bg_hex: str
    is_dark: bool
    green: str = SGR_GREEN
    yellow: str = SGR_YELLOW
    red: str = SGR_RED
    blue: str = SGR_BLUE
    reason_dim: str = SGR_REASON_DIM
    reason: str = SGR_REASON
    reason_hi: str = SGR_REASON_HI
    muted_strike: str = SGR_MUTED_STRIKE
    reverse: str = SGR_REVERSE
    reset: str = SGR_RESET
    # 类型底色:hex 供 TextStyles.background_color,SGR 供行内拼装。
    read_bg: str = ""
    write_bg: str = ""
    think_bg: str = ""
    agent_bg: str = ""
    read_bg_hex: str = ""
    write_bg_hex: str = ""
    think_bg_hex: str = ""
    agent_bg_hex: str = ""


def build_palette(
    fg_hex: str,
    bg_hex: str,
    slot_rgb: dict[int, tuple[int, int, int]] | None = None,
) -> Palette:
    fg = normalize_hex(fg_hex)
    bg = normalize_hex(bg_hex)
    dark = is_dark_hex(bg)
    em_target = "#ffffff" if dark else "#000000"
    slots = slot_rgb or {}
    tints: dict[str, str] = {}
    tint_hexes: dict[str, str] = {}
    for name, (slot, ratio) in _TYPE_TINT_SLOTS.items():
        rgb = slots.get(slot, _TYPE_SLOT_FALLBACK_RGB[slot])
        tint_hex = mix(bg, rgb_to_hex(rgb), ratio)
        tint_hexes[name] = tint_hex
        tints[name] = bg_sgr(tint_hex)
    return Palette(
        text=fg_sgr(fg),
        dim=fg_sgr(mix(fg, bg, 0.35)),
        faint=fg_sgr(mix(fg, bg, 0.55)),
        em=fg_sgr(mix(fg, em_target, 0.45)),
        panel_bg=bg_sgr(mix(bg, fg, 0.06)),
        sel_bg=bg_sgr(mix(bg, fg, 0.16)),
        line=fg_sgr(mix(bg, fg, 0.22)),
        outline=fg_sgr(mix(bg, fg, 0.40)),
        fg_hex=fg,
        bg_hex=bg,
        is_dark=dark,
        read_bg=tints["read_bg"],
        write_bg=tints["write_bg"],
        think_bg=tints["think_bg"],
        agent_bg=tints["agent_bg"],
        read_bg_hex=tint_hexes["read_bg"],
        write_bg_hex=tint_hexes["write_bg"],
        think_bg_hex=tint_hexes["think_bg"],
        agent_bg_hex=tint_hexes["agent_bg"],
    )


_palette: Palette | None = None
_palette_lock = threading.Lock()


def palette() -> Palette:
    global _palette
    p = _palette
    if p is not None:
        return p
    with _palette_lock:
        if _palette is None:
            _palette = build_palette(*_fallback_colors())
        return _palette


def set_palette(p: Palette) -> None:
    global _palette
    with _palette_lock:
        _palette = p


def reset_palette() -> None:
    global _palette
    with _palette_lock:
        _palette = None


def init_palette_from_terminal(timeout: float = 0.25) -> Palette:
    got = None
    try:
        got = query_terminal_palette(timeout)
    except Exception:
        got = None
    if got:
        try:
            fg, bg, slots = got
            p = build_palette(fg, bg, slots)
            set_palette(p)
            return p
        except Exception:
            pass
    p = build_palette(*_fallback_colors())
    set_palette(p)
    return p


def _fallback_colors() -> tuple[str, str]:
    try:
        light = _colorfgbg_is_light(os.environ.get("COLORFGBG"))
    except Exception:
        light = False
    return DEFAULT_LIGHT if light else DEFAULT_DARK


def _colorfgbg_is_light(raw: str | None) -> bool:
    if not raw:
        return False
    last = raw.split(";")[-1].strip()
    if not last.isdigit():
        return False
    idx = int(last)
    if idx in (0, 1, 2, 3, 4, 5, 6, 8):
        return False
    return True


_OSC_REPLY_RE = re.compile(r"\x1b\](1[01]);([^\x07\x1b]*)(?:\x07|\x1b\\)")
_OSC4_REPLY_RE = re.compile(r"\x1b\]4;(\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)")

#: OSC 4 查询的槽号(动作类型底色用,与 OSC 10/11 同一次 raw 会话发出)。
_QUERY_SLOTS: tuple[int, ...] = (2, 4, 5, 14)


def query_terminal_colors(timeout: float = 0.25) -> tuple[str, str] | None:
    """兼容旧接口:只取前景/背景。新代码用 query_terminal_palette。"""
    got = query_terminal_palette(timeout)
    if got:
        return got[0], got[1]
    return None


def query_terminal_palette(
    timeout: float = 0.25,
) -> tuple[str, str, dict[int, tuple[int, int, int]]] | None:
    """OSC 10/11 拿前景/背景 + OSC 4 拿类型色槽 RGB。

    时序约束:必须抢在输入线程之前调(唯一入口是 init_palette_from_terminal,
    在会话界面构造里、渲染循环前);非 tty(pytest/管道/Web)直接返回 None。
    """
    try:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            return None
    except Exception:
        return None

    try:
        import select
        import termios
        import tty

        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            query = "\x1b]10;?\x07\x1b]11;?\x07" + "".join(
                f"\x1b]4;{s};?\x07" for s in _QUERY_SLOTS)
            sys.stdout.write(query)
            sys.stdout.flush()
            # 期望回复数:10/11 各一 + 每个查询槽一。
            want = 2 + len(_QUERY_SLOTS)
            buf = _read_replies(fd, select, timeout, want)
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)

        return _extract_palette(buf)
    except Exception:
        return None


def _extract_palette(
    buf: str,
) -> tuple[str, str, dict[int, tuple[int, int, int]]] | None:
    pair = _extract_fg_bg(buf)
    if not pair:
        return None
    slots: dict[int, tuple[int, int, int]] = {}
    for idx, spec in _OSC4_REPLY_RE.findall(buf):
        slot = int(idx)
        if slot in _QUERY_SLOTS and slot not in slots:
            parsed = _parse_color_spec(spec)
            if parsed:
                slots[slot] = hex_to_rgb(parsed)
    return pair[0], pair[1], slots


def _extract_fg_bg(buf: str) -> tuple[str, str] | None:
    found: dict[str, str] = {}
    for code, spec in _OSC_REPLY_RE.findall(buf):
        parsed = _parse_color_spec(spec)
        if parsed and code not in found:
            found[code] = parsed
    fg = found.get("10")
    bg = found.get("11")
    if fg and bg:
        return fg, bg
    return None


def _read_replies(fd: int, select_mod, timeout: float, want: int = 2) -> str:
    deadline = time.monotonic() + max(0.0, timeout)
    chunks: list[bytes] = []
    last_recv = 0.0
    while True:
        now = time.monotonic()
        # 已有回复后只再等一个静默隙(60ms):追加的 OSC 4 查询对方不答时,
        # 不再干等到 deadline(不答 OSC 4 的终端每次启动白等整个 timeout)。
        cap = min(deadline, last_recv + 0.06) if chunks else deadline
        remaining = cap - now
        if remaining <= 0:
            break
        try:
            ready, _, _ = select_mod.select([fd], [], [], remaining)
        except Exception:
            break
        if not ready:
            break
        try:
            data = os.read(fd, 1024)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)
        last_recv = time.monotonic()
        text = b"".join(chunks).decode("utf-8", "replace")
        got = len(_OSC_REPLY_RE.findall(text)) + len(_OSC4_REPLY_RE.findall(text))
        if got >= want:
            return text
    return b"".join(chunks).decode("utf-8", "replace")


def _parse_color_spec(spec: str) -> str | None:
    s = spec.strip()
    if not s:
        return None
    if s.lower().startswith("rgb:"):
        parts = s[4:].split("/")
        if len(parts) != 3:
            return None
        out: list[int] = []
        for part in parts:
            part = part.strip()
            if not part or len(part) > 4 or any(c not in "0123456789abcdefABCDEF" for c in part):
                return None
            scale = (1 << (4 * len(part))) - 1
            out.append(int(round(int(part, 16) * 255 / scale)))
        return rgb_to_hex((out[0], out[1], out[2]))
    try:
        return normalize_hex(s)
    except ValueError:
        return None


def status_light(state: str, *, now: float | None = None, reset: bool = True) -> str:
    if state == "running":
        t = time.monotonic() if now is None else float(now)
        bright = int(t / _BLINK_HALF_SEC) % 2 == 0
        body = (SGR_YELLOW if bright else SGR_DIM_YELLOW) + LIGHT_GLYPH
    elif state == "ok":
        body = SGR_GREEN + LIGHT_GLYPH
    elif state == "error":
        body = SGR_RED + LIGHT_GLYPH
    else:
        return " "
    return body + SGR_RESET if reset else body
