"""Apply built-in or file palettes to the existing Circle renderer."""
from __future__ import annotations

import json
from pathlib import Path

from circle.ink.theme import build_palette, init_palette_from_terminal, set_palette


def apply_theme(name: str, home: Path) -> None:
    if name == "terminal":
        init_palette_from_terminal()
        return
    colors = {"dark": ("#d6dee6", "#10151a"), "light": ("#20252b", "#fafafa")}
    if name in colors:
        fg, bg = colors[name]
    else:
        if not name or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for ch in name):
            raise ValueError("Invalid theme name")
        data = json.loads((home / "themes" / f"{name}.json").read_text())
        fg, bg = data["foreground"], data["background"]
        if any(not isinstance(v, str) or len(v) != 7 or not v.startswith("#")
               or any(c not in "0123456789abcdefABCDEF" for c in v[1:]) for v in (fg, bg)):
            raise ValueError("Theme colors must be #RRGGBB")
    set_palette(build_palette(fg, bg))
