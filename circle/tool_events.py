"""Show tool calls that were refused before the tool ran.

A call stopped by middleware (unknown tool, invalid arguments) or rejected at the
approval prompt never reaches the tool, so LangChain fires no tool callbacks and the
screen would have no row for it. This emits the same ``tool_call`` / ``tool_result``
pair the progress handler emits for a real call, marked as an error, into the bus of
the current run (ported from InfoTest ``announce_blocked_tool_call``). Without a bound
bus (tests, line mode) it does nothing.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from circle.events import EventBus, current_bus


def announce_blocked_tool_call(call: dict[str, Any], text: str, *, recoverable: bool = False,
                               bus: EventBus | None = None) -> None:
    target = bus or current_bus()
    if target is None:
        return
    name = str(call.get("name") or "tool")
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    run_id = f"blocked-{call.get('id') or uuid.uuid4().hex[:8]}"
    tags = {"name": name, "lc_tool_run_id": run_id}
    try:
        raw = json.dumps(args, ensure_ascii=False, default=str)[:400]
    except (TypeError, ValueError):
        raw = str(args)[:400]
    shown = {k: v for k, v in args.items() if isinstance(v, (str, int, float, bool)) or v is None}
    target.emit("tool_call", payload={"name": name, "input": {"raw": raw, "args": shown}}, tags=tags)
    payload: dict[str, Any] = {"name": name, "output": text, "status": "error"}
    if recoverable:
        payload["recoverable"] = True
    target.emit("tool_result", payload=payload, tags=tags)
