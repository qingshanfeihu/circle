"""Fold bus events into an immutable ``MessageSnapshot`` for the screen.

Ported from InfoTest ``main/ist_core/tui/reducer.py``: the run, LLM, tool, todo,
ask-user and error branches, the per-round main thinking message, and the card
plumbing (``_upsert_card``). Subagent cards are built here from the ``task`` call and
the events tagged with it: calls, results, reasoning title, tokens, and the tail of
each round's reasoning text for the detail page (one item per round, bounded, pushed
in steps — InfoTest's fork thinking body rules). Left out: compile-engine cards,
recompose progress, mailbox notices and IDE summaries.

Everything the renderer needs to know is decided here once (e.g. whether a tool
result is an error, whether it is recoverable), so live rendering and a ctrl+o replay
of the same snapshot draw the same bytes.
"""

from __future__ import annotations

import logging
import threading
import time
from types import MappingProxyType
from typing import Any, Callable, Mapping

from circle.display_lexicon import ERROR_WITHOUT_TEXT, structured_args, tool_result_is_error
from circle.display_stream import reasoning_summary
from circle.events import CircleEvent
from circle.pricing import UsageCostTotals
from circle.tui.message_model import (
    BLOCK_AGENT_CARD,
    BLOCK_ASK_USER,
    BLOCK_ERROR,
    BLOCK_TODO_LIST,
    BLOCK_TOOL_USE,
    BLOCK_WARN,
    ContentBlock,
    Message,
    MessageSnapshot,
    make_assistant_message,
    make_payload_block,
    make_system_message,
    make_text_block,
    make_thinking_block,
    make_tool_result_block,
    make_tool_use_block,
    make_user_message,
    make_uuid,
    replace_content_block,
)

logger = logging.getLogger(__name__)

AGENT_TRANSCRIPT_MAX = 240
# 子代理每轮思考正文只留尾部，按字符步进推进卡片（逐 delta 推卡会把重渲抬到 token 级）
CARD_THINKING_TAIL_CHARS = 4000
CARD_THINKING_PUSH_STEP = 2000
# 这些工具调用开一个子代理：其内部事件挂在它下面
SUBAGENT_TOOLS = frozenset({"task"})


class MessageReducer:
    def __init__(self) -> None:
        self._messages: list[Message] = []
        self._streaming_text: str | None = None
        self._status = "idle"
        self._source_run_id = ""
        self._usage: dict[str, int] = {}
        self._usage_cost = UsageCostTotals()
        self._usage_call_ids: set[tuple[str, str]] = set()
        self._llm_phase = ""
        self._output_token_count = 0
        self._llm_round = 0
        self._call_started_at: float | None = None
        self._llm_waiting: dict = {}
        self._reasoning_active = False
        self._reasoning_last_line = ""
        self._reasoning_chars = 0
        self._thinking_message_idx: dict[int, int] = {}
        self._thinking_raw_by_round: dict[int, str] = {}
        self._run_end_info: dict[str, Any] = {}
        # 在跑的工具调用：结果按 langchain run id 对回；取不到 id 时按先进先出
        self._inflight_tool_use_ids: list[str] = []
        self._tool_run_id_map: dict[str, str] = {}
        # 子代理调用栈：栈顶是当前子代理事件的父调用
        self._subagent_parent_stack: list[str] = []
        self._rev = 0
        self._agent_card_idx: dict[str, int] = {}
        # 每张卡本轮思考的累计（尾部、总字数、已推进卡片的字数、起点）
        self._card_thinking: dict[str, dict[str, Any]] = {}
        self._agent_board_rev = 0
        self._listeners: list[Callable[[MessageSnapshot], None]] = []
        self._lock = threading.Lock()

    # ── snapshot ───────────────────────────────────────────────────────────

    def subscribe(self, cb: Callable[[MessageSnapshot], None]) -> None:
        self._listeners.append(cb)

    def snapshot(self) -> MessageSnapshot:
        with self._lock:
            return self._snapshot_locked()

    def _snapshot_locked(self) -> MessageSnapshot:
        return MessageSnapshot(
            messages=tuple(self._messages),
            streaming_text=self._streaming_text,
            status=self._status,
            usage=MappingProxyType(dict(self._usage)),
            usage_cost=MappingProxyType(self._usage_cost.snapshot()),
            llm_phase=self._llm_phase,
            output_token_count=self._output_token_count,
            llm_round=self._llm_round,
            call_started_at=self._call_started_at,
            reasoning_active=self._reasoning_active,
            reasoning_last_line=self._reasoning_last_line,
            reasoning_chars=self._reasoning_chars,
            rev=self._rev,
            agent_board_rev=self._agent_board_rev,
            agent_card_indices=MappingProxyType(dict(self._agent_card_idx)),
            run_end_info=MappingProxyType(dict(self._run_end_info)),
            source_run_id=self._source_run_id,
            llm_waiting=(MappingProxyType(dict(self._llm_waiting)) if self._llm_waiting else None),
        )

    def reset(self, *, source_run_id: str = "") -> None:
        with self._lock:
            self._messages.clear()
            self._streaming_text = None
            self._status = "idle"
            self._source_run_id = str(source_run_id or "")
            self._llm_phase = ""
            self._output_token_count = 0
            self._llm_round = 0
            self._call_started_at = None
            self._reasoning_active = False
            self._reasoning_last_line = ""
            self._reasoning_chars = 0
            self._thinking_message_idx.clear()
            self._thinking_raw_by_round.clear()
            self._inflight_tool_use_ids.clear()
            self._tool_run_id_map.clear()
            self._subagent_parent_stack.clear()
            self._agent_card_idx.clear()
            self._card_thinking.clear()
            self._llm_waiting = {}
            self._agent_board_rev += 1
            self._rev += 1
            snap = self._snapshot_locked()
        self._notify(snap)

    def set_run_status(self, status: str, *, awaiting_user: bool = False) -> None:
        with self._lock:
            if self._status in ("cancelled", "error") and status != self._status:
                return
            self._status = status
            if awaiting_user:
                info = dict(self._run_end_info)
                info["awaiting_user"] = True
                info.setdefault("run_id", self._source_run_id)
                self._run_end_info = info
            self._rev += 1
            snap = self._snapshot_locked()
        self._notify(snap)

    def cancel_run(self, *, reason: str = "user_interrupt") -> None:
        with self._lock:
            if self._status == "cancelled":
                return
            now = time.time()
            changed = False
            for uuid in list(self._agent_card_idx):
                payload = self._card_payload(uuid)
                if str(payload.get("status") or "running") != "running":
                    continue
                changed |= self._upsert_card(uuid, {
                    "status": "error",
                    "error": f"cancelled by {reason or 'user_interrupt'}",
                    "termination_cause": "CANCELLED",
                    "current_tool": "",
                    "current_arg": {},
                    "last_event_ts": now,
                    "end_ts": now,
                    "transcript": self._settled_calls(payload),
                })
            self._card_thinking.clear()
            if changed:
                self._agent_board_rev += 1
            self._status = "cancelled"
            self._streaming_text = None
            self._llm_phase = ""
            self._output_token_count = 0
            for tool_use_id in tuple(self._inflight_tool_use_ids):
                self._update_tool_use_status(tool_use_id, status="error")
            self._inflight_tool_use_ids.clear()
            self._tool_run_id_map.clear()
            self._subagent_parent_stack.clear()
            self._rev += 1
            snap = self._snapshot_locked()
        self._notify(snap)

    def dispatch(self, event: CircleEvent) -> None:
        kind = event.get("kind") or ""
        snap = None
        try:
            with self._lock:
                if self._status == "cancelled":
                    return
                event_run_id = str(event.get("run_id") or "")
                if event_run_id:
                    self._source_run_id = event_run_id
                self._handle(kind, event)
                self._rev += 1
                snap = self._snapshot_locked()
        except Exception:  # noqa: BLE001 — a bad event must not stop the screen
            logger.exception("MessageReducer dispatch error: kind=%s", kind)
        if snap is None:
            snap = self.snapshot()
        self._notify(snap)

    def _handle(self, kind: str, event: CircleEvent) -> None:
        if kind == "run_start":
            self._status = "running"
            self._llm_waiting = {}
            self._llm_phase = "input"
            self._output_token_count = 0
            self._llm_round = 0
            self._call_started_at = None
            self._reasoning_active = False
            self._reasoning_last_line = ""
            self._reasoning_chars = 0
            self._thinking_message_idx.clear()
            self._thinking_raw_by_round.clear()
            self._run_end_info = {}
        elif kind == "run_end":
            if self._status != "error":
                self._status = "done"
            self._llm_phase = ""
            self._llm_waiting = {}
            self._output_token_count = 0
            self._call_started_at = None
            self._reasoning_active = False
            payload = event.get("payload") or {}
            # 停在等用户回答（审批、问答）也发 run_end；回合没结束，渲染层据此分辨
            self._run_end_info = {"run_id": event.get("run_id", ""),
                                  "awaiting_user": bool(payload.get("awaiting_user"))}
        elif kind == "run_error":
            self._status = "error"
            self._llm_phase = ""
            self._llm_waiting = {}
            self._output_token_count = 0
            self._call_started_at = None
            self._reasoning_active = False
            self._on_error(event)
        elif kind == "error":
            self._on_error(event)
        elif kind == "warn":
            self._on_warn(event)
        elif kind == "llm_token":
            self._on_token(event)
        elif kind == "llm_end":
            self._on_llm_end(event)
        elif kind == "llm_start":
            self._on_llm_start(event)
        elif kind in ("tool_call", "tool_start"):
            self._on_tool_call(event)
        elif kind in ("tool_result", "tool_end"):
            self._on_tool_result(event)
        elif kind == "info":
            self._on_info(event)
        elif kind == "todo_list":
            self._on_todo_list(event)
        elif kind == "ask_user_request":
            self._on_ask_user_request(event)
        elif kind == "ask_user_presented":
            self._on_ask_user_presented(event)
        elif kind == "ask_user_answered":
            self._on_ask_user_answered(event)
        elif kind == "ask_user_resolved":
            self._on_ask_user_resolved(event)

    # ── model output ───────────────────────────────────────────────────────

    @staticmethod
    def _is_subagent_event(event: CircleEvent) -> bool:
        return bool((event.get("tags") or {}).get("parent_subagent"))

    # ── subagent cards ─────────────────────────────────────────────────────

    @staticmethod
    def _card_uuid(lc_run: str) -> str:
        return f"agent:{lc_run}"

    def _subagent_card(self, event: CircleEvent) -> str:
        """The card this subagent event belongs to ("" when it cannot be placed)."""
        parent = str((event.get("tags") or {}).get("parent_tool_use_id") or "")
        uuid = self._card_uuid(parent) if parent else ""
        return uuid if uuid and uuid in self._agent_card_idx else ""

    def _open_card(self, event: CircleEvent, tool_use_id: str, input_dict: Mapping[str, Any]) -> None:
        lc_run = str((event.get("tags") or {}).get("lc_tool_run_id") or tool_use_id)
        args = structured_args(input_dict)
        self._upsert_card(self._card_uuid(lc_run), {
            "kind": "subagent",
            "name": str(args.get("subagent_type") or "agent"),
            "description": " ".join(str(args.get("description") or "").split()),
            "tool_use_id": tool_use_id,
            "status": "running",
            "start_ts": time.time(),
            "n_calls": 0,
            "current_tool": "",
            "current_arg": {},
            "reasoning_title": "",
            "tokens_in": 0,
            "tokens_out": 0,
        })
        self._agent_board_rev += 1

    def _card_event(self, kind: str, event: CircleEvent) -> None:
        uuid = self._subagent_card(event)
        if not uuid:
            return
        tags = event.get("tags") or {}
        payload = event.get("payload") or {}
        card = self._card_payload(uuid)
        now = time.time()
        if kind in ("tool_call", "tool_start"):
            raw = payload.get("input") or {}
            args = dict(structured_args(raw)) if isinstance(raw, Mapping) else {}
            self._upsert_card(uuid, {
                "n_calls": int(card.get("n_calls") or 0) + 1,
                "current_tool": str(tags.get("name") or payload.get("name") or ""),
                "current_arg": args,
                "last_event_ts": now,
                "_transcript_append": {"kind": "tool", "key": str(tags.get("lc_tool_run_id") or ""),
                                       "tool": str(tags.get("name") or payload.get("name") or ""),
                                       "input": args, "status": "running", "ts": now},
            }, skip_if_finished=True)
        elif kind in ("tool_result", "tool_end"):
            output = str(payload.get("output") or "")
            status = str(payload.get("status") or "")
            error = tool_result_is_error(output, status)
            item = {"key": str(tags.get("lc_tool_run_id") or ""),
                    "status": "error" if error else "ok", "output": output[:400]}
            if payload.get("recoverable") is True:
                item["recoverable"] = True
            self._upsert_card(uuid, {"current_tool": "", "current_arg": {}, "last_event_ts": now,
                                     "_transcript_upsert": item}, skip_if_finished=True)
        elif kind in ("llm_start", "llm_token"):
            title = payload.get("reasoning_title")
            updates: dict[str, Any] = {"last_event_ts": now}
            if isinstance(title, str) and title.strip():
                updates["reasoning_title"] = title.strip()
            if kind == "llm_start":
                round_n = int(card.get("round") or 0) + 1
                updates["round"] = round_n
                self._card_thinking[uuid] = {"round": round_n, "text": "", "chars": 0,
                                             "pushed": 0, "start": now, "title": ""}
            else:
                item = self._thinking_step(uuid, str(payload.get("reasoning") or ""),
                                           updates.get("reasoning_title"))
                if item is not None:
                    updates["_transcript_upsert"] = item
            self._upsert_card(uuid, updates, skip_if_finished=True)
        elif kind == "llm_end" and payload.get("name") == "subagent_usage":
            usage = event.get("usage") or {}
            self._upsert_card(uuid, {
                "tokens_in": int(card.get("tokens_in") or 0) + int(usage.get("input_tokens") or 0),
                "tokens_out": int(card.get("tokens_out") or 0) + int(usage.get("output_tokens") or 0),
            }, skip_if_finished=True)
        elif kind == "llm_end" and payload.get("name") in ("subagent_done", "round_error"):
            item = self._thinking_close(uuid, now)
            if item is not None:
                self._upsert_card(uuid, {"_transcript_upsert": item}, skip_if_finished=True)
        self._agent_board_rev += 1

    def _thinking_item(self, state: dict[str, Any], *, done: bool, now: float) -> dict[str, Any]:
        state["pushed"] = state["chars"]
        item = {"kind": "thinking_body", "key": f"think:{state['round']}", "text": state["text"],
                "chars": state["chars"], "truncated": state["chars"] > len(state["text"]),
                "title": state["title"], "done": done}
        if done:
            item["duration_s"] = max(0.0, now - float(state["start"]))
        return item

    def _thinking_step(self, uuid: str, delta: str, title: Any) -> dict[str, Any] | None:
        state = self._card_thinking.get(uuid)
        if state is None or not delta:
            return None
        state["text"] = (state["text"] + delta)[-CARD_THINKING_TAIL_CHARS:]
        state["chars"] += len(delta)
        if isinstance(title, str) and title:
            state["title"] = title
        if state["chars"] - state["pushed"] < CARD_THINKING_PUSH_STEP:
            return None
        return self._thinking_item(state, done=False, now=time.time())

    def _thinking_close(self, uuid: str, now: float) -> dict[str, Any] | None:
        state = self._card_thinking.pop(uuid, None)
        if state is None or not state["chars"]:
            return None
        return self._thinking_item(state, done=True, now=now)

    def _close_card(self, event: CircleEvent, output: str, status: str) -> None:
        lc_run = str((event.get("tags") or {}).get("lc_tool_run_id") or "")
        uuid = self._card_uuid(lc_run) if lc_run else ""
        if not uuid or uuid not in self._agent_card_idx:
            return
        error = tool_result_is_error(output, status)
        first = next((ln.strip() for ln in output.splitlines() if ln.strip()), "")
        self._card_thinking.pop(uuid, None)
        self._upsert_card(uuid, {"status": "error" if error else "ok", "end_ts": time.time(),
                                 "current_tool": "", "current_arg": {}, "summary": first[:200],
                                 "transcript": self._settled_calls(self._card_payload(uuid))})
        self._agent_board_rev += 1

    @staticmethod
    def _settled_calls(card: Mapping[str, Any]) -> list:
        """A finished subagent has no running calls left: ones without a result failed."""
        return [dict(item, status="error")
                if isinstance(item, dict) and item.get("kind") == "tool" and item.get("status") == "running"
                else item
                for item in card.get("transcript") or ()]

    def _on_llm_start(self, event: CircleEvent | None = None) -> None:
        if event is not None and self._is_subagent_event(event):
            self._card_event("llm_start", event)
            return
        self._llm_phase = "input"
        self._output_token_count = 0
        self._merge_main_llm_fields((event or {}).get("payload") or {}, round_start=True)
        self._thinking_raw_by_round[self._llm_round] = ""

    @staticmethod
    def _duration_from_payload(payload: Mapping[str, Any]) -> float | None:
        if "reasoning_duration_s" not in payload:
            return None
        try:
            value = payload.get("reasoning_duration_s")
            return max(0.0, float(value)) if value is not None else None
        except (TypeError, ValueError, OverflowError):
            return None

    def _upsert_main_thinking(self, event: CircleEvent, *, raw: str,
                              payload: Mapping[str, Any], done: bool) -> None:
        """One thinking message per model round, replaced in place as it grows."""
        round_n = self._llm_round
        try:
            round_n = max(0, int(payload.get("llm_round") or round_n))
        except (TypeError, ValueError):
            pass
        parsed = reasoning_summary(raw)
        title = parsed.title
        if "reasoning_title" in payload:
            emitted = payload.get("reasoning_title")
            title = str(emitted).strip() if emitted else None
        block = make_thinking_block(parsed.body, title=title,
                                    duration_s=self._duration_from_payload(payload) if done else None,
                                    done=done)
        index = self._thinking_message_idx.get(round_n)
        if index is not None and 0 <= index < len(self._messages):
            previous = self._messages[index]
            self._messages[index] = make_assistant_message(uuid=previous.uuid, content=block,
                                                           timestamp=previous.timestamp)
            return
        self._messages.append(make_assistant_message(
            uuid=make_uuid(event.get("run_id") or "", f"thinking:{round_n}:{event.get('seq') or 0}"),
            content=block, timestamp=event.get("ts") or ""))
        self._thinking_message_idx[round_n] = len(self._messages) - 1

    def _merge_main_llm_fields(self, payload: Mapping[str, Any], *,
                               round_start: bool = False) -> None:
        if "llm_round" in payload:
            try:
                self._llm_round = max(0, int(payload.get("llm_round") or 0))
            except (TypeError, ValueError):
                pass
        if "call_started_at" in payload:
            value = payload.get("call_started_at")
            try:
                self._call_started_at = float(value) if value is not None else None
            except (TypeError, ValueError):
                self._call_started_at = None
        if "reasoning_active" in payload:
            self._reasoning_active = payload.get("reasoning_active") is True
        if "reasoning_last_line" in payload:
            self._reasoning_last_line = str(payload.get("reasoning_last_line") or "")[:200]
        if "reasoning_chars" in payload:
            try:
                self._reasoning_chars = max(0, int(payload.get("reasoning_chars") or 0))
            except (TypeError, ValueError):
                pass
        if round_start and "reasoning_last_line" not in payload:
            self._reasoning_last_line = ""
            self._reasoning_chars = 0
            self._reasoning_active = False

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        cjk = sum(1 for ch in text if ord(ch) >= 0x2E80)
        return max(1, cjk + (len(text) - cjk) // 4)

    def _on_token(self, event: CircleEvent) -> None:
        if self._is_subagent_event(event):
            self._card_event("llm_token", event)
            return
        payload = event.get("payload") or {}
        self._merge_main_llm_fields(payload)
        reasoning = payload.get("reasoning")
        if isinstance(reasoning, str) and reasoning:
            raw = self._thinking_raw_by_round.get(self._llm_round, "") + reasoning
            self._thinking_raw_by_round[self._llm_round] = raw
            self._upsert_main_thinking(event, raw=raw, payload=payload, done=False)
            self._llm_phase = "thinking"
            self._output_token_count += self._estimate_tokens(reasoning)
        content = payload.get("content") or ""
        if (self._llm_round in self._thinking_message_idx
                and payload.get("reasoning_active") is False
                and payload.get("reasoning_duration_s") is not None):
            self._upsert_main_thinking(event, raw=self._thinking_raw_by_round.get(self._llm_round, ""),
                                       payload=payload, done=True)
        if not isinstance(content, str) or not content:
            return
        self._llm_phase = "output"
        self._output_token_count += self._estimate_tokens(content)
        self._streaming_text = content if self._streaming_text is None else self._streaming_text + content

    def _on_llm_end(self, event: CircleEvent) -> None:
        payload = event.get("payload") or {}
        is_subagent = self._is_subagent_event(event)
        if is_subagent:
            self._card_event("llm_end", event)
        if not is_subagent:
            self._merge_main_llm_fields(payload)
            if self._llm_round in self._thinking_message_idx:
                self._upsert_main_thinking(event, raw=self._thinking_raw_by_round.get(self._llm_round, ""),
                                           payload=payload, done=True)
        name = payload.get("name") or ""
        usage = event.get("usage")
        if isinstance(usage, dict) and not is_subagent and name == "usage_only":
            usage_id = str(payload.get("usage_call_id") or "")
            identity = (str(event.get("run_id") or ""), usage_id)
            if usage_id and identity in self._usage_call_ids:
                return
            if usage_id:
                self._usage_call_ids.add(identity)
            self._merge_usage(usage)
            self._usage_cost.add(payload.get("usage_cost"))
        if name == "usage_only":
            return
        content = payload.get("content") or ""
        if not isinstance(content, str):
            content = str(content)
        self._streaming_text = None
        self._llm_phase = ""
        self._output_token_count = 0
        if not content or content == "[Calling tools]":
            return
        parent_tool_use_id = self._current_subagent_parent(event)
        subagent_type = (event.get("tags") or {}).get("parent_subagent") or ""
        if subagent_type and not parent_tool_use_id:
            return
        self._messages.append(make_assistant_message(
            uuid=make_uuid(event.get("run_id") or "", event.get("seq") or 0),
            content=make_text_block(content), timestamp=event.get("ts") or "",
            parent_tool_use_id=parent_tool_use_id, subagent_type=subagent_type))

    # ── tools ──────────────────────────────────────────────────────────────

    def _on_tool_call(self, event: CircleEvent) -> None:
        run_id = event.get("run_id") or ""
        seq = event.get("seq") or 0
        tags = event.get("tags") or {}
        payload = event.get("payload") or {}
        if tags.get("parent_subagent"):
            self._card_event("tool_call", event)
        if tags.get("parent_subagent") and not self._current_subagent_parent(event):
            return
        tool_name = tags.get("name") or payload.get("name") or ""
        raw_input = payload.get("input") or {}
        input_dict: Mapping[str, Any] = raw_input if isinstance(raw_input, dict) else {"raw": str(raw_input)}
        tool_use_id = make_uuid(run_id, seq)
        parent_tool_use_id = self._current_subagent_parent(event)
        self._messages.append(make_assistant_message(
            uuid=tool_use_id,
            content=make_tool_use_block(tool_use_id=tool_use_id, name=tool_name, input=input_dict,
                                        status="running"),
            timestamp=event.get("ts") or "", parent_tool_use_id=parent_tool_use_id,
            subagent_type=tags.get("parent_subagent") or ""))
        self._inflight_tool_use_ids.append(tool_use_id)
        lc_tool_run_id = tags.get("lc_tool_run_id") or ""
        if lc_tool_run_id:
            self._tool_run_id_map[lc_tool_run_id] = tool_use_id
        if tool_name in SUBAGENT_TOOLS and not parent_tool_use_id:
            self._subagent_parent_stack.append(tool_use_id)
            self._open_card(event, tool_use_id, input_dict)

    def _on_tool_result(self, event: CircleEvent) -> None:
        tags = event.get("tags") or {}
        payload = event.get("payload") or {}
        if tags.get("parent_subagent"):
            self._card_event("tool_result", event)
        if tags.get("parent_subagent") and not self._current_subagent_parent(event):
            return
        tool_name = tags.get("name") or payload.get("name") or ""
        output = payload.get("output") or ""
        if not isinstance(output, str):
            output = str(output)
        if tool_name in SUBAGENT_TOOLS and not tags.get("parent_subagent"):
            self._close_card(event, output, str(payload.get("status") or ""))
        lc_tool_run_id = tags.get("lc_tool_run_id") or ""
        tool_use_id = ""
        if lc_tool_run_id and lc_tool_run_id in self._tool_run_id_map:
            tool_use_id = self._tool_run_id_map.pop(lc_tool_run_id)
            if tool_use_id in self._inflight_tool_use_ids:
                self._inflight_tool_use_ids.remove(tool_use_id)
        elif self._inflight_tool_use_ids:
            tool_use_id = self._inflight_tool_use_ids.pop(0)
        if tool_use_id:
            self._update_tool_use_status(tool_use_id, status="done")
        if tool_name in SUBAGENT_TOOLS and self._subagent_parent_stack:
            if self._subagent_parent_stack[-1] == tool_use_id:
                self._subagent_parent_stack.pop()
            elif tool_use_id in self._subagent_parent_stack:
                self._subagent_parent_stack.remove(tool_use_id)
        parent_tool_use_id = self._current_subagent_parent(event)
        if not tool_use_id and not parent_tool_use_id:
            return
        result_status = str(payload.get("status") or "")
        block_payload: dict[str, Any] = {}
        if result_status:
            block_payload["status"] = result_status
        if payload.get("recoverable") is True:
            block_payload["recoverable"] = True
        self._messages.append(make_user_message(
            uuid=make_uuid(event.get("run_id") or "", event.get("seq") or 0),
            content=make_tool_result_block(tool_use_id=tool_use_id, output=output, name=tool_name,
                                           is_error=tool_result_is_error(output, result_status),
                                           payload=block_payload or None),
            timestamp=event.get("ts") or "", parent_tool_use_id=parent_tool_use_id))

    def _update_tool_use_status(self, tool_use_id: str, *, status: str) -> None:
        for i in range(len(self._messages) - 1, -1, -1):
            msg = self._messages[i]
            for block in msg.content:
                if block.type == BLOCK_TOOL_USE and block.tool_use_id == tool_use_id:
                    new_block = ContentBlock(type=block.type, tool_use_id=block.tool_use_id,
                                             name=block.name, input=block.input, status=status)
                    self._messages[i] = replace_content_block(
                        msg, predicate=lambda b: (b.type == BLOCK_TOOL_USE
                                                  and b.tool_use_id == tool_use_id),
                        new_block=new_block)
                    return

    def _on_info(self, event: CircleEvent) -> None:
        payload = event.get("payload") or {}
        name = payload.get("name") or ""
        if name == "llm_waiting":
            waiting = payload.get("waiting")
            self._llm_waiting = dict(waiting) if isinstance(waiting, Mapping) and waiting else {}
            return
        if name == "thinking_block" and not self._is_subagent_event(event):
            thinking = payload.get("thinking") or ""
            if not thinking:
                return
            self._thinking_raw_by_round[self._llm_round] = str(thinking)
            self._upsert_main_thinking(event, raw=str(thinking), payload=payload, done=True)

    # ── cards (subagents build on this) ────────────────────────────────────

    def _upsert_card(self, uuid: str, updates: dict, *, skip_if_finished: bool = False) -> bool:
        idx = self._agent_card_idx.get(uuid)
        if idx is not None and not (0 <= idx < len(self._messages)
                                    and self._messages[idx].uuid == uuid):
            idx = next((i for i in range(len(self._messages) - 1, -1, -1)
                        if self._messages[i].uuid == uuid), None)
            if idx is not None:
                self._agent_card_idx[uuid] = idx
        transcript_item = updates.pop("_transcript_append", None)
        transcript_upsert = updates.pop("_transcript_upsert", None)
        if idx is None:
            merged = dict(updates)
            merged.setdefault("status", "running")
            initial = [item for item in (transcript_item, transcript_upsert) if isinstance(item, dict)]
            if initial:
                merged["transcript"] = initial[-AGENT_TRANSCRIPT_MAX:]
            self._messages.append(make_system_message(
                uuid=uuid, content=make_payload_block(BLOCK_AGENT_CARD, merged), timestamp=""))
            self._agent_card_idx[uuid] = len(self._messages) - 1
            return True
        old = self._messages[idx]
        payload = dict(old.content[0].payload) if old.content else {}
        if skip_if_finished and payload.get("status") in ("ok", "error"):
            return False
        payload.update(updates)
        transcript = list(payload.get("transcript") or [])
        if isinstance(transcript_item, dict):
            transcript.append(transcript_item)
        if isinstance(transcript_upsert, dict):
            key = transcript_upsert.get("key")
            for i in range(len(transcript) - 1, -1, -1):
                item = transcript[i]
                if isinstance(item, dict) and item.get("key") == key:
                    transcript[i] = {**item, **transcript_upsert}
                    break
            else:
                transcript.append(transcript_upsert)
        if transcript_item is not None or transcript_upsert is not None:
            payload["transcript"] = transcript[-AGENT_TRANSCRIPT_MAX:]
        self._messages[idx] = make_system_message(
            uuid=uuid, content=make_payload_block(BLOCK_AGENT_CARD, payload),
            timestamp=old.timestamp)
        return True

    def _card_payload(self, uuid: str) -> dict:
        idx = self._agent_card_idx.get(uuid)
        if idx is None or not (0 <= idx < len(self._messages)):
            return {}
        msg = self._messages[idx]
        return dict(msg.content[0].payload or {}) if msg.content else {}

    # ── todo, ask_user, errors ─────────────────────────────────────────────

    def _append_system(self, event: CircleEvent, block: ContentBlock) -> None:
        self._messages.append(make_system_message(
            uuid=make_uuid(event.get("run_id") or "", event.get("seq") or 0),
            content=block, timestamp=event.get("ts") or ""))

    def _on_todo_list(self, event: CircleEvent) -> None:
        todos = (event.get("payload") or {}).get("todos") or []
        self._append_system(event, make_payload_block(BLOCK_TODO_LIST, {"todos": todos}))

    def _on_ask_user_request(self, event: CircleEvent) -> None:
        payload = event.get("payload") or {}
        self._append_system(event, make_payload_block(BLOCK_ASK_USER, {
            "question_id": payload.get("question_id", ""),
            "questions": payload.get("questions", []),
            "scheduled": True,
            "presented": False,
        }))

    def _replace_ask_block(self, qid: str, build: Callable[[Mapping[str, Any]], dict | None]) -> None:
        for i in range(len(self._messages) - 1, -1, -1):
            msg = self._messages[i]
            for block in msg.content:
                if block.type == BLOCK_ASK_USER and str(block.payload.get("question_id") or "") == qid:
                    updated = build(block.payload)
                    if updated is None:
                        return
                    self._messages[i] = replace_content_block(
                        msg, predicate=lambda b: (b.type == BLOCK_ASK_USER
                                                  and str(b.payload.get("question_id") or "") == qid),
                        new_block=make_payload_block(BLOCK_ASK_USER, updated))
                    return

    def _on_ask_user_presented(self, event: CircleEvent) -> None:
        payload = event.get("payload") or {}
        qid = str(payload.get("question_id") or "")
        if not qid:
            return

        def build(current: Mapping[str, Any]) -> dict | None:
            if current.get("resolved") or current.get("presented"):
                return None
            return {**dict(current), "presented": True, "presented_ts": payload.get("ts"),
                    "presented_channel": str(payload.get("channel") or ""),
                    "redacted_render_digest": str(payload.get("redacted_render_digest") or ""),
                    "option_tokens": list(payload.get("option_tokens") or [])}

        self._replace_ask_block(qid, build)

    def _on_ask_user_answered(self, event: CircleEvent) -> None:
        payload = dict(event.get("payload") or {})
        payload.setdefault("outcome", "answered")
        self._on_ask_user_resolved({**event, "payload": payload})

    def _on_ask_user_resolved(self, event: CircleEvent) -> None:
        payload = event.get("payload") or {}
        qid = str(payload.get("question_id") or "")
        if not qid:
            return
        outcome = str(payload.get("outcome") or "answered")

        def build(current: Mapping[str, Any]) -> dict | None:
            if current.get("resolved"):
                return None
            return {**dict(current), "resolved": True, "outcome": outcome,
                    "answered": outcome == "answered", "answers": dict(payload.get("answers") or {}),
                    "reason": str(payload.get("reason") or ""), "resolved_ts": payload.get("ts")}

        self._replace_ask_block(qid, build)

    def _on_error(self, event: CircleEvent) -> None:
        payload = event.get("payload") or {}
        text = str(payload.get("error") or "") if isinstance(payload, dict) else str(payload or "")
        block_payload: dict = {"text": text if text.strip() else ERROR_WITHOUT_TEXT}
        if isinstance(payload, dict) and isinstance(payload.get("api_error"), dict):
            block_payload["api_error"] = dict(payload["api_error"])
        self._append_system(event, make_payload_block(BLOCK_ERROR, block_payload))

    def _on_warn(self, event: CircleEvent) -> None:
        payload = event.get("payload") or {}
        text = str(payload.get("text") or payload) if isinstance(payload, dict) else str(payload)
        self._append_system(event, make_payload_block(BLOCK_WARN, {"text": text}))

    # ── misc ───────────────────────────────────────────────────────────────

    def _current_subagent_parent(self, event: CircleEvent) -> str:
        """The task call a subagent event belongs to; "" for main-agent events (a second
        task the main agent starts while the first still runs is its own call, not a
        nested one)."""
        tags = event.get("tags") or {}
        if not tags.get("parent_subagent"):
            return ""
        lc_task = str(tags.get("parent_tool_use_id") or "")
        if lc_task:
            owner = str(self._card_payload(self._card_uuid(lc_task)).get("tool_use_id") or "")
            if owner:
                return owner
        return self._subagent_parent_stack[-1] if self._subagent_parent_stack else ""

    def _merge_usage(self, usage: dict[str, Any]) -> None:
        for key in ("input_tokens", "output_tokens", "total_tokens", "prompt_cache_hit_tokens",
                    "prompt_cache_miss_tokens", "prompt_cache_write_tokens",
                    "prompt_cache_write_1h_tokens"):
            value = usage.get(key)
            if isinstance(value, int):
                self._usage[key] = self._usage.get(key, 0) + value

    def _notify(self, snap: MessageSnapshot) -> None:
        for cb in list(self._listeners):
            try:
                cb(snap)
            except Exception:  # noqa: BLE001
                logger.exception("MessageReducer listener error")


__all__ = ["AGENT_TRANSCRIPT_MAX", "MessageReducer", "SUBAGENT_TOOLS"]
