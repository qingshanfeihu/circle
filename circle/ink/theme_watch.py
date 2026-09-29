"""Follow the terminal's colours while the theme is ``auto``.

The palette is built from what the terminal reports for its foreground, background and a few
palette slots. That reading is taken once at start. This module keeps it current, so that
switching the terminal between a dark and a light theme is followed without a restart.

Two things tell it the terminal changed:

* the terminal pushes ``CSI ? 997 ; 1|2 n`` after ``CSI ? 2031 h`` (Otty, kitty, Contour,
  Ghostty and others do), and Circle then asks again at once;
* every ``interval`` seconds Circle asks anyway, because a terminal that does not push
  still answers. The question is a few dozen bytes and changes nothing on screen.

The answers arrive as input (``ColorReportEvent``) and are handed to :meth:`handle`. They are
collected for a moment, because the terminal answers the foreground, the background and each
slot separately, and only then compared with the last reading. If they differ, ``on_change``
runs so the screen can be repainted.
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

from . import theme
from .parse_keypress import ColorReportEvent, ColorSchemeEvent

logger = logging.getLogger(__name__)


class ThemeWatcher:

    def __init__(
        self,
        *,
        write: Callable[[str], None],
        active: Callable[[], bool],
        on_change: Callable[[], None],
        interval: float = 2.0,
        settle: float = 0.15,
        give_up_after: int = 3,
    ) -> None:
        self._write = write
        self._active = active
        self._on_change = on_change
        self._interval = interval
        self._settle = settle
        self._give_up_after = give_up_after

        self._mode = "auto"
        self._lock = threading.Lock()
        self._pending: dict[int, str] = {}
        self._timer: threading.Timer | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        # A terminal that has never answered is asked only a few times, then left alone.
        self._answered = False
        self._silent = 0

    @property
    def mode(self) -> str:
        return self._mode

    def start(self, mode: str) -> None:
        self._stop.clear()
        self._answered = theme.detected_palette() is not None
        self._silent = 0
        self.set_mode(mode)
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._poll, daemon=True, name="ink-theme-watch")
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._pending.clear()

    def set_mode(self, mode: str) -> None:
        """``auto`` follows the terminal; ``dark`` and ``light`` do not listen to it."""
        self._mode = theme.normalize_theme(mode)
        if self._mode == "auto":
            self._silent = 0
            self.ask()

    def ask(self) -> None:
        """Ask the terminal for its colours now. The answer comes back through ``handle``."""
        if self._mode != "auto" or not self._active():
            return
        try:
            self._write(theme.COLOR_QUERY)
        except Exception:  # noqa: BLE001
            logger.debug("theme query write failed", exc_info=True)

    def handle(self, event: ColorReportEvent | ColorSchemeEvent) -> None:
        """Take an answer, or a push, from the terminal."""
        if isinstance(event, ColorSchemeEvent):
            self.ask()
            return
        self._answered = True
        self._silent = 0
        if self._mode != "auto":
            return
        with self._lock:
            self._pending[event.slot] = event.color
            if self._timer is not None:
                self._timer.cancel()
            self._timer = threading.Timer(self._settle, self.flush)
            self._timer.daemon = True
            self._timer.start()

    def flush(self) -> None:
        """Compare what has been collected with the last reading; repaint if it differs."""
        with self._lock:
            pending, self._pending = self._pending, {}
            self._timer = None
        if not pending or self._mode != "auto":
            return
        before = theme.detected_palette()
        fg = pending.get(10) or (before[0] if before else None)
        bg = pending.get(11) or (before[1] if before else None)
        if not fg or not bg:
            return
        slots = dict(before[2]) if before else {}
        for slot, color in pending.items():
            if slot in theme._QUERY_SLOTS:  # noqa: SLF001
                slots[slot] = theme.hex_to_rgb(color)
        if theme.set_detected(fg, bg, slots):
            try:
                self._on_change()
            except Exception:  # noqa: BLE001
                logger.debug("theme change callback failed", exc_info=True)

    def _poll(self) -> None:
        while not self._stop.wait(self._interval):
            if self._mode != "auto" or not self._active():
                continue
            if not self._answered and self._silent >= self._give_up_after:
                continue
            self.ask()
            if not self._answered:
                self._silent += 1
