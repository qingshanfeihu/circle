
from __future__ import annotations

import os
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - 仅类型
    from .theme import Palette

__all__ = [
    "FRAME_MS",
    "enabled",
    "frame_ms",
    "frame_seconds",
    "frame_index",
    "levels",
    "runs",
    "render",
    "REASON_LADDER",
]

FRAME_MS = 80
_MIN_MS, _MAX_MS = 33, 500

_LEAD = 4

_BANDS: tuple[tuple[int, str], ...] = ((0, "em"), (2, "text"))
_BASE = "dim"

REASON_LADDER = ("reason_dim", "reason", "reason_hi")
_LEVEL_SLOT = {_BASE: 0, "text": 1, "em": 2}


def enabled() -> bool:
    return (os.environ.get("IST_TUI_SHIMMER") or "").strip() != "0"


def frame_ms() -> int:
    raw = (os.environ.get("IST_TUI_SHIMMER_MS") or "").strip()
    if raw:
        try:
            return max(_MIN_MS, min(_MAX_MS, int(raw)))
        except (TypeError, ValueError):
            pass
    return FRAME_MS


def frame_seconds() -> float:
    return frame_ms() / 1000.0 if enabled() else 0.5


def frame_index(now: float | None = None) -> int:
    t = time.monotonic() if now is None else float(now)
    return int(t * 1000.0 // frame_ms())


def levels(count: int, frame: int) -> list[str]:
    if count <= 0:
        return []
    period = count + 2 * _LEAD
    head = (frame % period) - _LEAD
    out: list[str] = []
    for i in range(count):
        d = abs(i - head)
        for reach, level in _BANDS:
            if d <= reach:
                out.append(level)
                break
        else:
            out.append(_BASE)
    return out


def runs(text: str, frame: int) -> list[tuple[str, str]]:
    if not text:
        return []
    lv = levels(len(text), frame)
    out: list[tuple[str, str]] = []
    start = 0
    for i in range(1, len(text) + 1):
        if i == len(text) or lv[i] != lv[start]:
            out.append((text[start:i], lv[start]))
            start = i
    return out


def render(
    text: str,
    pal: "Palette",
    *,
    now: float | None = None,
    frame: int | None = None,
    ladder: tuple[str, str, str] = REASON_LADDER,
) -> str:
    if not text:
        return ""
    if not enabled():
        return f"{getattr(pal, ladder[1])}{text}{pal.reset}"
    idx = frame_index(now) if frame is None else int(frame)
    parts = [
        f"{getattr(pal, ladder[_LEVEL_SLOT[level]])}{chunk}"
        for chunk, level in runs(text, idx)
    ]
    return "".join(parts) + pal.reset
