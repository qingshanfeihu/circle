from __future__ import annotations

import os
import sys
import threading
from typing import TextIO

if sys.platform != "win32":
    import termios
    import tty


class TerminalUnsupported(RuntimeError):
    """The full-screen interface cannot run on this terminal. The message says why."""


class Terminal:

    def __init__(self, *, output: TextIO | None = None, input: TextIO | None = None) -> None:
        self._output = output or sys.stdout
        self._input = input or sys.stdin
        self._original_attrs: list | None = None
        self._raw = False
        self._console = None  # Windows only: the console handle wrapper, made on first use

        self._fd_out = self._output.fileno()

    @property
    def fd(self) -> int:
        return self._output.fileno()

    @property
    def input_fd(self) -> int:
        return self._input.fileno()

    @property
    def columns(self) -> int:
        try:
            size = os.get_terminal_size(self.fd)
            return size.columns
        except (OSError, ValueError):
            return 80

    @property
    def rows(self) -> int:
        try:
            size = os.get_terminal_size(self.fd)
            return size.lines
        except (OSError, ValueError):
            return 24

    def set_raw_mode(self, enable: bool) -> None:
        if sys.platform == "win32":
            self._set_raw_windows(enable)
        elif enable and not self._raw:
            self._original_attrs = termios.tcgetattr(self.input_fd)
            tty.setraw(self.input_fd)
            self._raw = True
        elif not enable and self._raw and self._original_attrs is not None:
            termios.tcsetattr(
                self.input_fd, termios.TCSAFLUSH, self._original_attrs,
            )
            self._raw = False

    def _set_raw_windows(self, enable: bool) -> None:
        from . import winconsole

        if enable and not self._raw:
            if self._console is None:
                self._console = winconsole.Console()
            try:
                self._console.enter_raw()
            except winconsole.NotAConsole as exc:
                raise TerminalUnsupported(
                    "this terminal is not a Windows console; run circle in Windows Terminal, "
                    "PowerShell or cmd") from exc
            except winconsole.ConsoleTooOld as exc:
                raise TerminalUnsupported(
                    f"{exc}; the full-screen interface needs Windows 10 (1809) or newer") from exc
            self._raw = True
        elif not enable and self._raw and self._console is not None:
            self._console.leave_raw()
            self._raw = False

    def read_input(self, stop_event: threading.Event | None = None) -> str:
        """Block until some input arrives and return it as text. An empty string means the
        terminal is gone."""
        if self._console is not None:
            return self._console.read(stop_event) if stop_event is not None else self._console.read()
        if stop_event is not None:
            import select

            while not stop_event.is_set():
                if select.select([self.input_fd], [], [], 0.05)[0]:
                    if stop_event.is_set():
                        return ""
                    break
            else:
                return ""
        data = os.read(self.input_fd, 4096)
        return data.decode("utf-8", errors="replace") if data else ""

    def cancel_read(self, native_id: int) -> None:
        if self._console is not None:
            self._console.cancel_read(native_id)

    def write(self, data: str) -> None:
        if self._console is not None:
            try:
                self._console.write(data)
                return
            except OSError:
                pass  # output was redirected after all; fall back to the file descriptor
        os.write(self._fd_out, data.encode("utf-8"))

    def restore(self) -> None:
        self.set_raw_mode(False)
