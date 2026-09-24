
from __future__ import annotations

import os
import random
import threading
import time

from ..dom import DOMElement, NodeType, create_element, create_text
from ..theme import GLYPH_ERROR, palette
from ...display_lexicon import (
    api_error_slot,
    api_waiting_aggregate_slot,
    footer_between_rounds_slot,
    footer_model_call_slot,
    footer_tool_slot,
    footer_worker_slot,
)
from .. import shimmer
from ...pricing import (
    compute_cost,
    context_window_for,
    cost_currency,
    cost_reference_basis,
    format_usage_costs,
)

_VERBS = [
    "Thinking", "Considering", "Analyzing", "Brewing", "Pondering",
    "Cogitating", "Reflecting", "Processing", "Evaluating", "Examining",
]

_PHASE_STATE_TEXT = {
    "thinking": "深度思考中",
    "output": "生成回答中",
    "input": "接收/处理中",
}

_FOOTER_INDENT = " "

_PHASE_STALE_S = 90.0


def _format_elapsed(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    m, s = divmod(int(seconds), 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m"


def _format_token_count(n: int) -> str:
    if n >= 1000:
        return f"{n / 1000:.1f}k"
    return f"{n:,}"


def _nonnegative_int(value: object) -> int:
    try:
        number = int(float(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0
    return max(0, number)


class _Unset:
    """没传这个参数——与显式传 None（清空本轮计时起点）区分开。"""


_UNSET = _Unset()


class FooterPane:

    def __init__(self, *, render_callback=None, thinking_text_cb=None) -> None:
        self._node = create_element(NodeType.BOX)
        self._node.style.height = 2
        self._node.text_styles.dim = True
        self._status_line = create_text("")
        self._hint_line = create_text("")
        self._node.append_child(self._status_line)
        self._node.append_child(self._hint_line)
        self._engine_line = create_text("")
        self._node.append_child(self._engine_line)
        self._engine_text = ""
        self._max_thinking = False

        self._render_cb = render_callback
        self._thinking_cb = thinking_text_cb
        self.status: str = "ready"
        self.tokens_used: int = 0
        self.tokens_budget: int = 128_000
        self.model: str = ""
        self._usage_model_uncertain = False
        self._main_costs: dict = {}
        self._fork_costs: dict = {}
        self._costs_supplied = False
        self.input_tokens: int = 0
        self.output_tokens: int = 0
        self.fork_input: int = 0
        self.fork_output: int = 0
        self.fork_cache_hit: int = 0
        self.fork_cache_write: int = 0
        self.fork_cache_write_1h: int = 0
        self.fork_live_output: int = 0
        self._latest_evidence: str = ""
        self._obs_warning: str = ""
        self._cache_hit_tokens: int = 0
        self._cache_write_tokens: int = 0
        self._cache_write_1h_tokens: int = 0
        self._llm_phase: str = ""
        self._output_token_count: int = 0
        self._phase_sig: tuple[str, int] = ("", 0)
        self._phase_beat: float = 0.0
        self._run_start_input: int = 0
        self.fork_last_event_ts: float = 0.0
        self.fork_stream_ts: float = 0.0
        self._run_start_output: int = 0
        self._busy_since: float = 0.0
        self._verb: str = ""
        self._reasoning_last_line: str = ""
        self.llm_round: int = 0
        self.call_started_at: float | None = None
        self.reasoning_active: bool = False
        self.reasoning_chars: int = 0
        self.reasoning_effort: str = ""
        self.reasoning_tokens: int = 0
        self._timer: threading.Timer | None = None
        self._timer_running = False
        self._search_query: str | None = None
        self._search_match: str | None = None
        self._yolo_enabled = False
        self._toast_text: str | None = None
        self._toast_timer: threading.Timer | None = None
        self._sticky_error: str | None = None
        self._hold_status: str | None = None
        self._activity: dict | None = None
        self._refresh()

    @property
    def node(self) -> DOMElement:
        return self._node

    def hold_status(self, text: str) -> None:
        """Keep a prompt on the status line while the busy timer is refreshing."""
        self._hold_status = text
        self._refresh()

    def clear_hold_status(self) -> None:
        self._hold_status = None
        self._refresh()

    def set_yolo(self, enabled: bool) -> None:
        self._yolo_enabled = bool(enabled)
        self._refresh()

    def _hint_line_text(self, tail: str) -> str:
        prefix = ""
        if self._yolo_enabled:
            prefix = "\x1b[1;34myolo · \x1b[0m"
        return _FOOTER_INDENT + prefix + tail

    def set_status(self, *, phase: str = "", model: str = "") -> None:
        """Gate UI helper used by CircleApp._rebuild (init/trust screens)."""
        status = phase or self.status or "ready"
        # Gate phases are not "running" — keep footer calm.
        if status not in {"ready", "error", "running"}:
            status = "ready"
        kwargs: dict = {"status": status}
        if model:
            kwargs["model"] = model
        self.update(**kwargs)

    def update(
        self,
        *,
        status: str | None = None,
        tokens_used: int | None = None,
        tokens_budget: int | None = None,
        model: str | None = None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        fork_input: int | None = None,
        fork_output: int | None = None,
        fork_cache_hit: int | None = None,
        fork_cache_write: int | None = None,
        fork_cache_write_1h: int | None = None,
        main_costs: dict | None = None,
        fork_costs: dict | None = None,
        fork_live_output: int | None = None,
        latest_evidence: str | None = None,
        llm_phase: str | None = None,
        output_token_count: int | None = None,
        cache_hit_tokens: int | None = None,
        cache_write_tokens: int | None = None,
        cache_write_1h_tokens: int | None = None,
        llm_round: int | None = None,
        call_started_at: float | None | _Unset = _UNSET,
        reasoning_active: bool | None = None,
        reasoning_last_line: str | None = None,
        reasoning_chars: int | None = None,
        reasoning_effort: str | None = None,
        reasoning_tokens: int | None = None,
    ) -> None:
        if status is not None:
            self.status = status
            if status not in ("ready", "error"):
                self._start_timer()
                self._sticky_error = None
            else:
                self._stop_timer()
        if tokens_used is not None:
            self.tokens_used = tokens_used
        if tokens_budget is not None:
            self.tokens_budget = tokens_budget
        if main_costs is not None:
            self._main_costs = main_costs
            self._costs_supplied = True
        if fork_costs is not None:
            self._fork_costs = fork_costs
            self._costs_supplied = True
        if model is not None:
            if model != self.model and (self.input_tokens or self.output_tokens):
                self._usage_model_uncertain = True
            self.model = model
            if tokens_budget is None:
                self.tokens_budget = context_window_for(model)
        if input_tokens is not None:
            self.input_tokens = input_tokens
        if output_tokens is not None:
            self.output_tokens = output_tokens
        if input_tokens == 0 and output_tokens == 0:
            self._usage_model_uncertain = False
        if fork_input is not None:
            self.fork_input = fork_input
        if fork_output is not None:
            self.fork_output = fork_output
        if fork_cache_hit is not None:
            self.fork_cache_hit = fork_cache_hit
        if fork_cache_write is not None:
            self.fork_cache_write = fork_cache_write
        if fork_cache_write_1h is not None:
            self.fork_cache_write_1h = fork_cache_write_1h
        if fork_live_output is not None:
            self.fork_live_output = _nonnegative_int(fork_live_output)
        if latest_evidence is not None:
            self._latest_evidence = latest_evidence
        if llm_phase is not None:
            self._llm_phase = llm_phase
        if output_token_count is not None:
            self._output_token_count = output_token_count
        if cache_hit_tokens is not None:
            self._cache_hit_tokens = cache_hit_tokens
        if cache_write_tokens is not None:
            self._cache_write_tokens = cache_write_tokens
        if cache_write_1h_tokens is not None:
            self._cache_write_1h_tokens = cache_write_1h_tokens
        if reasoning_effort is not None:
            self.reasoning_effort = reasoning_effort
        if reasoning_tokens is not None:
            self.reasoning_tokens = reasoning_tokens
        if llm_round is not None:
            self.llm_round = max(0, int(llm_round))
        if not isinstance(call_started_at, _Unset):
            self.call_started_at = call_started_at
        if reasoning_active is not None:
            self.reasoning_active = bool(reasoning_active)
        if reasoning_last_line is not None:
            self._reasoning_last_line = str(reasoning_last_line).strip()
        if reasoning_chars is not None:
            self.reasoning_chars = max(0, int(reasoning_chars))
        sig = (self._llm_phase, self._output_token_count)
        if sig != self._phase_sig:
            self._phase_sig = sig
            self._phase_beat = time.time()
        self._refresh()

    def set_engine_line(self, text: str) -> None:
        if text == self._engine_text:
            return
        self._engine_text = text
        self._engine_line.set_value(text)
        self._node.style.height = 3 if text else 2

    def set_max_thinking(self, on: bool) -> None:
        on = bool(on)
        if on == self._max_thinking:
            return
        self._max_thinking = on
        if self._render_cb:
            self._render_cb()

    def set_activity_state(self, state: dict | None) -> None:
        if state == self._activity:
            return
        self._activity = dict(state) if isinstance(state, dict) else None
        if self._render_cb:
            self._render_cb()

    def _activity_slot_text(self, *, silent: bool) -> str:
        act = self._activity
        if not isinstance(act, dict) or not act:
            return ""
        kind = str(act.get("kind") or "")
        if kind == "engine_node":
            return str(act.get("label") or "")
        worker = str(act.get("worker") or "")
        if kind == "waiting":
            waiting = act.get("waiting")
            waiting = waiting if isinstance(waiting, dict) else {}
            peers = int(act.get("peers") or 1)
            if peers > 1:
                return api_waiting_aggregate_slot(
                    peers, waiting.get("code"), waiting.get("waited_s"), worker)
            return footer_worker_slot(worker, api_error_slot(
                waiting.get("code"), waiting.get("attempt"),
                waiting.get("max"), waiting.get("waited_s"),
                exhausted=bool(act.get("exhausted")),
            ))
        if not silent:
            return ""
        secs = self._state_seconds(act)
        if kind == "model_call":
            tail = footer_model_call_slot(secs)
        elif kind == "tool":
            tail = footer_tool_slot(act.get("tool"), secs)
        elif kind == "between_rounds":
            tail = footer_between_rounds_slot(secs)
        else:
            return ""
        return footer_worker_slot(worker, tail)

    @staticmethod
    def _state_seconds(act: dict) -> int:
        try:
            since = float(act.get("since") or 0.0)
        except (TypeError, ValueError):
            since = 0.0
        if since <= 0.0:
            return 0
        return max(0, int(time.time() - since))

    def set_obs_warning(self, text: str) -> None:
        one_line = " ".join(str(text or "").split())[:60]
        if one_line != self._obs_warning:
            self._obs_warning = one_line
            self._refresh()

    def set_sticky_error(self, text: str) -> None:
        one_line = " ".join(str(text or "").split())
        if len(one_line) > 96:
            one_line = one_line[:93] + "…"
        self._sticky_error = one_line or None
        self._refresh()

    def set_search_state(self, query: str | None, match: str | None) -> None:
        self._search_query = query
        self._search_match = match
        self._refresh()

    def set_toast(self, text: str | None, ttl_seconds: float = 1.2) -> None:
        if self._toast_timer is not None:
            self._toast_timer.cancel()
            self._toast_timer = None
        self._toast_text = text
        self._refresh()
        if self._render_cb:
            self._render_cb()
        if text and ttl_seconds > 0:
            t = threading.Timer(ttl_seconds, self._clear_toast)
            t.daemon = True
            self._toast_timer = t
            t.start()

    def _clear_toast(self) -> None:
        self._toast_text = None
        self._toast_timer = None
        self._refresh()
        if self._render_cb:
            self._render_cb()

    def set_reasoning_last_line(self, line: str | None) -> None:
        self._reasoning_last_line = str(line or "").strip()

    def _start_timer(self) -> None:
        if self._timer_running:
            return
        self._busy_since = time.time()
        self._verb = random.choice(_VERBS)
        self._run_start_input = self.input_tokens + self.fork_input
        self._run_start_output = self.output_tokens + self.fork_output
        self._timer_running = True
        self._tick()

    def _stop_timer(self) -> None:
        self._timer_running = False
        if self._timer:
            self._timer.cancel()
            self._timer = None

    def shutdown(self) -> None:
        self._stop_timer()
        if self._toast_timer is not None:
            self._toast_timer.cancel()
            self._toast_timer = None

    def _tick(self) -> None:
        if not self._timer_running:
            return
        self._refresh()
        if self._render_cb:
            self._render_cb()
        self._timer = threading.Timer(shimmer.frame_seconds(), self._tick)
        self._timer.daemon = True
        self._timer.start()

    def _session_summary(self) -> str:
        total_in = self.input_tokens + self.fork_input
        settled_out = self.output_tokens + self.fork_output
        display_out = settled_out + self.fork_live_output
        hit = min(self._cache_hit_tokens + self.fork_cache_hit, total_in)
        write = min(
            self._cache_write_tokens + self.fork_cache_write,
            max(total_in - hit, 0),
        )
        write_1h = min(self._cache_write_1h_tokens + self.fork_cache_write_1h, write)
        miss = max(total_in - hit - write, 0)
        parts = [
            f"↑ {_format_token_count(total_in)} · ↓ {_format_token_count(display_out)} tokens"
        ]
        effort = (self.reasoning_effort or "").strip()
        if self.model and effort:
            parts.append(f"{self.model} ({effort})")
        elif self.model:
            parts.append(self.model)
        if self._costs_supplied:
            parts.append(format_usage_costs(
                self._main_costs, self._fork_costs, empty_model=self.model,
                has_settled_tokens=bool(total_in or settled_out),
            ))
        # 旧快照没有逐调用费用时保留旧口径；新事件不再按页脚当前模型重算累计量。
        elif any((self.fork_input, self.fork_output, self.fork_cache_hit,
                self.fork_cache_write, self.fork_live_output)):
            parts.append("—")
        elif self._usage_model_uncertain:
            parts.append("—")
        else:
            basis = cost_reference_basis(self.model)
            cost = compute_cost(
                self.model,
                input_miss=miss,
                input_hit=hit,
                output=settled_out,
                input_write=write,
                input_write_1h=write_1h,
            ) if basis else None
            if cost is None or not basis:
                parts.append("—")
            else:
                parts.append(f"{cost_currency(self.model)}{cost:.4f}")
        rate = (hit / total_in * 100.0) if total_in else 0.0
        budget = self.tokens_budget or 0
        meter = f"CH{rate:.1f}%"
        if budget > 0:
            pct = min(999.0, total_in / budget * 100.0)
            meter += (
                f" CTX {_format_token_count(total_in)}/{budget / 1000:.1f} ({pct:.0f}%)"
            )
        parts.append(meter)
        return " · ".join(parts)

    def _busy_label(self, elapsed: float) -> str:
        """The busy word on the composer's top edge (InfoTest ``FooterPane._busy_label``):
        verb, this run's tokens, elapsed, and the phase or what it is waiting on."""
        elapsed_str = _format_elapsed(elapsed)
        run_in = max(0, self.input_tokens + self.fork_input - self._run_start_input)
        run_out = max(0, self.output_tokens + self.fork_output - self._run_start_output)
        state = _PHASE_STATE_TEXT.get(self._llm_phase)
        if state and self._phase_beat and time.time() - self._phase_beat > _PHASE_STALE_S:
            state = None
        if state and self._max_thinking and self._llm_phase == "thinking":
            state = "最大深度思考中"
        if state:
            if self._llm_phase == "input":
                tok = f"↑ {_format_token_count(run_in)} tokens"
                quiet = (max(0, int(time.time() - self.call_started_at))
                         if self.call_started_at is not None else 0)
                head = f"{self._verb} {quiet}s" if quiet >= 5 else self._verb
            else:
                tok = (f"↓ {_format_token_count(run_out + self.fork_live_output)}"
                       f"(+{_format_token_count(self._output_token_count)}) tokens")
                head = self._verb
            wait = self._activity_slot_text(silent=False)
            return f"{head}… · {tok} · {elapsed_str}" + (f" · {wait}" if wait else "") + f" · {state}"
        tok = (f"↑ {_format_token_count(run_in)}"
               f" · ↓ {_format_token_count(run_out + self.fork_live_output)} tokens")
        silent = False
        if self.fork_last_event_ts > (self._busy_since or 0.0):
            idle = time.time() - self.fork_last_event_ts
            stream_idle = (time.time() - self.fork_stream_ts) if self.fork_stream_ts else float("inf")
            try:
                stall_s = float(os.environ.get("CIRCLE_LLM_STALL_TIMEOUT")
                                or os.environ.get("IST_LLM_STALL_TIMEOUT") or 180.0)
            except (TypeError, ValueError):
                stall_s = 180.0
            silent = idle >= stall_s and stream_idle >= stall_s
        slot = self._activity_slot_text(silent=silent)
        wait = f" · {slot}" if slot else ""
        max_tag = " · 最大深度思考中" if self._max_thinking else ""
        return f"{self._verb}… · {elapsed_str} · {tok}{wait}{max_tag}"

    def _refresh(self) -> None:
        if self._search_query is not None:
            match_disp = self._search_match if self._search_match else ""
            status_text = f"(reverse-i-search) '{self._search_query}': {match_disp}"
            self._status_line.set_value(_FOOTER_INDENT + status_text)
            self._hint_line.set_value(
                self._hint_line_text("ctrl+r next · enter accept · esc cancel")
            )
            return
        if self._toast_text is not None:
            self._status_line.set_value(_FOOTER_INDENT + self._toast_text)

            self._hint_line.set_value(
                self._hint_line_text("ctrl+c abort · ctrl+d exit · / commands · ↑↓ history")
            )
            return
        if self._timer_running and self._busy_since:
            # Plain text. The composer frame paints this label with the same
            # rainbow as the border, so the word is not a second flow.
            thinking_text = self._busy_label(time.time() - self._busy_since)
            if self._thinking_cb:
                self._thinking_cb(thinking_text)
        else:
            
            if self._thinking_cb:
                self._thinking_cb(None)
        
        status_text = self._hold_status or self._session_summary()
        if self._sticky_error and self.status == "error":
            pal = palette()
            status_text = (f"{pal.red}{GLYPH_ERROR} {self._sticky_error}"
                           f"{pal.reset} · {status_text}")
        self._status_line.set_value(_FOOTER_INDENT + status_text)
        if self._obs_warning:
            self._hint_line.set_value(
                self._hint_line_text(
                    f"{palette().yellow}{self._obs_warning}{palette().reset}"
                    f" · ctrl+c abort · ctrl+d exit · / commands"
                )
            )
        else:
            self._hint_line.set_value(
                self._hint_line_text(
                    "ctrl+c abort · ctrl+d exit · / commands · ↑↓ history"
                )
            )
