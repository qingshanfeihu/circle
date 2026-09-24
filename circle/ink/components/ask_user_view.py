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

_OTHER_VALUE = "__other__"


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
    ) -> None:
        self._questions = questions
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

    def render_lines(self) -> list[str]:
        q = self._cur_question()
        opts = self._options()
        multi = bool(q.get("multiSelect"))
        sel = self._selected[self._q_idx]
        pal = palette()
        B, D, C, G, Y, X = pal.em, pal.dim, pal.blue, pal.green, pal.yellow, pal.reset
        lines: list[str] = []
        if self._other_input:
            lines.append(f" {C}✎{X} {B}正在输入自己的回答{X}{D}——在下方输入框打字，"
                         f"enter 提交 · esc 取消{X}")
        header = q.get("header", "")
        total = len(self._questions)
        nav = f" ({self._q_idx + 1}/{total})" if total > 1 else ""
        q_text = indent_continuations(str(q.get("question", "")))
        q_lines = q_text.split("\n")
        if len(q_lines) > 6 and not self._expanded:
            folded = "\n".join(q_lines[:4])
            hint = f"   {D}… +{len(q_lines) - 5} 行（ctrl+o 展开）{X}"
            lines.append(f" {C}?{X} {B}{folded}\n{hint}\n{q_lines[-1]}{X}{D}{nav}{X}")
        else:
            lines.append(f" {C}?{X} {B}{q_text}{X}{D}{nav}{X}")
        if header:
            lines.append(f"   {D}[{header}]{X}")

        rows = list(opts)
        if self._allow_other():
            rows.append({"label": "Other", "description": "自己输入回答", "_other": True})
        for i, opt in enumerate(rows):
            label = opt.get("label", "")
            desc = opt.get("description", "")
            is_other = opt.get("_other")
            focused = i == self._highlight
            selected = (_OTHER_VALUE if is_other else label) in sel
            marker = (f"{G}[x]{X} " if selected else "[ ] ") if multi else ""
            cursor = f"{C}❯{X}" if focused else " "
            styled = f"{G}{label}{X}" if selected else (f"{B}{label}{X}" if focused else label)
            line = f" {cursor} {D}{i + 1}.{X} {marker}{styled}"
            if desc:
                line += f"  {G if selected else D}— {desc}{X}"
            lines.append(line)
            if is_other and self._other_text.get(self._q_idx):
                lines.append(f"       {G}→ {self._other_text[self._q_idx]}{X}")
            if is_other and self._other_empty_hint:
                lines.append(f"       {Y}回答不能为空，请输入内容或按 esc 取消{X}")

        last_q = self._q_idx == total - 1
        hint = "↑↓ 移动 · "
        if multi:
            hint += "数字/space 勾选 · " + ("enter 提交 · " if last_q else "enter 下一题 · ")
        else:
            hint += "数字/enter 选定并提交 · " if last_q else "数字/enter 选定并进下题 · "
        if total > 1:
            hint += "←→/Tab 切题 · "
        if self._allow_other():
            hint += "o 自己输入 · "
        hint += "esc 取消"
        lines.append(f"   {D}{hint}{X}")
        if self._leave_warn:
            lines.append(f"   {Y}{self._leave_warn}{X}")
        return lines

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
        if key and key.isdigit():
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
        return self._warn_once("switch", "这一题移动过光标但还没选定——数字/enter 选定后再切"
                                         "（再切一次就不选、直接切走）")

    def _guard_cancel(self) -> bool:
        if self._has_uncommitted_selection():
            return self._warn_once("cancel", "这一题移动过光标但还没选定——数字/enter 选定；"
                                             "再按一次 esc 放弃整个问答")
        answered = sum(1 for sel in self._selected if sel)
        if answered:
            return self._warn_once("cancel", f"已答 {answered} 题，确定全部放弃？"
                                             "（再按 esc 确认 / 其他键返回）")
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
                "advance", "这一题移动过光标但没有勾选——space/数字 勾选后 enter；"
                           "再按一次 enter 就按没选继续"):
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
                f"还有 {missing} 题没答，没答的会作为空答案交给模型——再按 enter 确认提交"
                if len(self._questions) > 1 else
                "这一题没选任何项，会作为空答案交给模型——再按 enter 确认"):
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
        pal = palette()
        if self._answers is None:
            return f" {pal.dim}● 已取消{pal.reset}"
        parts = [f"{q.get('question', '')} → {', '.join(a)}"
                 for q, a in zip(self._questions, self._answers) if a]
        if not parts:
            return f" {pal.dim}● 已提交空答案{pal.reset}"
        return f" {pal.green}●{pal.reset} {pal.dim}已回答 · {indent_continuations(' · '.join(parts))}{pal.reset}"

    def _submit(self) -> None:
        self._answers = [self.answer_for(i) for i in range(len(self._questions))]
        self._on_answer(self._answers)

    def cancel(self) -> None:
        self._answers = None
        self._on_answer(None)


__all__ = ["AskUserSession", "indent_continuations"]
