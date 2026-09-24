"""Detect a model stuck repeating the same block of text while it streams.

Ported unchanged from InfoTest (``main/common/text_repetition.py``). Text is split into
tokens (words; each CJK character is its own token). The tail of the stream counts as
a loop when a block of at least ``min_block`` tokens repeats ``repeats`` times with
≥90 % positional agreement and the last cycle adds no token the earlier cycles did not
have. The check runs every ``check_every`` new tokens over a sliding window.
"""

from __future__ import annotations

import re

DEFAULT_MIN_BLOCK = 8
DEFAULT_REPEATS = 4
DEFAULT_WINDOW_TOKENS = 4000
DEFAULT_TOLERANCE = 0.90
DEFAULT_MAX_NOVELTY = 0.0

_MAX_RESIDUAL_CHARS = 256
_CJK = re.compile(r"([　-〿㐀-䶿一-鿿豈-﫿＀-￯])")
_WS = re.compile(r"\s+")


def tokenize(text: str) -> list[str]:
    if not text:
        return []
    lowered = _WS.sub(" ", text.lower())
    spaced = _CJK.sub(r" \1 ", lowered)
    return [tok for tok in spaced.strip().split(" ") if tok]


def _period_score(tokens: list[str], period: int, repeats: int, *, samples: int = 0) -> float:
    need = period * repeats
    if period <= 0 or len(tokens) < need:
        return 0.0
    tail = tokens[-need:]
    span = need - period
    if span <= 0:
        return 0.0
    step = max(1, span // samples) if samples else 1
    idx = range(0, span, step)
    total = len(idx)
    if not total:
        return 0.0
    return sum(1 for i in idx if tail[i] == tail[i + period]) / total


def cycle_novelty(tokens: list[str], period: int, repeats: int) -> float:
    need = period * repeats
    if period <= 0 or len(tokens) < need:
        return 1.0
    tail = tokens[-need:]
    prior = set(tail[:-period])
    last = tail[-period:]
    if not last:
        return 1.0
    return sum(1 for tok in last if tok not in prior) / len(last)


def periodic_tail_period(tokens: list[str], *, min_block: int = DEFAULT_MIN_BLOCK,
                         repeats: int = DEFAULT_REPEATS, tolerance: float = DEFAULT_TOLERANCE,
                         max_novelty: float = DEFAULT_MAX_NOVELTY) -> int | None:
    if min_block <= 0 or repeats < 2 or len(tokens) < min_block * repeats:
        return None
    max_period = len(tokens) // repeats
    for period in range(min_block, max_period + 1):
        if _period_score(tokens, period, repeats, samples=64) < tolerance:
            continue
        if _period_score(tokens, period, repeats) < tolerance:
            continue
        if len(set(tokens[-period:])) < 3:
            continue
        if cycle_novelty(tokens, period, repeats) <= max_novelty:
            return period
    return None


class RepetitionMonitor:
    def __init__(self, *, min_block: int = DEFAULT_MIN_BLOCK, repeats: int = DEFAULT_REPEATS,
                 window_tokens: int = DEFAULT_WINDOW_TOKENS,
                 tolerance: float = DEFAULT_TOLERANCE, max_novelty: float = DEFAULT_MAX_NOVELTY,
                 check_every: int = 200) -> None:
        self.min_block = min_block
        self.repeats = repeats
        self.window_tokens = window_tokens
        self.tolerance = tolerance
        self.max_novelty = max_novelty
        self.check_every = max(1, check_every)
        self._tokens: list[str] = []
        self._residual = ""
        self._since_check = 0

    def feed(self, text: str) -> int | None:
        """Add streamed text; the repeating block length when a loop is found."""
        buf = self._residual + text
        if buf and not buf[-1].isspace():
            cut = max(buf.rfind(" "), buf.rfind("\n"), buf.rfind("\t"))
            if cut < 0 and len(buf) <= _MAX_RESIDUAL_CHARS:
                self._residual = buf
                return None
            self._residual = buf[cut + 1:] if 0 <= cut else ""
            buf = buf[:cut + 1] if 0 <= cut else buf
        else:
            self._residual = ""
        fresh = tokenize(buf)
        if not fresh:
            return None
        self._tokens.extend(fresh)
        if len(self._tokens) > self.window_tokens:
            self._tokens = self._tokens[-self.window_tokens:]
        self._since_check += len(fresh)
        if self._since_check < self.check_every:
            return None
        self._since_check = 0
        return periodic_tail_period(self._tokens, min_block=self.min_block,
                                    repeats=self.repeats, tolerance=self.tolerance,
                                    max_novelty=self.max_novelty)
