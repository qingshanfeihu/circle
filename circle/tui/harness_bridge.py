"""Harness bridge — InfoTest GraphBridge shape, Circle deepagents backend.

Emits stream updates in the same *shape* IstInkApp consumes from
MessageSnapshot: visible text, thinking preview, reasoning_chars, phase.
"""

from __future__ import annotations

import threading
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from langgraph.types import Command

from circle.tui.content_blocks import (
    message_text,
    parse_content,
    reasoning_chars,
    thinking_preview,
)


@dataclass
class StreamUpdate:
    """Minimal stand-in for InfoTest MessageSnapshot stream fields."""

    text: str = ""
    thinking: str = ""
    thinking_done: bool = True
    reasoning_last_line: str = ""
    reasoning_chars: int = 0
    llm_phase: str = ""  # thinking | output | ""
    cumulative: bool = True
    tool_name: str = ""      # 非空 = 这是工具调用结果
    tool_output: str = ""
    tool_calls: list = None  # AIMessage 的 tool_calls（LLM 请求调工具）


class HarnessBridge:
    def __init__(
        self,
        *,
        agent: Any,
        thread_id: str,
        on_update: Callable[[StreamUpdate], None],
        on_interrupt: Callable[[Any], None],
        on_done: Callable[[str], None],
        on_error: Callable[[BaseException], None],
        on_status: Callable[[str], None] | None = None,
    ) -> None:
        self._agent = agent
        self._thread_id = thread_id
        self._on_update = on_update
        self._on_interrupt = on_interrupt
        self._on_done = on_done
        self._on_error = on_error
        self._on_status = on_status or (lambda _s: None)
        self._worker: threading.Thread | None = None
        self._cancelled = False
        self._config: dict[str, Any] = {
            "configurable": {"thread_id": thread_id},
        }

    @property
    def is_running(self) -> bool:
        return self._worker is not None and self._worker.is_alive()

    @property
    def thread_id(self) -> str:
        return self._thread_id

    def cancel(self) -> None:
        self._cancelled = True

    def start(self, user_text: str) -> None:
        if self.is_running:
            return
        self._cancelled = False
        payload: Any = {"messages": [{"role": "user", "content": user_text}]}
        self._spawn(payload)

    def resume(self, decision: dict[str, Any]) -> None:
        if self.is_running:
            return
        self._cancelled = False
        key = str(decision.get("decision") or "reject")
        if key in {"reject", "always_cancel"}:
            decisions = [{"type": "reject", "message": "user rejected"}]
        else:
            decisions = [{"type": "approve"}]
        self._spawn(Command(resume={"decisions": decisions}))

    def _spawn(self, payload: Any) -> None:
        self._worker = threading.Thread(
            target=self._run,
            args=(payload,),
            name=f"circle-bridge-{self._thread_id}-{uuid.uuid4().hex[:6]}",
            daemon=True,
        )
        self._worker.start()

    def _emit_from_content(self, content: Any, *, chunk: bool) -> tuple[str, str]:
        parsed = parse_content(content)
        phase = "output" if parsed.text else ("thinking" if parsed.thinking else "thinking")
        self._on_update(
            StreamUpdate(
                text=parsed.text,
                thinking=parsed.thinking,
                thinking_done=parsed.thinking_done if chunk else True,
                reasoning_last_line=thinking_preview(content),
                reasoning_chars=reasoning_chars(content),
                llm_phase=phase,
                cumulative=not chunk or bool(parsed.text and not chunk),
            )
        )
        return parsed.text, parsed.thinking

    def _run(self, payload: Any) -> None:
        self._on_status("thinking")
        self._on_update(
            StreamUpdate(llm_phase="thinking", thinking_done=False)
        )
        final_text = ""
        final_thinking = ""
        try:
            stream_exc: BaseException | None = None
            used_stream = False
            try:
                for item in self._agent.stream(
                    payload,
                    config=self._config,
                    stream_mode="messages",
                ):
                    if self._cancelled:
                        self._on_status("cancelled")
                        return
                    used_stream = True
                    msg = item[0] if isinstance(item, tuple) else item
                    name = getattr(msg, "__class__", type("x", (), {})).__name__
                    content = getattr(msg, "content", None)
                    is_chunk = "Chunk" in name
                    # AIMessage with tool_calls → 发 tool_call 事件
                    tool_calls = getattr(msg, "tool_calls", None)
                    if tool_calls and name == "AIMessage" and not is_chunk:
                        calls = []
                        for tc in tool_calls:
                            if isinstance(tc, dict):
                                calls.append({
                                    "name": tc.get("name", "tool"),
                                    "args": tc.get("args", {}),
                                })
                        if calls:
                            self._on_update(StreamUpdate(tool_calls=calls))
                        continue
                    # ToolMessage → 发 tool 事件（视觉区分用）
                    if name == "ToolMessage":
                        tool_content = str(content or "")[:2000]
                        self._on_update(StreamUpdate(
                            tool_name="tool", tool_output=tool_content,
                        ))
                        continue
                    text, thinking = self._emit_from_content(content, chunk=is_chunk)
                    if text:
                        # Full AIMessage replaces; chunks accumulate when delta-like
                        if is_chunk and len(text) < len(final_text):
                            final_text = final_text + text
                        elif is_chunk and final_text and text.startswith(final_text):
                            final_text = text
                        elif is_chunk and final_text and not text.startswith(final_text):
                            # delta token
                            final_text = final_text + text
                        else:
                            final_text = text
                        # Re-emit cumulative visible text for transcript
                        self._on_update(
                            StreamUpdate(
                                text=final_text,
                                thinking=thinking or final_thinking,
                                thinking_done=False,
                                reasoning_last_line=thinking_preview(content)
                                or (final_thinking.splitlines() or [""])[-1][:200],
                                reasoning_chars=max(
                                    reasoning_chars(content), len(final_thinking)
                                ),
                                llm_phase="output",
                                cumulative=True,
                            )
                        )
                    if thinking:
                        final_thinking = thinking
            except Exception as exc:  # noqa: BLE001
                stream_exc = exc

            if used_stream:
                state = self._agent.get_state(self._config)
                interrupts = getattr(state, "interrupts", None) or ()
                if interrupts:
                    self._on_interrupt(interrupts)
                    self._on_status("approval")
                    return
                values = getattr(state, "values", None) or {}
                messages = values.get("messages") if isinstance(values, dict) else None
                if messages:
                    final_text = (
                        message_text(getattr(messages[-1], "content", None))
                        or final_text
                    )
                self._on_done(final_text or "（无输出）")
                self._on_status("ready")
                return

            if stream_exc is not None:
                self._on_error(stream_exc)
                self._on_status("ready")
                return

            result = self._agent.invoke(payload, config=self._config)
            if self._cancelled:
                self._on_status("cancelled")
                return
            if isinstance(result, dict):
                interrupts = result.get("__interrupt__")
                if interrupts:
                    self._on_interrupt(interrupts)
                    self._on_status("approval")
                    return
                messages = result.get("messages") or []
                if messages:
                    final_text = (
                        message_text(getattr(messages[-1], "content", None))
                        or final_text
                    )
            self._on_done(final_text or "（无输出）")
            self._on_status("ready")
        except Exception as exc:  # noqa: BLE001
            self._on_error(exc)
            self._on_status("ready")

    auto_approve: bool = False
