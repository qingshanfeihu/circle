"""The Windows parts, exercised on any system with stand-ins for what only Windows has.

None of this replaces running Circle on Windows. It pins the decisions that can be checked without
one: which console modes are set and put back, how text is chunked and reassembled, what the
approval policy makes of `C:\\proj\\.env` and `del /s`, and that no module reaches for a POSIX-only
import at load time.
"""

from __future__ import annotations

import ast
import ctypes
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from circle import approvals, secret_prompt, system_prompt
from circle.ink import theme
from circle.ink.termio import terminal, winconsole

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "circle"


# ── no POSIX-only import at load time ──────────────────────────────────────

POSIX_ONLY = {"termios", "tty", "fcntl", "pwd", "grp", "resource", "pty", "syslog"}


def test_no_module_imports_a_posix_only_module_at_load_time():
    """A top-level `import termios` stops Circle from starting on Windows. Inside a function, or
    under `if sys.platform != "win32":`, it is fine."""
    offenders = []
    for path in PACKAGE.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in tree.body:
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [alias.name.split(".")[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module.split(".")[0]]
            offenders += [f"{path.relative_to(ROOT)}: {name}" for name in names if name in POSIX_ONLY]
    assert offenders == []


# ── the console ────────────────────────────────────────────────────────────


class FakeKernel32:
    """Remembers what was asked of the console and can be told to refuse."""

    def __init__(self, *, in_mode=0x01F7, out_mode=0x0003, refuse_newline_flag=False,
                 refuse_input_mode=False, refuse_output_mode=False, is_console=True):
        self.modes = {"in": in_mode, "out": out_mode}
        self.refuse_newline_flag = refuse_newline_flag
        self.refuse_input_mode = refuse_input_mode
        self.refuse_output_mode = refuse_output_mode
        self.is_console = is_console
        self.reads: list[str] = []
        self.written: list[tuple[str, int]] = []
        self.write_limit: int | None = None

    def GetStdHandle(self, which):  # noqa: N802
        return {-10: 100, -11: 200}[which]

    def GetConsoleMode(self, handle, ptr):  # noqa: N802
        if not self.is_console:
            return 0
        ptr._obj.value = self.modes["in" if handle == 100 else "out"]
        return 1

    def SetConsoleMode(self, handle, mode):  # noqa: N802
        if handle == 100:
            if self.refuse_input_mode:
                return 0
            self.modes["in"] = mode
        else:
            if self.refuse_output_mode:
                return 0
            if self.refuse_newline_flag and mode & winconsole.DISABLE_NEWLINE_AUTO_RETURN:
                return 0
            self.modes["out"] = mode
        return 1

    def ReadConsoleW(self, handle, buf, units, ptr, reserved):  # noqa: N802
        if not self.reads:
            return 0
        text = self.reads.pop(0)
        buf.value = text
        ptr._obj.value = len(text)
        return 1

    def WriteConsoleW(self, handle, text, units, ptr, reserved):  # noqa: N802
        self.written.append((text, units))
        ptr._obj.value = units if self.write_limit is None else min(units, self.write_limit)
        return 1


def test_raw_mode_sets_the_modes_and_puts_them_back():
    k = FakeKernel32()
    console = winconsole.Console(k)
    console.enter_raw()
    raw_in, raw_out = k.modes["in"], k.modes["out"]
    assert raw_in & winconsole.ENABLE_VIRTUAL_TERMINAL_INPUT
    for cleared in (winconsole.ENABLE_LINE_INPUT, winconsole.ENABLE_ECHO_INPUT,
                    winconsole.ENABLE_PROCESSED_INPUT, winconsole.ENABLE_QUICK_EDIT_MODE):
        assert not raw_in & cleared
    assert raw_out & winconsole.ENABLE_VIRTUAL_TERMINAL_PROCESSING
    assert raw_out & winconsole.DISABLE_NEWLINE_AUTO_RETURN
    assert raw_out & 0x0003 == 0x0003  # what was already on stays on
    # The code page is not touched: the fake has no such call, so touching it would fail here.
    console.leave_raw()
    assert k.modes == {"in": 0x01F7, "out": 0x0003}
    console.leave_raw()  # a second call changes nothing


def test_raw_mode_without_the_newline_flag_on_an_older_console():
    k = FakeKernel32(refuse_newline_flag=True)
    winconsole.Console(k).enter_raw()
    assert k.modes["out"] & winconsole.ENABLE_VIRTUAL_TERMINAL_PROCESSING
    assert not k.modes["out"] & winconsole.DISABLE_NEWLINE_AUTO_RETURN


def test_a_pipe_is_not_a_console():
    console = winconsole.Console(FakeKernel32(is_console=False))
    assert not console.is_console()
    with pytest.raises(winconsole.NotAConsole):
        console.enter_raw()


def test_a_console_that_refuses_escape_sequences_is_left_as_it_was():
    k = FakeKernel32(refuse_output_mode=True)
    with pytest.raises(winconsole.ConsoleTooOld):
        winconsole.Console(k).enter_raw()
    assert k.modes == {"in": 0x01F7, "out": 0x0003}
    k = FakeKernel32(refuse_input_mode=True)
    with pytest.raises(winconsole.ConsoleTooOld):
        winconsole.Console(k).enter_raw()
    assert k.modes == {"in": 0x01F7, "out": 0x0003}


def test_a_surrogate_pair_split_across_reads_is_put_back_together():
    k = FakeKernel32()
    k.reads = ["a\ud83d", "\ude00b"]
    console = winconsole.Console(k)
    first = console.read()
    second = console.read()
    assert first == "a"
    assert second == "😀b"  # one character, not two lone halves
    assert (first + second).encode("utf-16-le") is not None  # and it encodes, as a clipboard needs


def test_a_lone_half_is_not_returned_as_end_of_input():
    k = FakeKernel32()
    k.reads = ["\ud83d", "\ude00"]
    assert winconsole.Console(k).read() == "😀"


def test_read_gives_empty_when_the_console_is_gone():
    assert winconsole.Console(FakeKernel32()).read() == ""


def test_write_counts_utf16_units_and_chunks_long_output():
    k = FakeKernel32()
    console = winconsole.Console(k)
    console.write("x" * 9000 + "😀")
    assert [len(t) for t, _ in k.written] == [4096, 4096, 809]
    assert k.written[-1][1] == 810  # the emoji is two UTF-16 units
    assert sum(u for _, u in k.written) == 9002


def test_write_continues_after_a_short_write():
    k = FakeKernel32()
    k.write_limit = 3
    winconsole.Console(k).write("abcdefg")
    assert "".join(t for t, _ in k.written[:1]) == "abcdefg"
    assert [t for t, _ in k.written][1:] == ["defg", "g"]


def test_the_clipboard_gets_utf16_text_with_windows_line_breaks():
    class User32:
        def __init__(self):
            self.opened, self.closed, self.emptied, self.set = 0, 0, 0, None
            self.owner_used, self.destroyed = None, []

        def CreateWindowExW(self, *args):  # noqa: N802
            return 42

        def DestroyWindow(self, hwnd):  # noqa: N802
            self.destroyed.append(hwnd)

        def OpenClipboard(self, owner):  # noqa: N802
            self.opened += 1
            self.owner_used = owner
            return 1 if self.opened > 2 else 0  # busy twice, then free

        def CloseClipboard(self):  # noqa: N802
            self.closed += 1

        def EmptyClipboard(self):  # noqa: N802
            self.emptied += 1

        def SetClipboardData(self, fmt, handle):  # noqa: N802
            self.set = (fmt, handle)
            return handle

    class Kernel32(FakeKernel32):
        def __init__(self):
            super().__init__()
            self.block = None
            self.freed = []

        def GlobalAlloc(self, flags, size):  # noqa: N802
            self.block = ctypes.create_string_buffer(size)
            return 7

        def GlobalLock(self, handle):  # noqa: N802
            return ctypes.addressof(self.block)

        def GlobalUnlock(self, handle):  # noqa: N802
            return 1

        def GlobalFree(self, handle):  # noqa: N802
            self.freed.append(handle)

    user32, kernel32 = User32(), Kernel32()
    assert winconsole.set_clipboard("héllo\n世界😀", user32, kernel32)
    assert user32.set == (winconsole.CF_UNICODETEXT, 7)
    assert kernel32.block.raw.decode("utf-16-le") == "héllo\r\n世界😀\0"
    assert user32.closed == 1 and user32.emptied == 1 and kernel32.freed == []
    assert user32.owner_used == 42 and user32.destroyed == [42]  # an owner, or SetClipboardData fails


def test_the_clipboard_gives_up_when_it_stays_busy_and_frees_memory_it_did_not_hand_over():
    class Busy:
        def CreateWindowExW(self, *args):  # noqa: N802
            return 0

        def OpenClipboard(self, owner):  # noqa: N802
            return 0

    assert not winconsole.set_clipboard("x", Busy(), FakeKernel32())

    class Refuses:
        closed = 0

        def CreateWindowExW(self, *args):  # noqa: N802
            return 0

        def OpenClipboard(self, owner):  # noqa: N802
            return 1

        def EmptyClipboard(self):  # noqa: N802
            pass

        def SetClipboardData(self, fmt, handle):  # noqa: N802
            return 0

        def CloseClipboard(self):  # noqa: N802
            Refuses.closed += 1

    class Mem(FakeKernel32):
        freed: list = []

        def GlobalAlloc(self, flags, size):  # noqa: N802
            self.block = ctypes.create_string_buffer(size)
            return 9

        def GlobalLock(self, handle):  # noqa: N802
            return ctypes.addressof(self.block)

        def GlobalUnlock(self, handle):  # noqa: N802
            return 1

        def GlobalFree(self, handle):  # noqa: N802
            Mem.freed.append(handle)

    assert not winconsole.set_clipboard("x", Refuses(), Mem())
    assert Mem.freed == [9] and Refuses.closed == 1


# ── Terminal and the app around it ─────────────────────────────────────────


class _Pipe:
    """A file object with a real descriptor, so Terminal has something to call fileno() on."""

    def __init__(self, fd: int) -> None:
        self._fd = fd

    def fileno(self) -> int:
        return self._fd


@pytest.fixture
def make_terminal(monkeypatch):
    fds: list[int] = []

    def make(console) -> terminal.Terminal:
        r, w = os.pipe()
        fds.extend((r, w))
        monkeypatch.setattr(terminal, "sys", SimpleNamespace(platform="win32", stdout=None, stdin=None))
        monkeypatch.setattr(winconsole, "Console", lambda: console)
        return terminal.Terminal(output=_Pipe(w), input=_Pipe(r))

    yield make
    for fd in fds:
        try:
            os.close(fd)
        except OSError:
            pass


class RecordingConsole:
    def __init__(self, enter=None):
        self.enter, self.events, self.chunks = enter, [], []

    def enter_raw(self):
        self.events.append("enter")
        if self.enter:
            raise self.enter

    def leave_raw(self):
        self.events.append("leave")

    def read(self):
        return "abc"

    def write(self, text):
        self.chunks.append(text)


def test_terminal_uses_the_console_on_windows(make_terminal):
    console = RecordingConsole()
    term = make_terminal(console)
    term.set_raw_mode(True)
    term.set_raw_mode(True)  # already raw: no second call
    assert term.read_input() == "abc"
    term.write("\x1b[2J")
    term.restore()
    assert console.events == ["enter", "leave"]
    assert console.chunks == ["\x1b[2J"]


@pytest.mark.parametrize(("error", "words"), [
    (winconsole.NotAConsole("pipe"), "Windows Terminal"),
    (winconsole.ConsoleTooOld("no escape sequences"), "Windows 10"),
])
def test_terminal_names_the_reason_it_cannot_run(make_terminal, error, words):
    term = make_terminal(RecordingConsole(enter=error))
    with pytest.raises(terminal.TerminalUnsupported, match=words):
        term.set_raw_mode(True)


def test_output_goes_to_the_descriptor_if_the_console_write_fails(make_terminal):
    class Broken(RecordingConsole):
        def write(self, text):
            raise OSError("redirected")

    term = make_terminal(Broken())
    term.set_raw_mode(True)
    term.write("hi")  # must not raise; the bytes reach the pipe
    assert os.read(term.input_fd, 16) == b"hi"


def test_size_changes_are_noticed_without_a_signal():
    from circle.ink.app import InkApp

    size = {"v": (80, 24)}

    class Term:
        columns = property(lambda self: size["v"][0])
        rows = property(lambda self: size["v"][1])

    app = InkApp.__new__(InkApp)
    app._terminal = Term()  # noqa: SLF001
    app._running, app._suspended = True, False  # noqa: SLF001
    seen: list[int] = []
    app._on_resize = lambda signum, frame: seen.append(1)  # noqa: SLF001
    threading.Thread(target=app._watch_size, daemon=True).start()  # noqa: SLF001
    time.sleep(0.25)
    assert seen == []
    size["v"] = (100, 30)
    deadline = time.time() + 3
    while not seen and time.time() < deadline:
        time.sleep(0.05)
    app._running = False  # noqa: SLF001
    assert seen == [1]


def test_colour_query_is_skipped_on_windows(monkeypatch):
    tty = SimpleNamespace(isatty=lambda: True)
    monkeypatch.setattr(theme, "sys", SimpleNamespace(platform="win32", stdin=tty, stdout=tty))
    assert theme.query_terminal_palette() is None


# ── the machine-wide secret lock ───────────────────────────────────────────


class FakeMsvcrt:
    LK_NBLCK, LK_UNLCK = 2, 0

    def __init__(self, busy_first=0):
        self.calls, self.busy = [], busy_first

    def locking(self, fd, mode, nbytes):
        self.calls.append((mode, nbytes))
        if mode == self.LK_NBLCK and self.busy:
            self.busy -= 1
            raise OSError("locked by someone else")


def test_the_windows_lock_waits_for_the_other_holder(tmp_path: Path):
    fake = FakeMsvcrt(busy_first=3)
    with (tmp_path / "lock").open("a+b") as fh:
        secret_prompt._lock_file(fh, fake)  # noqa: SLF001
        secret_prompt._unlock_file(fh, fake)  # noqa: SLF001
    assert fake.calls == [(2, 1)] * 4 + [(0, 1)]


# ── the approval policy reads Windows commands ─────────────────────────────


@pytest.fixture
def windows_policy(monkeypatch):
    monkeypatch.setattr(approvals, "_WINDOWS", True)


@pytest.mark.parametrize("command", [
    r"type C:\proj\.env",
    r"type C:\PROJ\.ENV",
    r'copy "C:\Users\me\.aws\credentials.json" x',
    r"more D:\keys\server.PEM",
])
def test_windows_paths_to_credential_files_are_refused(windows_policy, command):
    assert approvals.classify_command(command).verdict == "DENY"


@pytest.mark.parametrize("command", [
    "del /s /q build",
    "erase build",
    r"rd /s /q build\out",
    "rmdir /s build",
    "Remove-Item -Recurse -Force build",
    'cmd /c "del /s build"',
    r"C:\Windows\System32\cmd.exe /c rmdir /s x",
    'powershell -NoProfile -Command "Remove-Item -Recurse x"',
    "pwsh -c \"ri x\"",
    "format D: /q",
    "diskpart",
    "powershell -EncodedCommand SQBFAFgA",
    "powershell -ec SQBFAFgA",
    "powershell -e SQBFAFgA",
    "powershell Remove-Item -Recurse src",
    "powershell -NoProfile Remove-Item -Recurse src",
    'powershell -ExecutionPolicy Bypass -Command "del x"',
    'powershell -Comm "Remove-Item x"',
    'pwsh -NoLogo -c "rd /s x"',
    'cmd /c"del x"',
    'cmd /s /c "rmdir /s x"',
])
def test_windows_deletes_and_disk_tools_always_ask(windows_policy, command):
    assert approvals.classify_command(command).verdict == "ASK_FORCED", command


def test_windows_privilege_escalation_is_refused(windows_policy):
    assert approvals.classify_command(r"runas /user:Administrator cmd").verdict == "DENY"
    assert approvals.classify_command("gsudo del x").verdict == "DENY"


def test_ordinary_windows_commands_just_ask(windows_policy):
    for command in ("dir", r"type README.md", "git status", r"python -m pytest tests\test_x.py",
                    "powershell -NoProfile Get-ChildItem", "powershell -File build.ps1",
                    'powershell -ExecutionPolicy Bypass -Command "Get-Date"', 'cmd /c "dir"'):
        review = approvals.classify_command(command)
        assert review.verdict == "ASK", command


def test_the_new_names_also_hold_on_posix_hosts(monkeypatch):
    monkeypatch.setattr(approvals, "_WINDOWS", False)
    assert approvals.classify_command("del build").verdict == "ASK_FORCED"
    assert approvals.classify_command('pwsh -Command "rm -rf x"').verdict == "ASK_FORCED"
    # a backslash is still an escape in a POSIX shell: the old reading is unchanged
    assert approvals.classify_command(r"cat a\ b.txt").verdict == "ASK"


# ── what the model is told ─────────────────────────────────────────────────


def test_the_model_is_told_the_shell_on_windows(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(system_prompt, "sys", SimpleNamespace(platform="win32"))
    block = system_prompt.format_env_block(cwd=tmp_path)
    assert "Shell: cmd.exe" in block and "no bash" in block
    monkeypatch.setattr(system_prompt, "sys", SimpleNamespace(platform="linux"))
    assert "Shell:" not in system_prompt.format_env_block(cwd=tmp_path)
