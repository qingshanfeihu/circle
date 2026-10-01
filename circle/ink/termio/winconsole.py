"""The Windows console: raw input, escape-sequence output, UTF-16 reads and writes, clipboard.

Windows 10 (1809) and later understand the same escape sequences the interface already writes,
in both directions, once two console modes are switched on:

- ``ENABLE_VIRTUAL_TERMINAL_PROCESSING`` on the output handle, so escape sequences are drawn
  instead of printed, and
- ``ENABLE_VIRTUAL_TERMINAL_INPUT`` on the input handle, so arrow keys and function keys arrive
  as the escape sequences ``parse_keypress`` already reads.

Reading and writing use ``ReadConsoleW`` and ``WriteConsoleW`` (UTF-16), so the console's code
page never matters. It is deliberately left alone: the commands the model runs share this console,
and ``cmd.exe`` writes its output in that code page for the caller to decode.

ctypes is used only inside functions, so this module imports on every system. That lets its
logic be tested with a stand-in for ``kernel32`` anywhere; the real thing runs only on Windows.
"""

from __future__ import annotations

import ctypes
import time
import threading
from dataclasses import dataclass
from typing import Any

STD_INPUT_HANDLE = -10
STD_OUTPUT_HANDLE = -11

# input modes
ENABLE_PROCESSED_INPUT = 0x0001   # Ctrl+C as a signal
ENABLE_LINE_INPUT = 0x0002
ENABLE_ECHO_INPUT = 0x0004
ENABLE_QUICK_EDIT_MODE = 0x0040   # mouse selection that freezes the program
ENABLE_EXTENDED_FLAGS = 0x0080    # needed to change QuickEdit
ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200
# output modes
ENABLE_PROCESSED_OUTPUT = 0x0001
ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
DISABLE_NEWLINE_AUTO_RETURN = 0x0008  # a bare line feed only moves down, as on a raw POSIX tty

_READ_UNITS = 4096
_WRITE_CHARS = 4096
_INVALID_HANDLE = (-1, 0xFFFFFFFFFFFFFFFF, 0xFFFFFFFF)

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002


class NotAConsole(RuntimeError):
    """Standard input or output is not a Windows console (a pipe, a file, or a terminal
    emulator such as MobaXterm or mintty that is not a console)."""


class ConsoleTooOld(RuntimeError):
    """The console refuses the escape-sequence modes: Windows before 10 (1809)."""


def _declare(k: Any) -> None:
    """Give the kernel32 functions their C signatures. Without them a 64-bit handle is cut to
    32 bits. A stand-in may not have every function; those are skipped."""
    c_void, c_u32, c_int = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int
    table = {
        "GetStdHandle": ([c_int], c_void),
        "GetConsoleMode": ([c_void, ctypes.POINTER(c_u32)], c_int),
        "SetConsoleMode": ([c_void, c_u32], c_int),
        "ReadConsoleW": ([c_void, c_void, c_u32, ctypes.POINTER(c_u32), c_void], c_int),
        "WriteConsoleW": ([c_void, ctypes.c_wchar_p, c_u32, ctypes.POINTER(c_u32), c_void], c_int),
        "WaitForSingleObject": ([c_void, c_u32], c_u32),
        "OpenThread": ([c_u32, c_int, c_u32], c_void),
        "CancelSynchronousIo": ([c_void], c_int),
        "CloseHandle": ([c_void], c_int),
        "GlobalAlloc": ([c_u32, ctypes.c_size_t], c_void),
        "GlobalLock": ([c_void], c_void),
        "GlobalUnlock": ([c_void], c_int),
        "GlobalFree": ([c_void], c_void),
    }
    for name, (argtypes, restype) in table.items():
        fn = getattr(k, name, None)
        if fn is not None:
            try:
                fn.argtypes, fn.restype = argtypes, restype
            except (AttributeError, TypeError):
                pass


def join_utf16(pending: str, chunk: str) -> tuple[str, str]:
    """(text to hand on, text to keep). A console read can end between the two halves of a
    surrogate pair; the first half waits for the next read, and the two halves are then joined
    into the one character they stand for."""
    text = pending + chunk
    if pending:
        text = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
    if text and "\ud800" <= text[-1] <= "\udbff":
        return text[:-1], text[-1]
    return text, ""


@dataclass(frozen=True)
class _Saved:
    input_mode: int
    output_mode: int


class Console:
    def __init__(self, kernel32: Any = None) -> None:
        if kernel32 is None:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        self._k = kernel32
        _declare(kernel32)
        self._hin = kernel32.GetStdHandle(STD_INPUT_HANDLE)
        self._hout = kernel32.GetStdHandle(STD_OUTPUT_HANDLE)
        self._saved: _Saved | None = None
        self._pending = ""
        self._read_pending = threading.Event()

    def _mode(self, handle: Any) -> int | None:
        if handle is None or handle in _INVALID_HANDLE:
            return None
        mode = ctypes.c_uint32()
        return mode.value if self._k.GetConsoleMode(handle, ctypes.byref(mode)) else None

    def is_console(self) -> bool:
        return self._mode(self._hin) is not None and self._mode(self._hout) is not None

    def enter_raw(self) -> None:
        """Keys arrive one by one and unechoed, Ctrl+C arrives as a key, and escape sequences are
        drawn. ``leave_raw`` puts both modes back."""
        in_mode, out_mode = self._mode(self._hin), self._mode(self._hout)
        if in_mode is None or out_mode is None:
            raise NotAConsole("standard input or output is not a Windows console")
        k = self._k
        self._saved = _Saved(in_mode, out_mode)
        raw_in = ((in_mode & ~(ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT
                               | ENABLE_QUICK_EDIT_MODE))
                  | ENABLE_EXTENDED_FLAGS | ENABLE_VIRTUAL_TERMINAL_INPUT)
        if not k.SetConsoleMode(self._hin, raw_in):
            self._saved = None
            raise ConsoleTooOld("this console does not pass keys as escape sequences")
        drawn = out_mode | ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING
        if not (k.SetConsoleMode(self._hout, drawn | DISABLE_NEWLINE_AUTO_RETURN)
                or k.SetConsoleMode(self._hout, drawn)):
            k.SetConsoleMode(self._hin, in_mode)
            self._saved = None
            raise ConsoleTooOld("this console does not draw escape sequences")

    def leave_raw(self) -> None:
        saved, self._saved = self._saved, None
        if saved is None:
            return
        k = self._k
        k.SetConsoleMode(self._hin, saved.input_mode)
        k.SetConsoleMode(self._hout, saved.output_mode)

    def read(self, stop_event: threading.Event | None = None) -> str:
        """Block until some input arrives and return it. An empty string means the console is
        gone (the same as end of file on a pipe)."""
        buf = ctypes.create_unicode_buffer(_READ_UNITS)
        while True:
            if stop_event is not None:
                if stop_event.is_set():
                    return ""
                ready = self._k.WaitForSingleObject(self._hin, 50)
                if ready == 258:  # WAIT_TIMEOUT
                    continue
                if ready != 0:
                    return ""
                if stop_event.is_set():
                    return ""
            count = ctypes.c_uint32()
            self._read_pending.set()
            try:
                if stop_event is not None and stop_event.is_set():
                    return ""
                read_ok = self._k.ReadConsoleW(
                    self._hin, buf, _READ_UNITS - 1, ctypes.byref(count), None,
                )
            finally:
                self._read_pending.clear()
            if not read_ok:
                return ""
            if count.value == 0:
                return ""
            text, self._pending = join_utf16(self._pending, buf[:count.value])
            if text:
                return text

    def cancel_read(self, native_id: int) -> None:
        # Console events can signal readiness without producing text. Cancel a
        # pending ReadConsoleW before another screen takes ownership of input.
        if not self._read_pending.is_set():
            return
        handle = self._k.OpenThread(0x0001, False, native_id)  # THREAD_TERMINATE
        if handle:
            try:
                self._k.CancelSynchronousIo(handle)
            finally:
                self._k.CloseHandle(handle)

    def write(self, text: str) -> None:
        for start in range(0, len(text), _WRITE_CHARS):
            chunk = text[start:start + _WRITE_CHARS]
            while chunk:
                written = ctypes.c_uint32()
                units = len(chunk.encode("utf-16-le", "surrogatepass")) // 2
                if not self._k.WriteConsoleW(self._hout, chunk, units, ctypes.byref(written), None):
                    raise OSError("WriteConsoleW failed")
                if written.value == 0:
                    raise OSError("WriteConsoleW made no progress")
                if written.value >= units:
                    break
                chunk = chunk.encode("utf-16-le", "surrogatepass")[written.value * 2:].decode(
                    "utf-16-le", "surrogatepass")


def set_clipboard(text: str, user32: Any = None, kernel32: Any = None) -> bool:
    """Put ``text`` on the Windows clipboard as Unicode text. False if it could not be done."""
    if user32 is None:
        user32 = ctypes.WinDLL("user32", use_last_error=True)  # type: ignore[attr-defined]
    if kernel32 is None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    _declare(kernel32)
    for name, argtypes, restype in (
        ("CreateWindowExW", [ctypes.c_uint32, ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32,
                             ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                             ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p],
         ctypes.c_void_p),
        ("DestroyWindow", [ctypes.c_void_p], ctypes.c_int),
        ("OpenClipboard", [ctypes.c_void_p], ctypes.c_int),
        ("CloseClipboard", [], ctypes.c_int),
        ("EmptyClipboard", [], ctypes.c_int),
        ("SetClipboardData", [ctypes.c_uint32, ctypes.c_void_p], ctypes.c_void_p),
    ):
        fn = getattr(user32, name, None)
        if fn is not None:
            try:
                fn.argtypes, fn.restype = argtypes, restype
            except (AttributeError, TypeError):
                pass
    data = (text.replace("\r\n", "\n").replace("\n", "\r\n") + "\0").encode("utf-16-le")
    # The clipboard needs an owner: with none, EmptyClipboard works and SetClipboardData then fails.
    # An invisible window of the built-in STATIC class is enough.
    owner = user32.CreateWindowExW(0, "STATIC", None, 0, 0, 0, 0, 0, None, None, None, None) or None
    try:
        return _put_on_clipboard(data, owner, user32, kernel32)
    finally:
        if owner:
            user32.DestroyWindow(owner)


def _put_on_clipboard(data: bytes, owner: Any, user32: Any, kernel32: Any) -> bool:
    for _ in range(10):  # another program may hold the clipboard for a moment
        if user32.OpenClipboard(owner):
            break
        time.sleep(0.02)
    else:
        return False
    try:
        user32.EmptyClipboard()
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not handle:
            return False
        target = kernel32.GlobalLock(handle)
        if not target:
            kernel32.GlobalFree(handle)
            return False
        ctypes.memmove(target, data, len(data))
        kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)  # the clipboard owns the memory only if this succeeded
            return False
        return True
    finally:
        user32.CloseClipboard()
