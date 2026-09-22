
from __future__ import annotations

import os
import sys
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
        os.write(self._fd_out, data.encode("utf-8"))

    def restore(self) -> None:
        self.set_raw_mode(False)
