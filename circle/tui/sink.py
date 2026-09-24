"""Bus sink that feeds the reducer and posts each new snapshot to the screen."""

from __future__ import annotations

import logging
from typing import Callable

from circle.events import CircleEvent
from circle.tui.message_model import MessageSnapshot
from circle.tui.reducer import MessageReducer

logger = logging.getLogger(__name__)


class TuiSink:
    def __init__(self, *, post: Callable[[MessageSnapshot], None]) -> None:
        self._post = post
        self._reducer = MessageReducer()
        self._reducer.subscribe(self._post)

    @property
    def reducer(self) -> MessageReducer:
        return self._reducer

    def __call__(self, event: CircleEvent) -> None:
        try:
            self._reducer.dispatch(event)
        except Exception:  # noqa: BLE001
            logger.exception("TuiSink dispatch error")

    def reset(self, *, source_run_id: str = "") -> None:
        self._reducer.reset(source_run_id=source_run_id)

    def cancel_run(self, *, reason: str = "user_interrupt") -> None:
        self._reducer.cancel_run(reason=reason)
