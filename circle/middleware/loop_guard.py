"""Remind the model to change strategy when it is going in circles.

Before each model call the tool calls since the last real user message are checked:

- the same call (name + arguments) three times within the last eight calls;
- four empty results (``no matches``, ``not found``, ``(empty)`` …) within the last eight;
- the same read target six times within sixteen calls where only paging arguments
  (``offset``/``limit``/…) change and the pages are not read in order;
- more than 25 calls in the turn with none of the above: a note that this is fine
  while each call brings something new.

The reminder is appended to the request only; the stored conversation is untouched,
so it disappears once the model moves on. Thresholds come from ``CIRCLE_LOOP_*``;
``CIRCLE_LOOP_GUARD=0`` turns it off.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Awaitable, Callable

from langchain.agents.middleware.types import AgentMiddleware, ModelRequest, ModelResponse
from langchain_core.messages import HumanMessage

logger = logging.getLogger(__name__)

REMINDER_TAG = "loop-guard"
_EMPTY_MARKERS = ("(no matches)", "no matches", "not found", "file empty", "(empty)",
                  "no files found", "no results")
_LOOSE_WINDOW = 16
_LOOSE_THRESHOLD = 6
_PAGING_KEYS = frozenset({"offset", "limit", "head_limit", "page", "page_size",
                          "start_line", "end_line"})
_LABEL_KEYS = ("pattern", "query", "file_path", "path", "glob", "url", "command")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except (TypeError, ValueError):
        return default


def _enabled() -> bool:
    return (os.environ.get("CIRCLE_LOOP_GUARD") or "1").strip().lower() not in (
        "0", "false", "no", "off")


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text", "") or "") if isinstance(b, dict) else str(b)
                         for b in content)
    return str(content or "")


def _fingerprint(name: str, args: Any) -> str:
    try:
        norm = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        norm = str(args)
    return hashlib.sha1(f"{name}::{norm}".encode("utf-8", "ignore")).hexdigest()[:16]


def _is_empty_result(content: str) -> bool:
    low = content.strip().lower()
    if not low:
        return True
    return len(low) <= 200 and any(marker in low for marker in _EMPTY_MARKERS)


def _last_user_index(messages: list) -> int:
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        if isinstance(msg, HumanMessage):
            if _text(msg.content).lstrip().startswith("<system-reminder"):
                continue
            return i
    return 0


def _label(name: str, args: Any) -> str:
    if not isinstance(args, dict):
        return name
    bits = [f"{k}={str(args[k])[:80]}" for k in _LABEL_KEYS if args.get(k)]
    return f"{name}({', '.join(bits)})" if bits else name


def analyze(messages: list, *, window: int) -> dict[str, Any]:
    fingerprints: list[str] = []
    labels: dict[str, str] = {}
    loose: list[tuple[str | None, int]] = []
    empty: list[bool] = []
    for msg in messages[_last_user_index(messages):]:
        for tc in getattr(msg, "tool_calls", None) or ():
            name = str(tc.get("name", "") if isinstance(tc, dict) else getattr(tc, "name", ""))
            args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
            fp = _fingerprint(name, args)
            fingerprints.append(fp)
            labels[fp] = _label(name, args)
            if "read" in name.lower() and isinstance(args, dict):
                stripped = {k: v for k, v in args.items() if k not in _PAGING_KEYS}
                lfp = _fingerprint(f"loose::{name}", stripped)
                try:
                    offset = int(str(args.get("offset") or args.get("page")
                                     or args.get("start_line") or 0))
                except (TypeError, ValueError):
                    offset = 0
                loose.append((lfp, offset))
                labels[lfp] = labels[fp]
            else:
                loose.append((None, 0))
        if getattr(msg, "type", "") == "tool":
            empty.append(_is_empty_result(_text(getattr(msg, "content", ""))))

    dup_count, dup_label = 0, ""
    recent = fingerprints[-window:]
    if recent:
        counts: dict[str, int] = {}
        for fp in recent:
            counts[fp] = counts.get(fp, 0) + 1
        top = max(counts, key=lambda k: counts[k])
        dup_count, dup_label = counts[top], labels.get(top, "")

    loose_count, loose_label = 0, ""
    groups: dict[str, list[int]] = {}
    for lfp, offset in loose[-_LOOSE_WINDOW:]:
        if lfp is not None:
            groups.setdefault(lfp, []).append(offset)
    for lfp, offsets in groups.items():
        if len(offsets) < 2 or all(b > a for a, b in zip(offsets, offsets[1:])):
            continue  # reading page after page in order is progress
        if len(offsets) > loose_count:
            loose_count, loose_label = len(offsets), labels.get(lfp, "")

    return {"tool_calls": len(fingerprints), "dup_count": dup_count, "dup_label": dup_label,
            "empty_count": sum(1 for flag in empty[-window:] if flag),
            "loose_count": loose_count, "loose_label": loose_label}


def build_reminder(stats: dict[str, Any], *, dup_threshold: int, empty_threshold: int,
                   soft_budget: int) -> str | None:
    found: list[str] = []
    if stats["dup_count"] >= dup_threshold:
        where = f" ({stats['dup_label']})" if stats["dup_label"] else ""
        found.append(f"the last {stats['dup_count']} calls include the same tool call with "
                     f"the same arguments{where}; it will return the same result again.")
    if stats["empty_count"] >= empty_threshold:
        found.append(f"{stats['empty_count']} recent calls came back empty (no matches / not "
                     "found).")
    if stats["loose_count"] >= _LOOSE_THRESHOLD:
        where = f" ({stats['loose_label']})" if stats["loose_label"] else ""
        found.append(f"{stats['loose_count']} recent calls read the same target{where} with "
                     "only paging arguments changing and not in order; rereading it adds "
                     "nothing new.")
    if found:
        return (f'<system-reminder data-source="{REMINDER_TAG}">\n'
                "You appear to be going in circles: " + " ".join(found) + "\n\n"
                "Retrying the same thing will not change the outcome. Pick a different move:\n"
                "1. Answer from what you already have, and say plainly what you could not "
                "find rather than guessing.\n"
                "2. Search differently: other keywords, paths or tools, or hand a broad "
                "search to the explore subagent.\n"
                "3. If only the user can fill the gap, ask with the question tool.\n"
                "</system-reminder>")
    if stats["tool_calls"] >= soft_budget:
        return (f'<system-reminder data-source="{REMINDER_TAG}">\n'
                f"Note: this turn has made {stats['tool_calls']} tool calls; no repeated or "
                "empty calls were seen. This is not a request to stop. If each call brings "
                "new information, carry on; change strategy only if you notice you are "
                "going in circles.\n"
                "</system-reminder>")
    return None


class LoopGuardMiddleware(AgentMiddleware):
    def __init__(self, *, dup_threshold: int | None = None, empty_threshold: int | None = None,
                 soft_budget: int | None = None, window: int | None = None) -> None:
        self.dup_threshold = (dup_threshold if dup_threshold is not None
                              else _env_int("CIRCLE_LOOP_DUP_THRESHOLD", 3))
        self.empty_threshold = (empty_threshold if empty_threshold is not None
                                else _env_int("CIRCLE_LOOP_EMPTY_THRESHOLD", 4))
        self.soft_budget = (soft_budget if soft_budget is not None
                            else _env_int("CIRCLE_LOOP_SOFT_BUDGET", 25))
        self.window = window if window is not None else _env_int("CIRCLE_LOOP_WINDOW", 8)

    def _with_reminder(self, request: ModelRequest) -> ModelRequest:
        if not _enabled():
            return request
        try:
            messages = list(request.messages)
            stats = analyze(messages, window=self.window)
            text = build_reminder(stats, dup_threshold=self.dup_threshold,
                                  empty_threshold=self.empty_threshold,
                                  soft_budget=self.soft_budget)
        except Exception:  # noqa: BLE001 — the guard must never break the turn
            logger.debug("loop_guard analysis failed; request sent unchanged", exc_info=True)
            return request
        if not text:
            return request
        logger.info("loop_guard: dup=%s empty=%s loose=%s calls=%s", stats["dup_count"],
                    stats["empty_count"], stats["loose_count"], stats["tool_calls"])
        return request.override(messages=[*messages, HumanMessage(content=text)])

    def wrap_model_call(self, request: ModelRequest,
                        handler: Callable[[ModelRequest], ModelResponse]) -> ModelResponse:
        return handler(self._with_reminder(request))

    async def awrap_model_call(self, request: ModelRequest,
                               handler: Callable[[ModelRequest], Awaitable[ModelResponse]]
                               ) -> ModelResponse:
        return await handler(self._with_reminder(request))
