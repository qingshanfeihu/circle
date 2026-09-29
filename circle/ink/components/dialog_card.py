"""The one card for every blocking question, and the one popup for every list.

Contract (2026-09-29): a question that stops the turn — a tool approval, the model's
``question``, a secret — is not a second box. It is the composer frame with different
content: a title row with the *waiting* lamp, the body, a blank row, then a vertical
menu. The key sits in its own column (digits; mnemonic letters work but are not shown),
the label in the next, and the focused row is painted whole with ``sel_bg``. Nothing
here teaches keys: no ``enter to confirm`` line.

A list that does not stop the turn (``/approvals``, later ``/models``) is a popup: rows
above the frame on the panel background, no border.

Both return rows already padded to their width, so a block is a solid rectangle. The
session app puts the card's rows between the frame's top and bottom edges and draws the
side bars itself.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from ..string_width import char_width, string_width
from ..theme import palette, sgr_join, status_light

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


@dataclass
class CardLine:
    text: str
    tone: str = "text"  # em | text | dim | warn | err


@dataclass
class CardOption:
    label: str
    note: str = ""              # dim text after the label
    selected: bool | None = None  # multi-select: True / False draw [x] / [ ]; None = plain
    key: str = ""               # key column text; "" = the option's number


@dataclass
class CardSpec:
    title: str
    body: list[CardLine] = field(default_factory=list)
    options: list[CardOption] = field(default_factory=list)
    focus: int = 0
    notes: list[CardLine] = field(default_factory=list)
    tint: str = ""              # SGR background of the title and body rows ("" = none)
    input_row: bool = False     # the frame shows the prompt row under the options


@dataclass
class PopupItem:
    label: str
    meta: str = ""
    current: bool = False


def visible_width(text: str) -> int:
    return string_width(_ANSI.sub("", text))


def wrap(text: str, width: int) -> list[str]:
    """Wrap by display width. Latin words break at spaces, CJK breaks anywhere."""
    if width <= 0 or string_width(text) <= width:
        return [text]
    lines: list[str] = []
    cur: list[str] = []
    col = 0
    last_space = -1
    for ch in text:
        cw = char_width(ch)
        if ch == " " and col + cw > width:
            lines.append("".join(cur).rstrip())  # the space is the break: it does not start the next line
            cur, col, last_space = [], 0, -1
            continue
        if col + cw > width:
            if 0 < last_space and ch.isascii() and (len(cur) - last_space) < width * 0.4:
                lines.append("".join(cur[:last_space]).rstrip())
                cur = cur[last_space + 1:]
            else:
                lines.append("".join(cur))
                cur = []
            col = string_width("".join(cur))
            last_space = -1
        cur.append(ch)
        col += cw
        if ch == " ":
            last_space = len(cur) - 1
    if cur:
        lines.append("".join(cur))
    return [ln for ln in lines if ln.strip()] or [""]


def _compose(width: int, segs: list[tuple[str, str]], bg: str = "") -> str:
    """Segments in order, cut at ``width``, padded with the background to the full width."""
    pal = palette()
    out: list[str] = []
    used = 0
    for text, sgr in segs:
        room = width - used
        if room <= 0:
            break
        if string_width(text) > room:
            kept: list[str] = []
            col = 0
            for ch in text:
                cw = char_width(ch)
                if col + cw > room - 1:
                    break
                kept.append(ch)
                col += cw
            text = "".join(kept) + "…"
        used += string_width(text)
        code = sgr_join(bg, sgr) if bg else sgr
        out.append(f"{code}{text}" if code else f"{pal.reset}{text}")
    if used < width:
        out.append(f"{bg or pal.reset}{' ' * (width - used)}")
    out.append(pal.reset)
    return "".join(out)


def _tone(pal, tone: str) -> str:
    return {"em": pal.em, "dim": pal.dim, "warn": pal.yellow, "err": pal.red}.get(tone, pal.text)


def card_rows(spec: CardSpec, width: int, max_rows: int | None = None) -> list[str]:
    """The card's inner rows, each ``width`` columns wide (the frame adds the side bars).

    Grid: marker column 1 (lamp / key), text column 3 — the same as the composer row and
    the transcript, shifted by the frame's own side bar.

    ``max_rows`` keeps the card on a short screen: when the body is what makes it too tall,
    the body is cut and says how much (``… +12 lines``) so the menu underneath is never
    clipped away. The title and the options are never cut."""
    pal = palette()
    width = max(12, width)
    tint = spec.tint
    lamp_code, lamp_glyph = status_light("wait", reset=False).rsplit("m", 1)
    head = _compose(width, [(" ", ""), (lamp_glyph, lamp_code + "m"), (" ", ""), (spec.title, pal.em)], tint)
    body: list[str] = []
    for line in spec.body:
        for part in wrap(line.text, width - 4):
            body.append(_compose(width, [("   ", ""), (part, _tone(pal, line.tone))], tint))
    menu: list[str] = []
    if spec.options:
        menu.append(_compose(width, []))
    keys = [opt.key or str(i + 1) for i, opt in enumerate(spec.options)]
    key_w = max((string_width(k) for k in keys), default=1)
    for i, opt in enumerate(spec.options):
        mark = "" if opt.selected is None else ("[x] " if opt.selected else "[ ] ")
        text_w = width - 3 - key_w - string_width(mark)
        # label and note wrap as one text (an option is never cut), the note is dimmed by offset
        full = opt.label + (f" — {opt.note}" if opt.note else "")
        parts = wrap(full, max(8, text_w))
        focused = i == spec.focus
        on = sgr_join(pal.sel_bg, pal.em)
        used = 0  # characters of `full` consumed by earlier rows
        for k, part in enumerate(parts):
            lead = keys[i].ljust(key_w) if k == 0 else " " * key_w
            lead_mark = mark if k == 0 else " " * string_width(mark)
            cut = max(0, len(opt.label) - used)  # how much of this row is still the label
            label_part, note_part = part[:cut], part[cut:]
            used += len(part) + (1 if k < len(parts) - 1 else 0)  # wrap drops the space at a break
            segs: list[tuple[str, str]] = [(" ", ""), (lead, "" if focused else pal.dim), (" ", ""),
                                           (lead_mark, pal.green if opt.selected else ""),
                                           (label_part, "" if focused else pal.text)]
            if note_part:
                segs.append((note_part, "" if focused else pal.dim))
            menu.append(_compose(width, [(t, on if focused and not s else s) for t, s in segs],
                                 pal.sel_bg if focused else ""))
    notes: list[str] = []
    for line in spec.notes:
        for part in wrap(line.text, width - 4):
            notes.append(_compose(width, [("   ", ""), (part, _tone(pal, line.tone))]))
    if max_rows is not None:
        room = max_rows - 1 - len(menu) - len(notes)  # what is left for the body
        if len(body) > max(1, room):
            keep = max(1, room - 1)
            hidden = len(body) - keep
            body = body[:keep] + [_compose(width, [("   ", ""), (f"… +{hidden} lines", pal.dim)], tint)]
    return [head, *body, *menu, *notes]


def popup_rows(title: str, items: list[PopupItem], focus: int, width: int,
               info: list[str] | tuple[str, ...] = ()) -> list[str]:
    """A non-blocking list above the frame: panel background, no border, focused row ``sel_bg``.

    ``info`` rows sit under the title as plain context; only ``items`` take focus."""
    pal = palette()
    width = max(12, width)
    rows = [_compose(width, [(" ", ""), (title, pal.faint)], pal.panel_bg)]
    for text in info:
        for part in wrap(text, width - 4):
            rows.append(_compose(width, [("   ", ""), (part, pal.dim)], pal.panel_bg))
    name_w = max((string_width(item.label) for item in items), default=0) + 3
    for i, item in enumerate(items):
        tag = " · current" if item.current else ""
        pad = " " * max(0, name_w - string_width(item.label))
        if i == focus:
            rows.append(_compose(width, [(f"   {item.label}{pad}{item.meta}{tag}", sgr_join(pal.sel_bg, pal.em))],
                                 pal.sel_bg))
        else:
            rows.append(_compose(width, [("   ", ""), (item.label + pad, pal.text), (item.meta + tag, pal.dim)],
                                 pal.panel_bg))
    return rows


__all__ = ["CardLine", "CardOption", "CardSpec", "PopupItem", "card_rows", "popup_rows", "visible_width", "wrap"]
