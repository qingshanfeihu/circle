"""Fold bus events immediately and coalesce expensive screen snapshots."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from circle.events import CircleEvent
from circle.tui.message_model import MessageSnapshot
from circle.tui.reducer import MessageReducer

logger = logging.getLogger(__name__)
_SNAPSHOT_INTERVAL = 0.04


class TuiSink:
    def __init__(self, *, post: Callable[[MessageSnapshot], None]) -> None:
        self._post = post
        self._reducer = MessageReducer()
        self._post_lock = threading.Lock()
        self._timer_lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._dirty = False
        self._last_post = 0.0
        self._reducer.subscribe(self._post_immediate)

    @property
    def reducer(self) -> MessageReducer:
        return self._reducer

    def __call__(self, event: CircleEvent) -> None:
        try:
            if self._reducer.dispatch(event, notify=False):
                if event.get("kind") in {"run_end", "run_error"}:
                    self.flush()
                else:
                    self._queue()
        except Exception:
            logger.exception("TuiSink dispatch error")

    def _post_immediate(self, snap: MessageSnapshot) -> None:
        with self._post_lock:
            self._post(snap)

    def _queue(self) -> None:
        with self._timer_lock:
            self._dirty = True
            if self._timer is None:
                self._schedule_locked()

    def _schedule_locked(self) -> None:
        delay = max(0.0, self._last_post + _SNAPSHOT_INTERVAL - time.monotonic())
        self._timer = threading.Timer(delay, self._flush_timer)
        self._timer.daemon = True
        self._timer.start()

    def _flush_timer(self) -> None:
        with self._timer_lock:
            if not self._dirty:
                self._timer = None
                return
            self._dirty = False
        try:
            with self._post_lock:
                self._post(self._reducer.snapshot())
        except Exception:
            logger.exception("TuiSink snapshot post error")
        finally:
            with self._timer_lock:
                self._last_post = time.monotonic()
                self._timer = None
                if self._dirty:
                    self._schedule_locked()

    def flush(self) -> None:
        """Publish the final state before a turn closes or waits for approval."""
        with self._timer_lock:
            if self._timer is not None:
                self._timer.cancel()
            self._timer = None
            self._dirty = False
        with self._post_lock:
            self._post(self._reducer.snapshot())
        with self._timer_lock:
            self._last_post = time.monotonic()

    def reset(self, *, source_run_id: str = "") -> None:
        self._reducer.reset(source_run_id=source_run_id)

    def cancel_run(self, *, reason: str = "user_interrupt") -> None:
        self._reducer.cancel_run(reason=reason)
