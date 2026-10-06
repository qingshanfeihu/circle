"""A lone ESC is the Esc key, for every screen that reads keys."""

from __future__ import annotations

import re
import threading
import time
from collections.abc import Callable

from circle.ink.parse_keypress import InputEvent, InputParser, KeyPress


class StandaloneEscapeInputParser:
    """A lone ESC is the Esc key (InfoTest ``ist_app._StandaloneEscapeInputParser``).

    Terminals send the Esc key as a bare ``\x1b``, which is also how every escape
    sequence starts, so the tokenizer holds it waiting for more. If nothing follows
    within ``_DELAY_S`` it is emitted as ``escape``. A sequence tail that still turns up
    shortly after (a split read on a slow link) gets its ESC back instead of being
    typed into the prompt."""

    _DELAY_S = 0.25
    _STRAY_WINDOW_S = 1.0
    _STRAY_TAIL_RE = re.compile(r"^\[(?:<\d+;\d+;\d+[Mm]|[0-9;?]*[A-Za-z~])$")

    def __init__(self, delegate: InputParser, emit: Callable[[InputEvent], None]) -> None:
        self._delegate = delegate
        self._emit = emit
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._stray_escape_at: float | None = None

    def feed(self, text: str) -> list[InputEvent]:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            stray_at, self._stray_escape_at = self._stray_escape_at, None
            if (stray_at is not None and time.monotonic() - stray_at <= self._STRAY_WINDOW_S
                    and self._STRAY_TAIL_RE.match(text)):
                text = "\x1b" + text
            tokenizer = getattr(self._delegate, "_tokenizer", None)
            lead: list[InputEvent] = []
            if (tokenizer is not None and tokenizer.buffer == "\x1b" and text
                    and " " <= text[0] <= "/"):
                # An esc from an earlier read, then space or one of !"#$%&'()*+,-./ typed
                # quickly (esc, then "/" for a command): the esc key, then that key. Read
                # together they would start an escape sequence and both would be lost.
                tokenizer.reset()
                lead = [KeyPress(key="escape")]
            events = lead + self._delegate.feed(text)
            if tokenizer is not None and tokenizer.buffer == "\x1b":
                timer = threading.Timer(self._DELAY_S, self._emit_pending_escape)
                timer.daemon = True
                self._timer = timer
                timer.start()
            return events

    def _emit_pending_escape(self) -> None:
        should_emit = False
        with self._lock:
            tokenizer = getattr(self._delegate, "_tokenizer", None)
            if tokenizer is not None and tokenizer.buffer == "\x1b":
                tokenizer.reset()
                should_emit = True
                self._stray_escape_at = time.monotonic()
            self._timer = None
        if should_emit:
            self._emit(KeyPress(key="escape"))
