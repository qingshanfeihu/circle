
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass, field
from typing import Literal

from .termio.tokenize import Token, Tokenizer

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class KeyPress:
    key: str
    char: str = ""
    ctrl: bool = False
    alt: bool = False
    shift: bool = False
    meta: bool = False


@dataclass(slots=True)
class MouseEvent:
    type: Literal["press", "release", "move", "wheel"]
    button: int = 0
    x: int = 0
    y: int = 0
    shift: bool = False
    alt: bool = False
    ctrl: bool = False


@dataclass(slots=True)
class PasteEvent:
    text: str = ""


@dataclass(slots=True)
class UploadEvent:
    filename: str = ""


@dataclass(slots=True)
class SwitchConversationEvent:
    conversation_id: str = ""


InputEvent = KeyPress | MouseEvent | PasteEvent | UploadEvent | SwitchConversationEvent


_CSI_KEYS: dict[str, str] = {
    "A": "up", "B": "down", "C": "right", "D": "left",
    "H": "home", "F": "end",
    "1~": "home", "2~": "insert", "3~": "delete",
    "4~": "end", "5~": "pageup", "6~": "pagedown",
    "Z": "shift+tab",
}


_SS3_KEYS: dict[str, str] = {
    "A": "up", "B": "down", "C": "right", "D": "left",
    "H": "home", "F": "end",
    "P": "f1", "Q": "f2", "R": "f3", "S": "f4",
}

PASTE_START = "\x1b[200~"
PASTE_END = "\x1b[201~"

_OSC_UPLOAD_CODE = "7001"
_OSC_SWITCH_CONV_CODE = "7003"


class InputParser:

    def __init__(self) -> None:
        self._tokenizer = Tokenizer(x10_mouse=True)
        self._in_paste = False
        self._paste_buf: list[str] = []

    def feed(self, data: str) -> list[InputEvent]:
        tokens = self._tokenizer.feed(data)
        events: list[InputEvent] = []
        for token in tokens:
            self._process_token(token, events)
        
        events = _coalesce_alt_enter(events)
        
        
        
        
        events = coalesce_paste_runs(events)
        return events

    def _process_token(self, token: Token, events: list[InputEvent]) -> None:
        if self._in_paste:
            if token.type == "sequence" and token.value == PASTE_END:
                self._in_paste = False
                events.append(PasteEvent(text="".join(self._paste_buf)))
                self._paste_buf.clear()
            else:
                self._paste_buf.append(token.value)
            return

        if token.type == "sequence" and token.value == PASTE_START:
            self._in_paste = True
            return

        if token.type == "text":
            for ch in token.value:
                events.append(_parse_char(ch))
        elif token.type == "sequence":
            ev = _parse_sequence(token.value)
            if ev is not None:
                events.append(ev)


def _coalesce_alt_enter(events: list[InputEvent]) -> list[InputEvent]:
    if len(events) < 2:
        return events
    out: list[InputEvent] = []
    i = 0
    while i < len(events):
        ev = events[i]
        nxt = events[i + 1] if i + 1 < len(events) else None
        if (
            isinstance(ev, KeyPress)
            and ev.key == "escape"
            and isinstance(nxt, KeyPress)
            and nxt.key == "enter"
        ):
            out.append(KeyPress(key="shift+enter", shift=True))
            i += 2
            continue
        out.append(ev)
        i += 1
    return out


def coalesce_paste_runs(events: list[InputEvent]) -> list[InputEvent]:
    if not events:
        return events
    out: list[InputEvent] = []
    i = 0
    n = len(events)
    while i < n:
        ev = events[i]
        if not isinstance(ev, KeyPress) or not _is_paste_run_char(ev):
            out.append(ev)
            i += 1
            continue
        
        chars: list[str] = []
        has_newline = False
        j = i
        while j < n:
            ev_j = events[j]
            if not isinstance(ev_j, KeyPress) or not _is_paste_run_char(ev_j):
                break
            if ev_j.key == "ctrl+j":
                chars.append("\n")
                has_newline = True
            else:
                
                chars.append(ev_j.char)
            j += 1
        
        run_len = j - i
        looks_like_paste = (has_newline and run_len >= 4) or run_len >= 64
        if looks_like_paste:
            out.append(PasteEvent(text="".join(chars)))
            i = j
        else:
            out.append(events[i])
            i += 1
    return out


def _is_paste_run_char(kp: KeyPress) -> bool:
    if kp.key == "ctrl+j":
        return True
    return bool(kp.char) and len(kp.char) == 1 and kp.char.isprintable()


def _parse_char(ch: str) -> KeyPress:
    code = ord(ch)
    if code == 0x0D:
        return KeyPress(key="enter", char="\r")
    if code == 0x1B:
        return KeyPress(key="escape")
    if code == 0x09:
        return KeyPress(key="tab", char="\t")
    if code == 0x7F:
        return KeyPress(key="backspace")
    if code < 0x20:
        
        letter = chr(code + 0x60)
        return KeyPress(key=f"ctrl+{letter}", ctrl=True, char=letter)
    return KeyPress(key=ch, char=ch)


def _parse_osc(body: str) -> InputEvent | None:
    body = body.rstrip("\x07")
    if body.endswith("\x1b\\"):
        body = body[:-2]

    code, sep, payload = body.partition(";")
    if not sep:
        return None

    if code == _OSC_UPLOAD_CODE:
        try:
            filename = base64.b64decode(payload.encode("ascii")).decode("utf-8")
        except Exception:
            logger.warning("OSC upload payload 解码失败，忽略")
            return None
        filename = filename.strip()
        if not filename:
            return None
        return UploadEvent(filename=filename)

    if code == _OSC_SWITCH_CONV_CODE:
        try:
            conv_id = base64.b64decode(payload.encode("ascii")).decode("utf-8")
        except Exception:
            logger.warning("OSC switch_conversation payload 解码失败，忽略")
            return None
        conv_id = conv_id.strip()
        if not conv_id:
            return None
        return SwitchConversationEvent(conversation_id=conv_id)

    return None


def _parse_sequence(seq: str) -> InputEvent | None:
    if not seq.startswith("\x1b"):
        return None


    if seq == PASTE_START:
        return None

    rest = seq[1:]

    if rest.startswith("]"):
        return _parse_osc(rest[1:])


    if rest.startswith("["):
        return _parse_csi(rest[1:])

    
    if rest.startswith("O"):
        body = rest[1:]
        key = _SS3_KEYS.get(body)
        if key:
            return KeyPress(key=key)
        return None

    
    
    
    
    if rest in ("\r", "\n"):
        return KeyPress(key="shift+enter", shift=True)

    
    if len(rest) == 1:
        ch = rest[0]
        return KeyPress(key=f"alt+{ch}", char=ch, alt=True)

    return None


def _parse_csi(body: str) -> InputEvent | None:
    if not body:
        return None

    
    if body.startswith("<"):
        return _parse_sgr_mouse(body[1:])

    
    
    if body.endswith("u") and ";" in body:
        try:
            cp_str, mod_str = body[:-1].split(";", 1)
            cp = int(cp_str)
            mod = int(mod_str)
        except ValueError:
            cp = 0
            mod = 0
        
        if cp == 13 and (mod - 1) & 1:
            return KeyPress(key="shift+enter", shift=True)

    
    if ";" in body and body[-1:].isalpha():
        parts = body[:-1].split(";")
        final = body[-1]
        if len(parts) == 2:
            modifier = int(parts[1]) - 1 if parts[1].isdigit() else 0
            base_key = _CSI_KEYS.get(final, "")
            if not base_key:
                base_key = _CSI_KEYS.get(parts[0] + "~", final)
            if base_key:
                kp = KeyPress(key=base_key)
                if modifier & 1:
                    kp.shift = True
                    kp.key = f"shift+{kp.key}"
                if modifier & 2:
                    kp.alt = True
                    kp.key = f"alt+{kp.key}"
                if modifier & 4:
                    kp.ctrl = True
                    kp.key = f"ctrl+{kp.key}"
                return kp

    
    key = _CSI_KEYS.get(body)
    if key:
        return KeyPress(key=key)

    return None


def _parse_sgr_mouse(body: str) -> MouseEvent | None:
    if not body or body[-1] not in "Mm":
        return None
    is_release = body[-1] == "m"
    parts = body[:-1].split(";")
    if len(parts) != 3:
        return None
    try:
        btn_code = int(parts[0])
        col = int(parts[1]) - 1
        row = int(parts[2]) - 1
    except ValueError:
        return None

    shift = bool(btn_code & 4)
    alt = bool(btn_code & 8)
    ctrl = bool(btn_code & 16)
    button = btn_code & 3

    if btn_code & 64:
        
        direction = btn_code & 1
        return MouseEvent(type="wheel", button=direction, x=col, y=row, shift=shift, alt=alt, ctrl=ctrl)
    if btn_code & 32:
        return MouseEvent(type="move", button=button, x=col, y=row, shift=shift, alt=alt, ctrl=ctrl)
    if is_release:
        return MouseEvent(type="release", button=button, x=col, y=row, shift=shift, alt=alt, ctrl=ctrl)
    return MouseEvent(type="press", button=button, x=col, y=row, shift=shift, alt=alt, ctrl=ctrl)
