from __future__ import annotations

from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage

from circle.run_control import check_cancelled, current_run
from circle.tool_registry import CONTROL_TOOLS, READ_TOOLS, ToolRegistry


class EffectGateMiddleware(AgentMiddleware):
    """Enforce plan mode at the common tool boundary, before HITL or handlers."""
    def __init__(self, registry: ToolRegistry, backend: Any):
        self.registry = registry
        self.backend = backend

    def before_model(self, state, runtime):
        check_cancelled()
        run = current_run.get()
        messages = run.take() if run is not None else []
        return {"messages": messages} if messages else None

    async def abefore_model(self, state, runtime):
        return self.before_model(state, runtime)

    def _refusal(self, request):
        check_cancelled()
        call = request.tool_call
        name, args = call["name"], call.get("args") or {}
        if not self.backend.plan_mode:
            return None
        allowed = name in READ_TOOLS | CONTROL_TOOLS or self.registry.get(name).effect == "read"
        if name in {"write_file", "edit_file"}:
            allowed = self.backend.is_plan_file(str(args.get("file_path") or ""))
        if name == "apply_patch":
            targets = [line.split(":", 1)[1].strip() for line in str(args.get("patchText") or "").splitlines()
                       if line.startswith(("*** Add File:", "*** Update File:", "*** Delete File:", "*** Move to:"))]
            allowed = bool(targets) and all(self.backend.is_plan_file(target) for target in targets)
            if "*** Delete File:" in str(args.get("patchText") or ""):
                allowed = False
        if not allowed:
            return ToolMessage(content=f"Plan mode: {name} is blocked (modifying or unknown effect).",
                               name=name, tool_call_id=call["id"], status="error")
        return None

    def wrap_tool_call(self, request, handler):
        refusal = self._refusal(request)
        return refusal if refusal is not None else handler(request)

    async def awrap_tool_call(self, request, handler):
        refusal = self._refusal(request)
        return refusal if refusal is not None else await handler(request)
