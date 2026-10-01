"""A stopped gate must relinquish input before the session reads its first key."""
import os
import threading
import time
from types import SimpleNamespace

import pytest

from circle.ink.app import InkApp
from circle.ink.termio.terminal import Terminal
from circle.ink.termio.winconsole import Console


@pytest.mark.skipif(os.name == "nt", reason="POSIX pipe readiness")
def test_cancelled_reader_leaves_first_command_for_next_screen():
    read_fd, write_fd = os.pipe()
    try:
        terminal = Terminal(input=SimpleNamespace(fileno=lambda: read_fd),
                            output=SimpleNamespace(fileno=lambda: write_fd))
        stop = threading.Event()
        result = []
        reader = threading.Thread(target=lambda: result.append(terminal.read_input(stop)))
        reader.start()
        stop.set()
        reader.join(1)
        assert not reader.is_alive()
        assert result == [""]
        os.write(write_fd, b"/models\r")
        assert terminal.read_input(threading.Event()) == "/models\r"
    finally:
        os.close(read_fd)
        os.close(write_fd)


class IdleTerminal:
    columns, rows = 80, 24

    def __init__(self):
        self.reading = threading.Event()
        self.restored = False
        self.reader = None

    def set_raw_mode(self, raw):
        pass

    def write(self, text):
        pass

    def read_input(self, stop):
        self.reader = threading.current_thread()
        self.reading.set()
        stop.wait()
        return "ignored stale input"

    def cancel_read(self, native_id):
        pass

    def restore(self):
        assert not self.reader.is_alive()
        self.restored = True


def test_stop_joins_idle_reader_before_restoring_and_allows_repeated_handoffs(monkeypatch):
    from circle.ink import app as module
    terminal = IdleTerminal()
    monkeypatch.setattr(module, "Terminal", lambda: terminal)
    app = InkApp()
    monkeypatch.setattr(app, "render", lambda: None)
    events = []
    app.on_input = events.append
    for _ in range(10):
        terminal.reading.clear()
        terminal.restored = False
        app.start()
        assert terminal.reading.wait(1)
        app.stop()
        assert terminal.restored
        assert not app._input_thread.is_alive()
    assert events == []


def test_stopping_from_input_callback_discards_remaining_events(monkeypatch):
    from circle.ink import app as module
    terminal = IdleTerminal()
    terminal.restore = lambda: None
    terminal.read_input = lambda stop: "ab"
    monkeypatch.setattr(module, "Terminal", lambda: terminal)
    app = InkApp()
    monkeypatch.setattr(app, "render", lambda: None)
    events = []
    def callback(event):
        events.append(event)
        app.stop()
    app.on_input = callback
    app.start()
    app._input_thread.join(1)
    assert not app._input_thread.is_alive()
    assert len(events) == 1
    app.stop()


def test_windows_idle_console_can_stop_without_a_key():
    class Kernel:
        def GetStdHandle(self, which):
            return which
        def WaitForSingleObject(self, handle, milliseconds):
            time.sleep(milliseconds / 1000)
            return 258
        def ReadConsoleW(self, *args):
            pytest.fail("idle console must not enter a blocking text read")
    console = Console(Kernel())
    stop = threading.Event()
    reader = threading.Thread(target=lambda: console.read(stop))
    reader.start()
    stop.set()
    reader.join(1)
    assert not reader.is_alive()


def test_windows_signalled_nontext_event_read_is_cancelled():
    class Kernel:
        def __init__(self):
            self.blocked = threading.Event()
            self.cancelled = threading.Event()
            self.closed = []
        def GetStdHandle(self, which):
            return which
        def WaitForSingleObject(self, handle, milliseconds):
            return 0
        def ReadConsoleW(self, *args):
            self.blocked.set()
            assert self.cancelled.wait(1)
            return 0
        def OpenThread(self, access, inherit, native_id):
            assert access == 0x0001 and not inherit
            return native_id
        def CancelSynchronousIo(self, handle):
            self.cancelled.set()
            return 1
        def CloseHandle(self, handle):
            self.closed.append(handle)
    kernel = Kernel()
    console = Console(kernel)
    console.cancel_read(123)
    assert kernel.closed == []  # Never cancel unrelated work outside ReadConsoleW.
    stop = threading.Event()
    reader = threading.Thread(target=lambda: console.read(stop))
    reader.start()
    assert kernel.blocked.wait(1)
    stop.set()
    console.cancel_read(reader.native_id)
    reader.join(1)
    assert not reader.is_alive()
    assert kernel.closed == [reader.native_id]
