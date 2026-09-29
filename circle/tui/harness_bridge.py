"""Harness bridge — InfoTest GraphBridge shape, Circle deepagents backend.

Emits stream updates in the same *shape* IstInkApp consumes from
MessageSnapshot: visible text, thinking preview, reasoning_chars, phase.
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from langgraph.types import Command

from circle.events import EventBus, bind_bus, unbind_bus
from circle.middleware.cancellation import CancellationToken
from circle.middleware.loop_guard import is_loop_reminder
from circle.middleware.plan_tail import is_plan_reminder
from circle.tool_events import announce_blocked_tool_call
from circle.tui.content_blocks import (
    message_text,
    parse_content,
    reasoning_chars,
    thinking_preview,
)
from circle.tui.message_model import MessageSnapshot
from circle.tui.progress_handler import (
    CancellationHandler,
    ProgressHandler,
    extract_message_usage,
)
from circle.tui.sink import TuiSink

logger = logging.getLogger(__name__)

# 回合结束却没有正文时交给 on_done 的占位；会话据此判断模型其实没有作答
NO_OUTPUT = "（无输出）"


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
        on_snapshot: Callable[[MessageSnapshot], None] | None = None,
    ) -> None:
        self._agent = agent
        self._thread_id = thread_id
        self._on_update = on_update
        self._on_interrupt = on_interrupt
        self._on_done = on_done
        self._on_error = on_error
        self._on_status = on_status or (lambda _s: None)
        self._on_snapshot = on_snapshot
        # 一个用户回合一个 sink：start 时重置，审批后 resume 沿用（工具行留在同一回合里）
        self._sink = TuiSink(post=self._post_snapshot)
        self._worker: threading.Thread | None = None
        self._cancelled = False
        self._cancel_token: CancellationToken | None = None
        self._config: dict[str, Any] = {
            "configurable": {"thread_id": thread_id},
        }
        self._tool_acc: dict[str, dict] = {}
        self._usage_by_id: dict[str, tuple] = {}
        # One interrupt may contain several actions; parallel subagents may each
        # produce a separate interrupt, which must be resumed by its own id.
        self._pending_action_count: int = 1
        self._pending_action_groups: list[tuple[str | None, int]] = []
        self._pending_interrupt_count = 0
        # 中断回调在本回合的工作线程里就给出的 resume（/yolo 自动放行）：本回合退出时再起
        self._deferred_resume: Any = None

    @property
    def is_running(self) -> bool:
        return self._worker is not None and self._worker.is_alive()

    @property
    def thread_id(self) -> str:
        return self._thread_id

    def cancel(self) -> None:
        self._cancelled = True
        if self._cancel_token is not None:
            self._cancel_token.cancel()
        self._sink.cancel_run()
        policy = getattr(self._agent, "_circle_approvals", None)
        if policy is not None:
            policy.end_visible_turn(self._thread_id)

    def _post_snapshot(self, snap: MessageSnapshot) -> None:
        if self._on_snapshot is not None:
            try:
                self._on_snapshot(snap)
            except Exception:
                logger.exception("snapshot render failed")

    def start(self, user_text: str) -> None:
        if self.is_running:
            return
        self._cancelled = False
        self._cancel_token = CancellationToken()
        policy = getattr(self._agent, "_circle_approvals", None)
        if policy is not None:
            policy.begin_visible_turn(self._thread_id)
        self._clear_pending_interrupts()
        self._sink.reset()
        payload: Any = {"messages": [{"role": "user", "content": user_text}]}
        self._spawn(payload)

    def resume(self, decision: Any) -> None:
        """``{"decision": …}`` 扇出到本次中断的全部挂起调用；其他值原样作为 resume 值。"""
        if getattr(self, "_cancelled", False):
            return
        if self.is_running:
            if threading.current_thread() is self._worker:
                # 中断回调就在本回合的工作线程上（/yolo 自动放行走这条路）：线程还活着，
                # 直接起新一段会被当成"正在跑"丢掉，会话就永远停在忙碌；记下，_run 退出时再起
                self._deferred_resume = decision
            return
        self._start_resume(decision)

    def _start_resume(self, decision: Any) -> None:
        if getattr(self, "_cancelled", False):
            return
        if getattr(self, "_cancel_token", None) is None:
            self._cancel_token = CancellationToken()
        groups = getattr(self, "_pending_action_groups", [])
        if not (isinstance(decision, dict) and set(decision) == {"decision"}):
            if isinstance(decision, dict) and set(decision) == {"decisions"} and len(groups) > 1:
                if getattr(self, "_pending_interrupt_count", len(groups)) != len(groups):
                    raise ValueError("approval decisions cannot answer a non-approval interrupt")
                values = decision["decisions"]
                if not isinstance(values, list) or len(values) != sum(count for _iid, count in groups):
                    raise ValueError("approval decision count does not match pending actions")
                decision = self._map_approval_decisions(groups, values)
            self._clear_pending_interrupts()
            self._spawn(Command(resume=decision))
            return
        key = str(decision.get("decision") or "reject")
        if key in {"reject", "always_cancel"}:
            one = {"type": "reject", "message": "user rejected"}
        else:
            one = {"type": "approve"}
        if groups and getattr(self, "_pending_interrupt_count", len(groups)) != len(groups):
            raise ValueError("approval shortcut cannot answer a non-approval interrupt")
        if len(groups) > 1:
            values = [dict(one) for _iid, count in groups for _ in range(count)]
            resume = self._map_approval_decisions(groups, values)
        else:
            count = groups[0][1] if groups else getattr(self, "_pending_action_count", 1)
            resume = {"decisions": [dict(one) for _ in range(max(1, count))]}
        self._clear_pending_interrupts()
        self._spawn(Command(resume=resume))

    @staticmethod
    def _map_approval_decisions(
        groups: list[tuple[str | None, int]], decisions: list[dict[str, Any]],
    ) -> dict[str, dict[str, list[dict[str, Any]]]]:
        ids = [iid for iid, _count in groups]
        if (any(not isinstance(iid, str) or not iid for iid in ids)
                or len(set(ids)) != len(ids)):
            raise ValueError("parallel approvals require distinct interrupt ids")
        offset = 0
        replies: dict[str, dict[str, list[dict[str, Any]]]] = {}
        for iid, count in groups:
            replies[iid] = {"decisions": decisions[offset:offset + count]}
            offset += count
        return replies

    def _clear_pending_interrupts(self) -> None:
        self._pending_action_count = 1
        self._pending_action_groups = []
        self._pending_interrupt_count = 0

    @staticmethod
    def _action_groups(interrupts: Any) -> list[tuple[str | None, int]]:
        items = interrupts if isinstance(interrupts, (list, tuple)) else [interrupts]
        groups: list[tuple[str | None, int]] = []
        for item in items:
            value = getattr(item, "value", item)
            requests = value.get("action_requests") if isinstance(value, dict) else None
            if isinstance(requests, list) and requests:
                groups.append((getattr(item, "id", None), len(requests)))
        return groups

    @staticmethod
    def _count_action_requests(interrupts: Any) -> int:
        """Count actions across every pending approval interrupt."""
        return sum(count for _iid, count in HarnessBridge._action_groups(interrupts)) or 1

    def _remember_interrupts(self, interrupts: Any) -> None:
        items = interrupts if isinstance(interrupts, (list, tuple)) else [interrupts]
        self._pending_action_groups = self._action_groups(items)
        self._pending_interrupt_count = len(items)
        self._pending_action_count = self._count_action_requests(items)

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
        phase = "output" if parsed.text else "thinking"
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
        normalized = extract_message_usage(msg)
        totals = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_hit": 0,
            "cache_write": 0,
            "reasoning_tokens": 0,
            "reasoning_effort": "",
        }
        if "input_tokens" in normalized:
            # One request's full context, including cache reads and writes.
            totals["context_input_tokens"] = int(normalized["input_tokens"] or 0)
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
        bus = EventBus(run_id=uuid.uuid4().hex[:12])
        bus.subscribe(self._sink)
        self._bus = bus
        backend = getattr(self._agent, "_circle_backend", None)
        resolver = getattr(backend, "_resolve_path", None)
        configurable = {**self._config.get("configurable", {}),
                        "circle_cancel_token": self._cancel_token,
                        "circle_visible_turn": True}
        config = {**self._config, "configurable": configurable,
                  "callbacks": [CancellationHandler(self._cancel_token), ProgressHandler(
                      bus, path_resolver=resolver if callable(resolver) else None)]}
        # 中间件拒掉的调用经这条总线补发工具行（circle.tool_events）
        token = bind_bus(bus)
        bus.emit("run_start")
        try:
            self._run_with(payload, config, bus)
        except Exception:
            logger.debug("_run_with already reported the error", exc_info=True)
        finally:
            unbind_bus(token)
            deferred, self._deferred_resume = getattr(self, "_deferred_resume", None), None
            if deferred is not None and not self._cancelled:
                self._start_resume(deferred)
            elif self._cancelled or not self._pending_interrupt_count:
                policy = getattr(self._agent, "_circle_approvals", None)
                if policy is not None:
                    policy.end_visible_turn(self._thread_id)

    def announce_blocked(self, call: dict[str, Any], text: str) -> None:
        """A call refused at the approval prompt: give it a row in this turn."""
        bus = getattr(self, "_bus", None)
        if bus is not None:
            announce_blocked_tool_call(call, text, bus=bus)

    def _run_with(self, payload: Any, config: dict[str, Any], bus: EventBus) -> None:
        self._on_status("thinking")
        self._on_update(
            StreamUpdate(llm_phase="thinking", thinking_done=False)
        )
        final_text = ""
        final_thinking = ""
        try:
            stream_exc: BaseException | None = None
            stream = None
            try:
                stream = self._agent.stream(
                    payload,
                    config=config,
                    stream_mode="messages",
                )
                for item in stream:
                    if self._cancelled:
                        self._on_status("cancelled")
                        return
                    msg = item[0] if isinstance(item, tuple) else item
                    if is_plan_reminder(msg) or is_loop_reminder(msg):
                        continue
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
            finally:
                close = getattr(stream, "close", None) if self._cancelled else None
                if callable(close):
                    try:
                        close()
                    except (RuntimeError, ValueError):
                        pass

            if self._cancelled:
                self._on_status("cancelled")
                return

            if stream_exc is not None:
                self._sink.flush()
                self._on_error(stream_exc)
                self._on_status("ready")
                return
            # A resumed subgraph can finish without yielding any messages in
            # messages mode. The stream still ran and consumed Command(resume).
            # Invoking that same payload again would apply the decision to the
            # next pending interrupt.
            state = self._agent.get_state(self._config)
            if self._cancelled:
                self._on_status("cancelled")
                return
            interrupts = getattr(state, "interrupts", None) or ()
            if interrupts:
                self._remember_interrupts(interrupts)
                bus.emit("run_end", payload={"awaiting_user": True})
                if self._cancelled:
                    self._on_status("cancelled")
                    return
                self._on_interrupt(interrupts)
                self._on_status("cancelled" if self._cancelled else "approval")
                return
            bus.emit("run_end")
            values = getattr(state, "values", None) or {}
            messages = values.get("messages") if isinstance(values, dict) else None
            if messages:
                final_text = (
                    message_text(getattr(messages[-1], "content", None))
                    or final_text
                )
            self._on_done(final_text or NO_OUTPUT)
            self._on_status("ready")
        except Exception as exc:  # noqa: BLE001
            if self._cancelled:
                self._on_status("cancelled")
                return
            self._sink.flush()
            self._on_error(exc)
            self._on_status("ready")

    auto_approve: bool = False
