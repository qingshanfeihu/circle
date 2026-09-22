
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from .ansi import C0, ESC_TYPE, is_esc_final
from .csi import is_csi_final, is_csi_intermediate, is_csi_param


@dataclass(slots=True)
class Token:
    type: Literal["text", "sequence"]
    value: str


State = Literal[
    "ground", "escape", "escapeIntermediate",
    "csi", "ss3", "osc", "dcs", "apc",
]


class Tokenizer:

    def __init__(self, *, x10_mouse: bool = False) -> None:
        self._state: State = "ground"
        self._buffer: str = ""
        self._x10_mouse = x10_mouse

    def feed(self, input_str: str) -> list[Token]:
        tokens, state, buf = _tokenize(
            input_str, self._state, self._buffer, False, self._x10_mouse,
        )
        self._state = state
        self._buffer = buf
        return tokens

    def flush(self) -> list[Token]:
        tokens, state, buf = _tokenize(
            "", self._state, self._buffer, True, self._x10_mouse,
        )
        self._state = state
        self._buffer = buf
        return tokens

    def reset(self) -> None:
        self._state = "ground"
        self._buffer = ""

    @property
    def buffer(self) -> str:
        return self._buffer


def _tokenize(
    input_str: str,
    initial_state: State,
    initial_buffer: str,
    flush: bool,
    x10_mouse: bool,
) -> tuple[list[Token], State, str]:
    tokens: list[Token] = []
    state: State = initial_state
    buf = ""

    data = initial_buffer + input_str
    i = 0
    text_start = 0
    seq_start = 0

    def flush_text() -> None:
        nonlocal text_start
        if i > text_start:
            t = data[text_start:i]
            if t:
                tokens.append(Token(type="text", value=t))
        text_start = i

    def emit_sequence(seq: str) -> None:
        nonlocal state, text_start
        if seq:
            tokens.append(Token(type="sequence", value=seq))
        state = "ground"
        text_start = i

    while i < len(data):
        code = ord(data[i])

        if state == "ground":
            if code == C0.ESC_BYTE:
                flush_text()
                seq_start = i
                state = "escape"
                i += 1
            else:
                i += 1

        elif state == "escape":
            if code == ESC_TYPE.CSI:
                state = "csi"
                i += 1
            elif code == ESC_TYPE.OSC:
                state = "osc"
                i += 1
            elif code == ESC_TYPE.DCS:
                state = "dcs"
                i += 1
            elif code == ESC_TYPE.APC:
                state = "apc"
                i += 1
            elif code == 0x4F:
                state = "ss3"
                i += 1
            elif is_csi_intermediate(code):
                state = "escapeIntermediate"
                i += 1
            elif is_esc_final(code):
                i += 1
                emit_sequence(data[seq_start:i])
            elif code == C0.ESC_BYTE:
                emit_sequence(data[seq_start:i])
                seq_start = i
                state = "escape"
                i += 1
            else:
                state = "ground"
                text_start = seq_start

        elif state == "escapeIntermediate":
            if is_csi_intermediate(code):
                i += 1
            elif is_esc_final(code):
                i += 1
                emit_sequence(data[seq_start:i])
            else:
                state = "ground"
                text_start = seq_start

        elif state == "csi":
            if (
                x10_mouse
                and code == 0x4D
                and i - seq_start == 2
                and (i + 1 >= len(data) or ord(data[i + 1]) >= 0x20)
                and (i + 2 >= len(data) or ord(data[i + 2]) >= 0x20)
                and (i + 3 >= len(data) or ord(data[i + 3]) >= 0x20)
            ):
                if i + 4 <= len(data):
                    i += 4
                    emit_sequence(data[seq_start:i])
                else:
                    i = len(data)
            elif is_csi_final(code):
                i += 1
                emit_sequence(data[seq_start:i])
            elif is_csi_param(code) or is_csi_intermediate(code):
                i += 1
            else:
                state = "ground"
                text_start = seq_start

        elif state == "ss3":
            if 0x40 <= code <= 0x7E:
                i += 1
                emit_sequence(data[seq_start:i])
            else:
                state = "ground"
                text_start = seq_start

        elif state in ("osc", "dcs", "apc"):
            if code == C0.BEL:
                i += 1
                emit_sequence(data[seq_start:i])
            elif (
                code == C0.ESC_BYTE
                and i + 1 < len(data)
                and ord(data[i + 1]) == ESC_TYPE.ST
            ):
                i += 2
                emit_sequence(data[seq_start:i])
            else:
                i += 1

    
    if state == "ground":
        flush_text()
    elif flush:
        remaining = data[seq_start:]
        if remaining:
            tokens.append(Token(type="sequence", value=remaining))
        state = "ground"
        buf = ""
    else:
        buf = data[seq_start:]

    return tokens, state, buf
