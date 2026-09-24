"""Main session: transcript + HITL approval + sandbox harness."""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from langgraph.types import Command

from circle.harness import create_harness
from circle.ink.components.exec_approval_view import ExecApprovalSession
from circle.settings import CircleSettings, apply_auth_to_environ


@dataclass
class TranscriptLine:
    kind: str  # user | agent | system | tool
    text: str


@dataclass
class MainController:
    settings: CircleSettings
    workspace: Path
    home: Path | None = None
    model_override: Any | None = None
    on_change: Callable[[], None] | None = None
    lines: list[TranscriptLine] = field(default_factory=list)
    phase: str = "idle"  # idle | running | approval | exited
    approval: ExecApprovalSession | None = None
    _thread_id: str = field(default_factory=lambda: f"circle-{uuid.uuid4().hex[:8]}")
    _agent: Any = None
    _pending_config: dict[str, Any] = field(default_factory=dict)
    last_interrupt: Any = None
    # 本次 HITL interrupt 携带的 action_requests 数量（并行工具调用时 > 1），
    # resume 时需要给每个补一个 decision，否则 langchain 抛
    # "Number of human decisions (N) does not match number of hanging tool calls (M)"。
    _interrupt_request_count: int = 1
    _worker: threading.Thread | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        apply_auth_to_environ(self.settings, self.home)
        from circle.model import build_chat_model

        model = build_chat_model(
            self.settings,
            home=self.home,
            model_override=self.model_override,
        )
        self._agent = create_harness(
            model,
            root_dir=self.workspace,
            home=self.home,
            model_id=self.settings.auth.model,
            protocol=self.settings.auth.protocol,
        )
        self._pending_config = {"configurable": {"thread_id": self._thread_id}}
        self.lines.append(
            TranscriptLine(
                "system",
                f"Circle · {self.workspace} · {self.settings.auth.protocol}/{self.settings.auth.model}",
            )
        )

    def _notify(self) -> None:
        if self.on_change is not None:
            try:
                self.on_change()
            except Exception:  # noqa: BLE001
                pass

    def body_lines(self) -> list[str]:
        out: list[str] = []
        for row in self.lines[-40:]:
            if row.kind == "user":
                out.append(f" you {row.text}")
            elif row.kind == "agent":
                out.append(f" ⏺ {row.text}")
            elif row.kind == "tool":
                out.append(f" ▸ {row.text}")
            else:
                out.append(f" ◆ {row.text}")
        if self.phase == "running":
            out.append(" ✶ 正在请求模型…")
        if self.approval is not None:
            out.append("")
            out.extend(self.approval.render_lines())
        return out

    def submit_user(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        if text in {"/exit", "/quit"}:
            self.phase = "exited"
            self._notify()
            return
        if self.phase == "running":
            self.lines.append(TranscriptLine("system", "上一条还在跑，请稍候"))
            self._notify()
            return
        if self.approval is not None:
            key = text.lower()
            mapping = {
                "1": "approve",
                "y": "approve",
                "2": "always",
                "3": "reject",
                "n": "reject",
            }
            decision = mapping.get(key)
            if decision:
                self._finish_approval({"decision": decision})
            return
        self.lines.append(TranscriptLine("user", text))
        self.phase = "running"
        self._notify()
        self._invoke_async({"messages": [{"role": "user", "content": text}]})

    def move_approval(self, delta: int) -> None:
        if self.approval is None:
            return
        key = "right" if delta > 0 else "left"
        self.approval.handle_key(key, "")
        self._notify()

    def confirm_approval(self) -> None:
        if self.approval is not None:
            self.approval.handle_key("enter", "")

    def _invoke_async(self, payload: dict[str, Any]) -> None:
        def _run() -> None:
            try:
                self._invoke(payload)
            finally:
                self._notify()

        self._worker = threading.Thread(target=_run, daemon=True, name="circle-agent")
        self._worker.start()

    def _invoke(self, payload: dict[str, Any]) -> None:
        assert self._agent is not None
        try:
            result = self._agent.invoke(payload, config=self._pending_config)
        except Exception as exc:  # noqa: BLE001
            from langgraph.errors import GraphInterrupt

            if isinstance(exc, GraphInterrupt):
                self._enter_interrupt(exc)
                return
            self.lines.append(TranscriptLine("system", f"错误: {exc}"))
            self.phase = "idle"
            return

        interrupts = None
        if isinstance(result, dict):
            interrupts = result.get("__interrupt__")
        if interrupts:
            self._enter_interrupt_values(interrupts)
            return

        self._consume_result(result)
        self.phase = "idle"

    def _enter_interrupt(self, exc: Any) -> None:
        values = getattr(exc, "args", None) or ()
        self._enter_interrupt_values(values[0] if values else [])

    def _enter_interrupt_values(self, interrupts: Any) -> None:
        self.last_interrupt = interrupts
        first = (
            interrupts[0]
            if isinstance(interrupts, (list, tuple)) and interrupts
            else interrupts
        )
        value = getattr(first, "value", first)
        action_requests = []
        if isinstance(value, dict):
            action_requests = value.get("action_requests") or []
        if not action_requests and isinstance(value, dict):
            action_requests = [value]
        self._interrupt_request_count = len(action_requests) if action_requests else 1
        req = (
            action_requests[0]
            if action_requests
            else {"name": "tool", "args": {}, "description": str(value)}
        )
        name = str(req.get("name") or req.get("tool") or "tool")
        args = req.get("args") or {}
        desc = str(req.get("description") or "")
        body = desc or "\n".join(f"{k}={v!r}" for k, v in list(args.items())[:8])
        if self._interrupt_request_count > 1:
            body += f"\n（另有 {self._interrupt_request_count - 1} 个待审批工具调用，本次决定将一并应用）"
        self.lines.append(TranscriptLine("tool", f"permission · {name}"))
        self.approval = ExecApprovalSession(
            {
                "tool": name,
                "title": name,
                "body": body,
                "allow_always": True,
            },
            render=self._notify,
            on_finish=self._finish_approval,
        )
        self.phase = "approval"

    def _finish_approval(self, decision: dict[str, Any]) -> None:
        self.approval = None
        key = str(decision.get("decision") or "reject")
        if key in {"reject", "always_cancel"}:
            one = {"type": "reject", "message": "user rejected"}
            self.lines.append(TranscriptLine("system", "已拒绝工具调用"))
        else:
            one = {"type": "approve"}
            self.lines.append(TranscriptLine("system", "已批准工具调用"))
        # 把同一个决定应用到本次中断挂起的全部 tool calls 上
        decisions = [dict(one) for _ in range(max(1, self._interrupt_request_count))]
        self._interrupt_request_count = 1
        self.phase = "running"
        self._notify()
        self._invoke_async(Command(resume={"decisions": decisions}))

    def _consume_result(self, result: Any) -> None:
        if not isinstance(result, dict):
            self.lines.append(TranscriptLine("agent", str(result)))
            return
        messages = result.get("messages") or []
        if not messages:
            self.lines.append(TranscriptLine("agent", "（无输出）"))
            return
        last = messages[-1]
        content = getattr(last, "content", None)
        if content is None and isinstance(last, dict):
            content = last.get("content")
        text = _message_text(content)
        self.lines.append(TranscriptLine("agent", text or "（无输出）"))


def _message_text(content: Any) -> str:
    """Backward-compatible alias — prefer ``content_blocks.message_text``."""
    from circle.tui.content_blocks import message_text

    return message_text(content)


def _thinking_preview(content: Any) -> str:
    from circle.tui.content_blocks import thinking_preview

    return thinking_preview(content)
