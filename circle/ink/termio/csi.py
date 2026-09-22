
from __future__ import annotations

from .ansi import ESC, SEP


def csi(params: str) -> str:
    return f"{ESC}[{params}"


def cursor_position(row: int, col: int) -> str:
    return csi(f"{row}{SEP}{col}H")


def cursor_up(n: int = 1) -> str:
    return csi(f"{n}A")


def cursor_down(n: int = 1) -> str:
    return csi(f"{n}B")


def cursor_forward(n: int = 1) -> str:
    return csi(f"{n}C")


def cursor_backward(n: int = 1) -> str:
    return csi(f"{n}D")


def cursor_horizontal_absolute(col: int = 1) -> str:
    return csi(f"{col}G")


def erase_in_display(mode: int = 0) -> str:
    return csi(f"{mode}J")


def erase_in_line(mode: int = 0) -> str:
    return csi(f"{mode}K")


def scroll_up(n: int = 1) -> str:
    return csi(f"{n}S")


def scroll_down(n: int = 1) -> str:
    return csi(f"{n}T")


def is_csi_final(code: int) -> bool:
    return 0x40 <= code <= 0x7E


def is_csi_param(code: int) -> bool:
    return 0x30 <= code <= 0x3F


def is_csi_intermediate(code: int) -> bool:
    return 0x20 <= code <= 0x2F
