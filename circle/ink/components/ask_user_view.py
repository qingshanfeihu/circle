"""The question panel for the ``question`` tool (InfoTest ``ask_user_view.AskUserSession``).

The panel collects one answer per question and hands them to ``on_answer`` as lists
of labels (a typed answer is one more entry); ``on_answer(None)`` means the user
closed the panel without answering. The session then resumes the paused tool with
those answers, so the model gets exactly what was chosen.

Question shape: ``question``, ``header``, ``options`` (``label`` / ``description``),
``multiSelect``, ``allow_other`` (a typed answer; on unless false).
"""

from __future__ import annotations

from typing import Callable

from ..theme import palette
from .dialog_card import CardLine, CardOption, CardSpec, card_rows

_OTHER_VALUE = "__other__"
_DIGITS = frozenset("123456789")  # not str.isdigit(): ² and ① are digits to it and int() rejects them


def indent_continuations(text: str, prefix: str = "   ") -> str:
    lines = str(text).split("\n")
    return "\n".join([lines[0]] + [f"{prefix}{ln}" if ln else "" for ln in lines[1:]])


class AskUserSession:

    def __init__(
        self,
        questions: list[dict],
        *,
        render: Callable[[], None],
        on_answer: Callable[[list[list[str]] | None], None],
        origin: str = "",
    ) -> None:
        self._questions = questions
        self._origin = origin
        self._render = render
        self._on_answer = on_answer
        self._q_idx = 0
        self._selected: list[set[str]] = [set() for _ in questions]
        self._highlight = 0
        self._other_text: dict[int, str] = {}
        self._other_input = False
        self._other_empty_hint = False
        self._touched: list[bool] = [False] * len(questions)
        self._leave_warn: str | None = None
        self._warned_op: str | None = None
        self._expanded = False
        self._answers: list[list[str]] | None = None

    @property
    def in_other_input(self) -> bool:
        return self._other_input

    def _cur_question(self) -> dict:
        return self._questions[self._q_idx]

    def _options(self) -> list[dict]:
        return self._cur_question().get("options", []) or []

    def _allow_other(self, q_idx: int | None = None) -> bool:
        idx = self._q_idx if q_idx is None else q_idx
        return self._questions[idx].get("allow_other") is not False

    def _rows_count(self) -> int:
        return len(self._options()) + (1 if self._allow_other() else 0)

    def card_spec(self) -> CardSpec:
        """The question as a card (contract R3). Options are one numbered menu; a typed answer
        is the last row (``Type your own``, key ``o``); nothing here teaches keys."""
        q = self._cur_question()
        multi = bool(q.get("multiSelect"))
        sel = self._selected[self._q_idx]
        total = len(self._questions)
        title = "The model has a question" + (f" · {self._q_idx + 1}/{total}" if total > 1 else "")
        if self._origin:  # a background agent asks: its job comes first
            title = f"{self._origin} · {title}"
        header = str(q.get("header", "") or "")
        q_lines = str(q.get("question", "")).split("\n")
        body: list[CardLine] = []
        if len(q_lines) > 6 and not self._expanded:
            body += [CardLine(ln, "em") for ln in q_lines[:4]]
            body.append(CardLine(f"… +{len(q_lines) - 5} lines · ctrl+o", "dim"))
            body.append(CardLine(q_lines[-1], "em"))
        else:
            body += [CardLine(ln, "em") for ln in q_lines]
        if header:
            body.append(CardLine(header, "dim"))
        options: list[CardOption] = []
        for opt in self._options():
            label = str(opt.get("label", ""))
            options.append(CardOption(label, note=str(opt.get("description", "") or ""),
                                      selected=(label in sel) if multi else None))
        notes: list[CardLine] = []
        if self._allow_other():
            typed = self._other_text.get(self._q_idx)
            options.append(CardOption("Type your own", key="o",
                                      selected=(_OTHER_VALUE in sel) if multi else None))
            if typed:
                notes.append(CardLine(f"→ {typed}", "text"))
            if self._other_empty_hint:
                notes.append(CardLine("An answer can't be empty. Type something or press esc.", "warn"))
        if self._leave_warn:
            notes.append(CardLine(self._leave_warn, "warn"))
        return CardSpec(title=title, body=body, options=options,
                        focus=min(self._highlight, max(0, len(options) - 1)),
                        notes=notes, tint=palette().think_bg, input_row=self._other_input)

    def render_lines(self, width: int = 100) -> list[str]:
        """The card as plain rows (tests and the legacy line-oriented controller read this)."""
        return card_rows(self.card_spec(), width)

    def handle_key(self, key: str, char: str) -> bool:
        if self._other_input:
            return False
        rows_count = self._rows_count()
        if key in ("up", "ctrl+p"):
            self._clear_warn()
            self._touched[self._q_idx] = True
            self._highlight = (self._highlight - 1) % rows_count
            self._render()
            return True
        if key in ("down", "ctrl+n"):
            self._clear_warn()
            self._touched[self._q_idx] = True
            self._highlight = (self._highlight + 1) % rows_count
            self._render()
            return True
        if key and key in _DIGITS:
            n = int(key)
            if 1 <= n <= rows_count:
                if self._warned_op == "submit":
                    self._clear_warn()
                    self._submit()
                    return True
                self._clear_warn()
                self._touched[self._q_idx] = True
                self._highlight = n - 1
                if self._is_other_highlighted():
                    self._other_input = True
                    self._render()
                    return True
                if self._cur_question().get("multiSelect"):
                    self._toggle_current()
                    self._render()
                else:
                    self._selected[self._q_idx] = {self._options()[self._highlight].get("label", "")}
                    self._advance_or_submit()
            return True
        if key in ("space", " "):
            self._clear_warn()
            self._toggle_current()
            self._render()
            return True
        if key == "escape":
            if self._guard_cancel():
                self.cancel()
            return True
        if len(self._questions) > 1:
            if key in ("left", "shift+tab"):
                if self._guard_switch(self._q_idx - 1):
                    self._goto_question(self._q_idx - 1)
                return True
            if key in ("right", "tab"):
                if self._guard_switch(self._q_idx + 1):
                    self._goto_question(self._q_idx + 1)
                return True
        if key in ("ctrl+o", "ctrl+t"):
            self._expanded = not self._expanded
            self._render()
            return True
        if key in ("o", "O") or char in ("o", "O"):
            if self._allow_other():
                self._clear_warn()
                self._highlight = rows_count - 1
                self._other_input = True
                self._render()
            return True
        if key in ("return", "enter"):
            if self._warned_op == "submit":
                self._clear_warn()
                self._submit()
                return True
            self._on_enter()
            return True
        if key in ("ctrl+c", "ctrl+d"):
            return False
        return True

    def _is_other_highlighted(self) -> bool:
        return self._allow_other() and self._highlight == len(self._options())

    def _has_uncommitted_selection(self) -> bool:
        return self._touched[self._q_idx] and not self._selected[self._q_idx]

    def _unanswered_count(self) -> int:
        return sum(1 for sel in self._selected if not sel)

    def _warn_once(self, op: str, msg: str) -> bool:
        if self._warned_op == op:
            self._clear_warn()
            return True
        self._warned_op = op
        self._leave_warn = msg
        self._render()
        return False

    def _clear_warn(self) -> None:
        self._leave_warn = None
        self._warned_op = None

    def _guard_switch(self, target_idx: int) -> bool:
        if not (0 <= target_idx < len(self._questions)) or not self._has_uncommitted_selection():
            return True
        return self._warn_once("switch", "Not chosen yet. Press enter to choose, or switch again to skip it.")

    def _guard_cancel(self) -> bool:
        if self._has_uncommitted_selection():
            return self._warn_once("cancel", "Not chosen yet. Press enter to choose, or esc again to drop the question.")
        answered = sum(1 for sel in self._selected if sel)
        if answered:
            return self._warn_once("cancel", f"{answered} answered. Press esc again to drop them all.")
        return True

    def _toggle_current(self) -> None:
        if not self._cur_question().get("multiSelect"):
            return
        self._touched[self._q_idx] = True
        sel = self._selected[self._q_idx]
        key = _OTHER_VALUE if self._is_other_highlighted() else \
            self._options()[self._highlight].get("label", "")
        if key in sel:
            sel.discard(key)
        else:
            sel.add(key)

    def _on_enter(self) -> None:
        q = self._cur_question()
        if self._is_other_highlighted():
            self._clear_warn()
            self._other_input = True
            self._render()
            return
        if not q.get("multiSelect"):
            self._selected[self._q_idx] = {self._options()[self._highlight].get("label", "")}
        elif self._has_uncommitted_selection() and not self._warn_once(
                "advance", "Nothing ticked yet. Tick with space, or press enter again to go on without."):
            return
        self._advance_or_submit()

    def submit_other_text(self, text: str) -> None:
        if not self._allow_other():
            self._other_input = False
            self._render()
            return
        stripped = text.strip()
        if not stripped:
            self._other_empty_hint = True
            self._render()
            return
        self._other_empty_hint = False
        self._other_text[self._q_idx] = stripped
        if self._cur_question().get("multiSelect"):
            self._selected[self._q_idx].add(_OTHER_VALUE)
        else:
            self._selected[self._q_idx] = {_OTHER_VALUE}
        self._other_input = False
        self._advance_or_submit()

    def cancel_other_input(self) -> None:
        self._other_empty_hint = False
        self._other_input = False
        self._render()

    def _advance_or_submit(self) -> None:
        if self._q_idx < len(self._questions) - 1:
            self._q_idx += 1
            self._highlight = self._highlight_for(self._q_idx)
            self._clear_warn()
            self._render()
            return
        missing = self._unanswered_count()
        if missing and not self._warn_once(
                "submit",
                f"{missing} unanswered. Press enter again to send them as empty."
                if len(self._questions) > 1 else
                "Nothing chosen. Press enter again to send an empty answer."):
            return
        self._submit()

    def _highlight_for(self, idx: int) -> int:
        sel = self._selected[idx]
        for i, opt in enumerate(self._options_at(idx)):
            if opt.get("label", "") in sel:
                return i
        if _OTHER_VALUE in sel and self._allow_other(idx):
            return len(self._options_at(idx))
        return 0

    def _goto_question(self, idx: int) -> None:
        if 0 <= idx < len(self._questions):
            self._q_idx = idx
            self._highlight = self._highlight_for(idx)
            self._clear_warn()
            self._render()

    def _options_at(self, q_idx: int) -> list[dict]:
        return self._questions[q_idx].get("options", []) or []

    def answer_for(self, q_idx: int) -> list[str]:
        sel = self._selected[q_idx]
        out = [opt.get("label", "") for opt in self._options_at(q_idx) if opt.get("label", "") in sel]
        if _OTHER_VALUE in sel and self._other_text.get(q_idx, "").strip():
            out.append(self._other_text[q_idx].strip())
        return out

    def result_summary(self) -> str:
        """One faint line for the transcript once the question is settled."""
        if self._answers is None:
            return "Question cancelled"
        parts = [f"{q.get('question', '')} → {', '.join(a)}"
                 for q, a in zip(self._questions, self._answers) if a]
        if not parts:
            return "Question answered with nothing"
        return f"Answered · {indent_continuations(' · '.join(parts))}"

    def _submit(self) -> None:
        self._answers = [self.answer_for(i) for i in range(len(self._questions))]
        self._on_answer(self._answers)

    def cancel(self) -> None:
        self._answers = None
        self._on_answer(None)


__all__ = ["AskUserSession", "indent_continuations"]
