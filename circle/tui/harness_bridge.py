"""Harness bridge — InfoTest GraphBridge shape, Circle deepagents backend.

Emits stream updates in the same *shape* IstInkApp consumes from
MessageSnapshot: visible text, thinking preview, reasoning_chars, phase.
"""

from __future__ import annotations

import json
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
    tool_call_id: str = ""
    tool_calls: list = None  # AIMessage 的 tool_calls（LLM 请求调工具）
    usage: dict | None = None


def format_tool_args(args: Any) -> str:
    """Compact args for the transcript line. Empty means the call is not ready."""
    if not isinstance(args, dict) or not args:
        return ""
    if set(args) == {"_partial"}:
        return " ".join(str(args.get("_partial") or "").split())[:80]
    try:
        text = json.dumps(args, ensure_ascii=False, separators=(",", ":"))
    except TypeError:
        text = str(args)
    return " ".join(text.split())[:80]


def _json_object(raw: str) -> dict | None:
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


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
        self._tool_acc: dict[str, dict] = {}
        self._usage_by_id: dict[str, tuple] = {}
        # HITL interrupt 可携带多个 action_requests（模型并行发起多个需审批的工具调用），
        # resume 时必须给每个都补一个 decision，否则 langchain 会抛
        # "Number of human decisions (N) does not match number of hanging tool calls (M)"。
        self._pending_action_count: int = 1

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

    def resume(self, decision: Any) -> None:
        """``{"decision": …}`` 扇出到本次中断的全部挂起调用；其他值原样作为 resume 值。"""
        if self.is_running:
            return
        self._cancelled = False
        if not (isinstance(decision, dict) and set(decision) == {"decision"}):
            self._pending_action_count = 1
            self._spawn(Command(resume=decision))
            return
        key = str(decision.get("decision") or "reject")
        if key in {"reject", "always_cancel"}:
            one = {"type": "reject", "message": "user rejected"}
        else:
            one = {"type": "approve"}
        # 把同一个决定应用到本次中断挂起的全部 tool calls 上
        decisions = [dict(one) for _ in range(max(1, self._pending_action_count))]
        self._pending_action_count = 1
        self._spawn(Command(resume={"decisions": decisions}))

    @staticmethod
    def _count_action_requests(interrupts: Any) -> int:
        """统计一次 HITL interrupt 携带的 action_requests 数量。"""
        first = (
            interrupts[0]
            if isinstance(interrupts, (list, tuple)) and interrupts
            else interrupts
        )
        value = getattr(first, "value", first)
        if isinstance(value, dict) and value.get("action_requests"):
            return len(value["action_requests"])
        return 1

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

    def _absorb_tool_calls(self, msg: Any) -> list[dict]:
        """Fold streamed tool-call fragments until the arguments are complete."""
        changed: list[dict] = []

        def slot_for(key: str, call_id: str) -> dict:
            return self._tool_acc.setdefault(
                key, {"id": call_id, "name": "", "buf": "", "args": {}}
            )

        def publish(slot: dict) -> None:
            if not slot["name"]:
                return
            args = slot["args"]
            if not args and slot["buf"]:
                args = {"_partial": slot["buf"]}
            changed.append({
                "id": slot["id"],
                "name": slot["name"],
                "args": args,
            })

        for tc in getattr(msg, "tool_calls", None) or []:
            if not isinstance(tc, dict):
                continue
            name = str(tc.get("name") or "")
            call_id = str(tc.get("id") or "")
            if not name and not call_id:
                continue
            slot = slot_for(call_id or name, call_id)
            if name:
                slot["name"] = name
            raw = tc.get("args")
            if isinstance(raw, dict) and raw:
                slot["args"] = raw
                slot["buf"] = ""
            elif isinstance(raw, str) and raw.strip():
                slot["buf"] = raw
                parsed = _json_object(raw)
                if parsed is not None:
                    slot["args"] = parsed
            publish(slot)

        for tc in getattr(msg, "tool_call_chunks", None) or []:
            if not isinstance(tc, dict):
                continue
            call_id = str(tc.get("id") or "")
            index = tc.get("index")
            key = call_id or (f"idx-{index}" if index is not None else "")
            if not key:
                continue
            slot = slot_for(key, call_id or key)
            if tc.get("name"):
                slot["name"] = str(tc["name"])
            frag = tc.get("args")
            if isinstance(frag, str) and frag:
                slot["buf"] += frag
                parsed = _json_object(slot["buf"])
                if parsed is not None:
                    slot["args"] = parsed
            elif isinstance(frag, dict) and frag:
                slot["args"] = frag
            publish(slot)

        latest: dict[str, dict] = {}
        for call in changed:
            latest[call["id"] or call["name"]] = call
        return list(latest.values())

    def _note_usage(self, msg: Any) -> dict | None:
        raw = getattr(msg, "usage_metadata", None)
        meta = getattr(msg, "response_metadata", None)
        if not isinstance(raw, dict) or not raw:
            if isinstance(meta, dict) and isinstance(meta.get("usage"), dict):
                raw = meta["usage"]
            else:
                return None
        if not raw:
            return None
        details = raw.get("input_token_details")
        if not isinstance(details, dict):
            details = {}
        out_details = raw.get("output_token_details")
        if not isinstance(out_details, dict):
            out_details = {}
        effort = ""
        if isinstance(meta, dict):
            effort = str(meta.get("effort") or "")
            output_config = meta.get("output_config")
            if not effort and isinstance(output_config, dict):
                effort = str(output_config.get("effort") or "")
        current = (
            int(raw.get("input_tokens") or 0),
            int(raw.get("output_tokens") or 0),
            int(details.get("cache_read") or raw.get("prompt_cache_hit_tokens") or 0),
            int(details.get("cache_creation") or raw.get("prompt_cache_write_tokens") or 0),
            int(out_details.get("reasoning") or 0),
            effort,
        )
        mid = str(getattr(msg, "id", "") or "") or f"anon-{id(msg)}"
        if self._usage_by_id.get(mid) == current:
            return None
        self._usage_by_id[mid] = current
        totals = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_hit": 0,
            "cache_write": 0,
            "reasoning_tokens": 0,
            "reasoning_effort": "",
        }
        for row in self._usage_by_id.values():
            totals["input_tokens"] += row[0]
            totals["output_tokens"] += row[1]
            totals["cache_hit"] += row[2]
            totals["cache_write"] += row[3]
            totals["reasoning_tokens"] += row[4]
            if row[5]:
                totals["reasoning_effort"] = row[5]
        return totals

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
                    calls = self._absorb_tool_calls(msg) if "AIMessage" in name else []
                    usage = self._note_usage(msg)
                    if calls:
                        self._on_update(StreamUpdate(tool_calls=calls, usage=usage))
                        if not is_chunk:
                            continue
                    elif usage:
                        self._on_update(StreamUpdate(usage=usage))
                    # ToolMessage → 发 tool 事件（视觉区分用）
                    if name == "ToolMessage":
                        tool_content = str(content or "")[:2000]
                        self._on_update(StreamUpdate(
                            tool_name=str(getattr(msg, "name", "") or "tool"),
                            tool_output=tool_content,
                            tool_call_id=str(getattr(msg, "tool_call_id", "") or ""),
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
                    self._pending_action_count = self._count_action_requests(interrupts)
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
                    self._pending_action_count = self._count_action_requests(interrupts)
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
