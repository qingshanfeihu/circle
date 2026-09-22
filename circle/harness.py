"""Circle harness.

Configures the sandbox backend, bundled system prompt, tool descriptions,
explore subagent, optional skills dirs, and extra tools.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from deepagents import (
    HarnessProfile,
    create_deep_agent,
    register_harness_profile,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool
from langgraph.checkpoint.memory import MemorySaver

from circle.mcp_loader import load_mcp_tools_sync
from circle.plan_backend import PlanGuardedBackend
from circle.prompt_features import (
    build_extra_tools,
    collect_tool_description_overrides,
    explore_subagent_spec,
    plan_mode_append,
)
from circle.skills import skill_sources
from circle.system_prompt import build_system_prompt

SYSTEM_PROMPT = build_system_prompt()

_INTERRUPT_ON = {
    "execute": True,
    "write_file": True,
    "edit_file": True,
    "apply_patch": True,
}

_PROFILE_KEYS = (
    "anthropic",
    "openai",
    "google_genai",
    "google",
    "azure_openai",
    "bedrock",
    "ollama",
)
_profiles_ready = False


def _ensure_tool_description_profiles() -> None:
    """Apply ``prompts/tools/*.md`` as deepagents tool description overrides."""
    global _profiles_ready
    if _profiles_ready:
        return
    overrides = collect_tool_description_overrides()
    if overrides:
        profile = HarnessProfile(tool_description_overrides=overrides)
        for key in _PROFILE_KEYS:
            try:
                register_harness_profile(key, profile)
            except Exception:  # noqa: BLE001
                continue
    _profiles_ready = True


def sandbox_backend(
    root_dir: str | Path | None = None,
    *,
    plan_mode: bool = False,
) -> PlanGuardedBackend:
    """Local sandbox: workspace-virtual paths under root; host abs paths pass through."""
    return PlanGuardedBackend(
        root_dir=root_dir,
        virtual_mode=True,
        inherit_env=False,
        plan_mode=plan_mode,
    )


def create_harness(
    model: str | BaseChatModel,
    *,
    root_dir: str | Path | None = None,
    home: Path | None = None,
    checkpointer: Any = None,
    model_id: str | None = None,
    protocol: str | None = None,
    system_prompt: str | None = None,
    plan_mode: bool = False,
    mcp_servers: list[dict[str, Any]] | None = None,
    extra_tools: list[BaseTool] | None = None,
):
    """Build harness with file/shell tools, explore subagent, and prompt-backed extras.

    Prefer a ``BaseChatModel`` from ``circle.model.build_chat_model``.
    """
    _ensure_tool_description_profiles()

    cwd = Path(root_dir).resolve() if root_dir else Path.cwd()
    mid = model_id
    if mid is None and isinstance(model, str):
        mid = model
    if mid is None:
        mid = getattr(model, "model_name", None) or getattr(model, "model", None)
        if mid is not None:
            mid = str(mid)

    append = plan_mode_append() if plan_mode else None
    prompt = system_prompt or build_system_prompt(
        cwd=cwd,
        model_id=mid,
        protocol=protocol,
        append=append,
    )

    explore = explore_subagent_spec()
    skills = skill_sources(cwd, home)
    tools: list[Any] = list(build_extra_tools(cwd, home, plan_mode=plan_mode))
    if extra_tools:
        tools.extend(extra_tools)
    if mcp_servers:
        mcp_tools = load_mcp_tools_sync(mcp_servers)
        tools.extend(mcp_tools)
    else:
        mcp_tools = []

    backend = sandbox_backend(root_dir, plan_mode=plan_mode)

    kwargs: dict[str, Any] = {
        "model": model,
        "backend": backend,
        "system_prompt": prompt,
        "interrupt_on": _INTERRUPT_ON,
        "checkpointer": checkpointer if checkpointer is not None else MemorySaver(),
        "tools": tools,
        "subagents": [explore],
    }
    if skills:
        kwargs["skills"] = skills

    agent = create_deep_agent(**kwargs)
    # Stash for plan toggle / MCP status without a second load.
    try:
        agent._circle_backend = backend  # type: ignore[attr-defined]  # noqa: SLF001
        agent._circle_mcp_tools = mcp_tools  # type: ignore[attr-defined]  # noqa: SLF001
    except Exception:  # noqa: BLE001
        pass
    return agent
