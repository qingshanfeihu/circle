
from __future__ import annotations

import base64
import os
import subprocess
import sys
import threading
from typing import Literal

from .ansi import BEL, ESC, ESC_TYPE, SEP

OSC_PREFIX = ESC + chr(ESC_TYPE.OSC)
ST = ESC + "\\"


def osc(*parts: str | int) -> str:
    return f"{OSC_PREFIX}{SEP.join(str(p) for p in parts)}{BEL}"


def wrap_for_multiplexer(sequence: str) -> str:
    if os.environ.get("TMUX"):
        escaped = sequence.replace("\x1b", "\x1b\x1b")
        return f"\x1bPtmux;{escaped}\x1b\\"
    if os.environ.get("STY"):
        return f"\x1bP{sequence}\x1b\\"
    return sequence


ClipboardPath = Literal["native", "tmux-buffer", "osc52"]


def get_clipboard_path() -> ClipboardPath:
    native_available = (
        sys.platform == "darwin" and not os.environ.get("SSH_CONNECTION")
    )
    if native_available:
        return "native"
    if os.environ.get("TMUX"):
        return "tmux-buffer"
    return "osc52"


def _tmux_passthrough(payload: str) -> str:
    """Wrap a sequence in tmux's DCS passthrough.

    Inner ESCs must be doubled. Requires `set -g allow-passthrough on`
    in ~/.tmux.conf; without it tmux silently drops the whole DCS.
    """
    return f"{ESC}Ptmux;{payload.replace(ESC, ESC + ESC)}{ST}"


_linux_copy: str | None = None


def _reset_linux_copy_cache() -> None:
    global _linux_copy
    _linux_copy = None


def _spawn_copy(argv: list[str], text: str) -> bool:
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except (FileNotFoundError, PermissionError, OSError):
        return False

    def _feed() -> None:
        try:
            assert proc.stdin is not None
            proc.stdin.write(text.encode("utf-8", errors="replace"))
            proc.stdin.close()
            proc.wait(timeout=2.0)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    threading.Thread(target=_feed, daemon=True).start()
    return True


def _copy_native_async(text: str) -> None:
    global _linux_copy
    if sys.platform == "darwin":
        _spawn_copy(["pbcopy"], text)
        return
    if sys.platform.startswith("linux"):
        if _linux_copy == "":
            return
        if _linux_copy == "wl-copy":
            _spawn_copy(["wl-copy"], text)
            return
        if _linux_copy == "xclip":
            _spawn_copy(["xclip", "-selection", "clipboard"], text)
            return
        if _linux_copy == "xsel":
            _spawn_copy(["xsel", "--clipboard", "--input"], text)
            return
        
        for tool, args in (
            ("wl-copy", []),
            ("xclip", ["-selection", "clipboard"]),
            ("xsel", ["--clipboard", "--input"]),
        ):
            if _spawn_copy([tool, *args], text):
                _linux_copy = tool
                return
        _linux_copy = ""
        return
    if sys.platform == "win32":
        
        
        _spawn_copy(["clip"], text)
        return


def _tmux_load_buffer_sync(text: str) -> bool:
    if not os.environ.get("TMUX"):
        return False
    args = (
        ["load-buffer", "-"]
        if os.environ.get("LC_TERMINAL") == "iTerm2"
        else ["load-buffer", "-w", "-"]
    )
    try:
        result = subprocess.run(
            ["tmux", *args],
            input=text.encode("utf-8", errors="replace"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2.0,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def set_clipboard(text: str) -> str:
    if not text:
        return ""

    b64 = base64.b64encode(text.encode("utf-8", errors="replace")).decode("ascii")
    raw = f"{ESC}]52;c;{b64}{BEL}"

    
    
    if not os.environ.get("SSH_CONNECTION"):
        _copy_native_async(text)

    tmux_loaded = _tmux_load_buffer_sync(text)

    if tmux_loaded:
        return _tmux_passthrough(raw)
    return raw
