
from __future__ import annotations

import os
import sys

if os.name != "nt":
    import termios
    import tty
from typing import TextIO


class Terminal:

    def __init__(self, *, output: TextIO | None = None, input: TextIO | None = None) -> None:
        self._output = output or sys.stdout
        self._input = input or sys.stdin
        self._original_attrs: list | None = None
        self._raw = False
        
        self._fd_out = self._output.fileno()
        self._portable_input = None
        self._portable_output = None
        self._raw_context = None
        if os.name == "nt" and self._input.isatty():
            from prompt_toolkit.input.defaults import create_input
            from prompt_toolkit.output.defaults import create_output
            self._portable_input = create_input(stdin=self._input)
            self._portable_output = create_output(stdout=self._output)

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
        except OSError:
            return 80

    @property
    def rows(self) -> int:
        try:
            size = os.get_terminal_size(self.fd)
            return size.lines
        except OSError:
            return 24

    def set_raw_mode(self, enable: bool) -> None:
        if os.name == "nt":
            if self._portable_input is not None:
                if enable and not self._raw:
                    self._raw_context = self._portable_input.raw_mode()
                    self._raw_context.__enter__()
                elif not enable and self._raw and self._raw_context is not None:
                    self._raw_context.__exit__(None, None, None)
            self._raw = enable
            return
        if enable and not self._raw:
            self._original_attrs = termios.tcgetattr(self.input_fd)
            tty.setraw(self.input_fd)
            self._raw = True
        elif not enable and self._raw and self._original_attrs is not None:
            termios.tcsetattr(
                self.input_fd, termios.TCSAFLUSH, self._original_attrs,
            )
            self._raw = False

    def write(self, data: str) -> None:
        if self._portable_output is not None:
            self._portable_output.write_raw(data)
            self._portable_output.flush()
            return
        os.write(self._fd_out, data.encode("utf-8"))

    def read(self) -> str:
        if self._portable_input is None:
            return os.read(self.input_fd, 4096).decode("utf-8", errors="replace")
        keys = self._portable_input.read_keys()
        sequences = {"up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
                     "home": "\x1b[H", "end": "\x1b[F", "pageup": "\x1b[5~", "pagedown": "\x1b[6~",
                     "escape": "\x1b"}
        return "".join(key.data or sequences.get(str(key.key.value), "") for key in keys)

    def restore(self) -> None:
        self.set_raw_mode(False)
