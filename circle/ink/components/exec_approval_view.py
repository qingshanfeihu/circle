"""Tool approval as a card (contract 2026-09-29, R1–R3).

The approval is the composer frame with different content, not a panel stacked above
it. The session hands ``card_spec()`` to the frame; keys are handled here.

Options, in order: ``Allow once``, ``Allow <scope> for this session`` (only when the
policy lets the call be remembered), ``Allow "<words> …" for this session`` (every command
that starts with those words; offered for a simple command) and ``Reject and explain``.
Digits pick and confirm; ``y`` / ``a`` / ``n`` do the same without being shown; ``up`` /
``down`` move; ``enter`` confirms the focused row; ``esc`` and ``n`` reject at once.
``Reject and explain`` turns the frame's last row into an input: ``enter`` sends the text
to the model with the rejection, an empty ``enter`` is a plain rejection, ``esc`` goes
back to the options.

While the card is up every printable key is swallowed — a stray ``y`` typed for the
composer must not answer the question, and nothing typed is lost because the draft was
saved when the card appeared. Control keys (ctrl+c and friends) and scrolling pass on.
"""

from __future__ import annotations

from typing import Any, Callable

from circle.display_lexicon import tool_short_name

from .dialog_card import CardLine, CardOption, CardSpec, PopupItem, card_rows, popup_rows

# isdigit() is true for ² and ①, and int() of those raises: only these nine keys are answers.
_DIGITS = frozenset("123456789")

_APPROVE = "approve"
_ALWAYS = "always"
_PREFIX = "prefix"
_EXPLAIN = "explain"

# keys that are not the card's business and must reach the session (interrupt, scroll…)
_PASS_THROUGH = frozenset({"pageup", "pagedown", "home", "end"})


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
        self._focus = 0
        self._input = False
        self._options = self._build_options()

    # ── content ─────────────────────────────────────────────────────────

    def _build_options(self) -> list[tuple[str, str]]:
        opts = [(_APPROVE, "Allow once")]
        if self._payload.get("allow_always") is not False:
            scope = str(self._payload.get("scope") or "this call")
            opts.append((_ALWAYS, f"Allow {scope} for this session"))
        prefix = str(self._payload.get("prefix_scope") or "")
        if prefix:
            opts.append((_PREFIX, f"Allow {prefix} for this session"))
        opts.append((_EXPLAIN, "Reject and explain"))
        return opts

    @property
    def in_input(self) -> bool:
        return self._input

    def card_spec(self) -> CardSpec:
        p = self._payload
        name = tool_short_name(str(p.get("tool") or p.get("title") or "tool"))
        more = int(p.get("more") or 0)
        title = f"{name} needs your permission" + (f" · {more} more" if more else "")
        origin = str(p.get("origin") or "")
        if origin:  # a background agent asks: its job comes first
            title = f"{origin} · {title}"
        body: list[CardLine] = []
        for i, ln in enumerate(str(p.get("body") or "").splitlines() or [""]):
            body.append(CardLine(ln, "em" if i == 0 else "text"))
        # a file change: what it adds and removes, coloured like the diff after the edit
        for row in p.get("preview") or ():
            tone = str(row.get("tone") or "")
            body.append(CardLine(str(row.get("text") or ""),
                                 tone if tone in ("added", "removed") else "faint"))
        if p.get("warn_delete"):
            body.append(CardLine("This deletes or overwrites data.", "warn"))
        policy = str(p.get("policy") or "")
        if policy:
            body.append(CardLine(policy, "dim"))
        return CardSpec(
            title=title,
            body=body,
            options=[CardOption(label) for _key, label in self._options],
            focus=self._focus,
            tint=str(p.get("tint") or ""),
            input_row=self._input,
        )

    def render_lines(self, width: int = 80) -> list[str]:
        """The card as plain rows (the legacy line-oriented controller shows these)."""
        return card_rows(self.card_spec(), width)

    # ── keys ────────────────────────────────────────────────────────────

    def _index_of(self, kind: str) -> int | None:
        for i, (key, _label) in enumerate(self._options):
            if key == kind:
                return i
        return None

    def _submit(self, idx: int) -> None:
        kind = self._options[idx][0]
        if kind == _APPROVE:
            self._on_finish({"decision": "approve"})
        elif kind in (_ALWAYS, _PREFIX):
            self._on_finish({"decision": kind})
        else:
            self._focus = idx
            self._input = True
            self._render()

    def submit_reason(self, text: str) -> None:
        """``enter`` in the reason row: the text rides with the rejection (empty = plain)."""
        self._on_finish({"decision": "reject", "message": str(text or "").strip()})

    def cancel_input(self) -> None:
        self._input = False
        self._render()

    def handle_key(self, key: str, char: str) -> bool:
        if self._input:
            return False  # the session routes typing, enter and esc for the reason row
        n = len(self._options)
        ch = char if len(char or "") == 1 else (key if len(key or "") == 1 else "")
        if key in ("up", "left", "ctrl+p") or ch in ("k", "h"):
            self._focus = (self._focus - 1) % n
            self._render()
            return True
        if key in ("down", "right", "tab", "ctrl+n") or ch in ("j", "l"):
            self._focus = (self._focus + 1) % n
            self._render()
            return True
        if key in ("enter", "return"):
            self._submit(self._focus)
            return True
        if key == "escape" or ch in ("n", "N"):
            self._on_finish({"decision": "reject"})
            return True
        if ch in _DIGITS:
            idx = int(ch) - 1
            if 0 <= idx < n:
                self._submit(idx)
            return True
        if ch in ("y", "Y"):
            self._submit(0)
            return True
        if ch in ("a", "A"):
            idx = self._index_of(_ALWAYS)
            if idx is not None:
                self._submit(idx)
            return True
        if (key or "").startswith("ctrl+") or key in _PASS_THROUGH:
            return False
        return True  # printable and everything else: swallowed


class SessionApprovalsSession:
    """``/approvals``: the session's always-allow rules as a popup above the frame.

    Not a blocking question, so not a card: rows on the panel background, ``up`` /
    ``down`` and digits pick, ``enter`` confirms, ``esc`` closes.
    """

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

    def render_lines(self, width: int = 100) -> list[str]:
        items = [PopupItem(opt["label"]) for opt in self._options]
        return popup_rows("Session approvals", items, self._focus, width, info=self._lines)

    def handle_key(self, key: str, char: str) -> bool:
        n = len(self._options)
        if n == 0:
            return False
        ch = char if len(char or "") == 1 else (key if len(key or "") == 1 else "")
        if key in ("up", "ctrl+p") or ch == "k":
            self._focus = (self._focus - 1) % n
            self._render()
            return True
        if key in ("down", "tab", "ctrl+n") or ch == "j":
            self._focus = (self._focus + 1) % n
            self._render()
            return True
        if key in ("enter", "return"):
            self._on_finish(self._options[self._focus]["key"])
            return True
        if key == "escape":
            self._on_finish("close")
            return True
        if ch in _DIGITS and 1 <= int(ch) <= n:
            self._on_finish(self._options[int(ch) - 1]["key"])
            return True
        return False


__all__ = ["ExecApprovalSession", "SessionApprovalsSession"]
