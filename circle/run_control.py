"""Run-scoped cooperative cancellation shared by framework tool workers."""
from __future__ import annotations

import asyncio
import contextvars
import threading
from dataclasses import dataclass, field


class RunCancelled(RuntimeError):
    pass


@dataclass
class RunSignals:
    cancelled: threading.Event = field(default_factory=threading.Event)
    steering: list = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def enqueue(self, message) -> None:
        with self.lock:
            self.steering.append(message)

    def take(self) -> list:
        with self.lock:
            messages, self.steering = self.steering, []
            return messages

    def check(self) -> None:
        if self.cancelled.is_set():
            raise RunCancelled("Run cancelled")


current_run: contextvars.ContextVar[RunSignals | None] = contextvars.ContextVar("circle_run", default=None)


def check_cancelled() -> None:
    signals = current_run.get()
    if signals is not None:
        signals.check()


async def controlled(awaitable):
    task = asyncio.ensure_future(awaitable)
    try:
        while not task.done():
            check_cancelled()
            await asyncio.sleep(0.05)
        return await task
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
