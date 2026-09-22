
from __future__ import annotations

import re
import unicodedata

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

_LINE_MARKERS = frozenset("●◆⏺✖✶✓✗⚠↳⎿⤷›•▸-?∴>")


def string_width(s: str) -> int:
    width = 0
    for ch in s:
        width += char_width(ch)
    return width


def wrapped_row_count(text: str, width: int) -> int:
    if not text:
        return 1
    total = 0
    for line in text.split("\n"):
        stripped = _ANSI_RE.sub("", line)
        w = string_width(stripped)
        if width <= 0 or w == 0 or w <= width:
            total += 1
        else:
            continuation = _content_col(stripped)
            cont_w = width - continuation
            if cont_w <= 0:
                cont_w = width
                continuation = 0
            if stripped.isascii():
                total += 1 + ((w - width) + cont_w - 1) // cont_w
            else:
                rows, col = 1, 0
                for ch in stripped:
                    cw = char_width(ch)
                    if col >= width or (cw == 2 and col + 1 >= width):
                        rows += 1
                        col = continuation
                    col += cw
                total += rows
    return total


def char_width(ch: str) -> int:
    if not ch:
        return 0
    code = ord(ch[0])
    if code < 0x1100:
        return 1
    if (
        (0x1100 <= code <= 0x115F)
        or (0x2329 <= code <= 0x232A)
        or (0x2E80 <= code <= 0x303E)
        or (0x3040 <= code <= 0x33BF)
        or (0x3400 <= code <= 0x4DBF)
        or (0x4E00 <= code <= 0x9FFF)
        or (0xA000 <= code <= 0xA4CF)
        or (0xAC00 <= code <= 0xD7AF)
        or (0xF900 <= code <= 0xFAFF)
        or (0xFE10 <= code <= 0xFE6F)
        or (0xFF01 <= code <= 0xFF60)
        or (0xFFE0 <= code <= 0xFFE6)
        or (0x1F300 <= code <= 0x1F9FF)
        or (0x20000 <= code <= 0x2FA1F)
        or (0x30000 <= code <= 0x3134F)
    ):
        return 2
    ea = unicodedata.east_asian_width(ch[0])
    if ea in ("W", "F"):
        return 2
    return 1


def _content_col(line: str) -> int:
    col = 0
    i = 0
    n = len(line)
    while i < n and line[i] == " ":
        col += 1
        i += 1
    if i < n and line[i] in _LINE_MARKERS:
        j = i + 1
        if j < n and line[j] == " ":
            col += char_width(line[i])
            while j < n and line[j] == " ":
                col += 1
                j += 1
            return col
    return col
