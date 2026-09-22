"""Circle harness.

Configures the sandbox backend, bundled system prompt, tool descriptions,
explore subagent, optional skills dirs, and extra tools (webfetch, question).
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
from langgraph.checkpoint.memory import MemorySaver

from circle.prompt_features import (
    build_extra_tools,
    collect_tool_description_overrides,
    explore_subagent_spec,
    plan_mode_append,
)
from circle.sandbox import CircleSandboxBackend
from circle.skills import skill_sources
from circle.system_prompt import build_system_prompt

SYSTEM_PROMPT = build_system_prompt()

_INTERRUPT_ON = {
    "execute": True,
    "write_file": True,
    "edit_file": True,
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


def sandbox_backend(root_dir: str | Path | None = None) -> CircleSandboxBackend:
    """Local sandbox: workspace-virtual paths under root; host abs paths pass through."""
    return CircleSandboxBackend(
        root_dir=root_dir,
        virtual_mode=True,
        inherit_env=False,
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
    # Note: FilesystemPermission cannot be used with SandboxBackendProtocol yet
    # (deepagents limitation). Explore/plan stay read-mostly via system prompts.

    skills = skill_sources(cwd, home)
    extra = build_extra_tools(cwd, home)

    kwargs: dict[str, Any] = {
        "model": model,
        "backend": sandbox_backend(root_dir),
        "system_prompt": prompt,
        "interrupt_on": _INTERRUPT_ON,
        "checkpointer": checkpointer if checkpointer is not None else MemorySaver(),
        "tools": extra,
        "subagents": [explore],
    }
    if skills:
        kwargs["skills"] = skills

    return create_deep_agent(**kwargs)
