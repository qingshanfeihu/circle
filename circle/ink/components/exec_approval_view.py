
from __future__ import annotations

from typing import Any, Callable

from ..theme import GLYPH_MILESTONE

_STAGE_PERMISSION = "permission"
_STAGE_ALWAYS = "always"

_OPTIONS_ALLOW = (
    {"key": "approve", "label": "Allow once"},
    {"key": "always", "label": "Allow always"},
    {"key": "reject", "label": "Reject"},
)
_OPTIONS_FORCED = (
    {"key": "approve", "label": "Allow once"},
    {"key": "reject", "label": "Reject"},
)
_OPTIONS_ALWAYS_CONFIRM = (
    {"key": "always_confirm", "label": "Confirm"},
    {"key": "always_cancel", "label": "Cancel"},
)


class ExecApprovalSession:

    def __init__(
        self,
        payload: dict[str, Any],
        *,
        render: Callable[[], None],
        on_finish: Callable[[dict[str, Any]], None],
    ) -> None:
        self._payload = dict(payload or {})
        self._render = render
        self._on_finish = on_finish
        self._stage = _STAGE_PERMISSION
        self._focus = 0
        self._options = self._main_options()

    def _main_options(self) -> list[dict[str, str]]:
        if self._payload.get("allow_always") is False:
            return list(_OPTIONS_FORCED)
        return list(_OPTIONS_ALLOW)

    def _header_title(self) -> str:
        if self._stage == _STAGE_ALWAYS:
            return "Always allow"
        return "Permission required"

    def render_lines(self) -> list[str]:
        Y, D, B, R = "\x1b[33m", "\x1b[2m", "\x1b[1m", "\x1b[0m"
        lines: list[str] = []
        lines.append(f" {Y}△{R} {B}{self._header_title()}{R}")
        if self._stage == _STAGE_ALWAYS:
            tool = str(self._payload.get("tool") or "tool")
            lines.append(
                f"   {D}This will allow {tool} until IST-Core is restarted.{R}"
            )
        else:
            icon = str(self._payload.get("icon") or GLYPH_MILESTONE)
            title = str(self._payload.get("title") or self._payload.get("tool") or "")
            lines.append(f"   {D}{icon}{R} {title}")
            body = str(self._payload.get("body") or "")
            for ln in body.splitlines() or [""]:
                lines.append(f"   {ln}")
            if self._payload.get("warn_delete"):
                lines.append(f"   {Y} This command deletes files. {R}")
            policy = str(self._payload.get("policy") or "")
            if policy:
                lines.append(f"   {D}{policy}{R}")
        lines.append("")
        btn_parts: list[str] = []
        for i, opt in enumerate(self._options):
            label = opt["label"]
            if i == self._focus:
                btn_parts.append(f"{Y}{label}{R}")
            else:
                btn_parts.append(f"{D}{label}{R}")
        lines.append("   " + "  ".join(btn_parts))
        lines.append(f"   {D}⇆ select · enter confirm{R}")
        return lines

    def _submit(self, idx: int) -> None:
        opt = self._options[idx]
        key = opt["key"]
        if self._stage == _STAGE_PERMISSION and key == "always":
            self._stage = _STAGE_ALWAYS
            self._options = list(_OPTIONS_ALWAYS_CONFIRM)
            self._focus = 0
            self._render()
            return
        if key == "always_cancel":
            self._stage = _STAGE_PERMISSION
            self._options = self._main_options()
            self._focus = 0
            self._render()
            return
        if key == "always_confirm":
            self._on_finish({"decision": "always"})
            return
        if key == "approve":
            self._on_finish({"decision": "approve"})
            return
        self._on_finish({"decision": "reject"})

    def handle_key(self, key: str, _char: str) -> bool:
        n = len(self._options)
        if n == 0:
            return False
        if key in ("left", "h") or (key == "tab" and False):
            self._focus = (self._focus - 1 + n) % n
            self._render()
            return True
        if key in ("right", "l", "tab"):
            self._focus = (self._focus + 1) % n
            self._render()
            return True
        if key == "enter":
            self._submit(self._focus)
            return True
        if key == "escape":
            if self._stage == _STAGE_ALWAYS:
                cancel_idx = next(
                    i for i, o in enumerate(self._options) if o["key"] == "always_cancel"
                )
                self._submit(cancel_idx)
            else:
                reject_idx = next(
                    i for i, o in enumerate(self._options) if o["key"] == "reject"
                )
                self._submit(reject_idx)
            return True
        return False


class SessionApprovalsSession:

    def __init__(
        self,
        *,
        lines: list[str],
        options: list[dict[str, str]],
        render: Callable[[], None],
        on_finish: Callable[[str], None],
    ) -> None:
        self._lines = list(lines)
        self._options = list(options)
        self._render = render
        self._on_finish = on_finish
        self._focus = 0

    def render_lines(self) -> list[str]:
        Y, D, B, R = "\x1b[33m", "\x1b[2m", "\x1b[1m", "\x1b[0m"
        out = [f" {Y}△{R} {B}Session approvals{R}", f"   {D}☰ /approvals{R}"]
        for ln in self._lines:
            out.append(f"   {D}{ln}{R}" if ln.startswith("[") else f"   {ln}")
        out.append("")
        btn_parts = []
        for i, opt in enumerate(self._options):
            label = opt["label"]
            btn_parts.append(f"{Y}{label}{R}" if i == self._focus else f"{D}{label}{R}")
        out.append("   " + "  ".join(btn_parts))
        out.append(f"   {D}⇆ select · enter confirm{R}")
        return out

    def handle_key(self, key: str, _char: str) -> bool:
        n = len(self._options)
        if n == 0:
            return False
        if key in ("left", "h"):
            self._focus = (self._focus - 1 + n) % n
            self._render()
            return True
        if key in ("right", "l", "tab"):
            self._focus = (self._focus + 1) % n
            self._render()
            return True
        if key == "enter":
            self._on_finish(self._options[self._focus]["key"])
            return True
        if key == "escape":
            self._on_finish("close")
            return True
        return False


__all__ = ["ExecApprovalSession", "SessionApprovalsSession"]
