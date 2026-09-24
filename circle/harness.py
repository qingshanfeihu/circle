"""Circle harness.

Configures the sandbox backend, bundled system prompt, tool descriptions,
explore subagent, skills, LangChain/deepagents memory + summarization, and
extra tools.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from deepagents import (
    HarnessProfile,
    create_deep_agent,
    register_harness_profile,
)
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool
from langgraph.checkpoint.memory import MemorySaver

from circle.context_middleware import build_context_middleware
from circle.host_paths import install_tilde_expansion
from circle.mcp_loader import load_mcp_tools_sync
from circle.memory_sources import memory_source_paths
from circle.plan_backend import PlanGuardedBackend
from circle.prompt_features import (
    build_extra_tools,
    collect_tool_description_overrides,
    explore_subagent_spec,
    plan_mode_append,
)
from circle.skills import skill_sources
from circle.system_prompt import build_system_prompt

if TYPE_CHECKING:
    from circle.extensions import ExtensionHost

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = build_system_prompt()

_INTERRUPT_ON = {
    "execute": True,
    "write_file": True,
    "edit_file": True,
    "apply_patch": True,
}

# 内置工具名：扩展不得占用（deepagents 自带 + circle extras + /compact 工具）
BUILTIN_TOOL_NAMES = frozenset({
    "ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute", "write_todos",
    "task", "compact_conversation", "webfetch", "question", "skill", "websearch", "lsp",
    "apply_patch",
})

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
    install_tilde_expansion()
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
    store: Any = None,
    extensions: ExtensionHost | None = None,
):
    """Build harness with file/shell tools, explore subagent, and prompt-backed extras.

    Prefers LangChain/deepagents primitives:
    - ``memory=`` → MemoryMiddleware (AGENTS.md / MEMORY.md)
    - built-in SummarizationMiddleware (auto compact at ~85% context)
    - SummarizationToolMiddleware → ``compact_conversation`` tool for /compact
    - ``checkpointer`` + ``store`` for short/long-term memory
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
        extension_tools=extensions.catalog() if extensions is not None else None,
    )

    explore = explore_subagent_spec()
    skills = skill_sources(cwd, home)
    memory = memory_source_paths(cwd, home)
    tools: list[Any] = list(build_extra_tools(cwd, home, plan_mode=plan_mode))
    if extra_tools:
        tools.extend(extra_tools)
    if mcp_servers:
        mcp_tools = load_mcp_tools_sync(mcp_servers)
        tools.extend(mcp_tools)
    else:
        mcp_tools = []
    interrupt_on = dict(_INTERRUPT_ON)
    subagents: list[dict[str, Any]] = [explore]
    extension_middleware: list[Any] = []
    if extensions is not None:
        taken = {getattr(t, "name", None) for t in tools} | set(BUILTIN_TOOL_NAMES)
        for tool in extensions.tools():
            if tool.name in taken:
                # MCP 工具在扩展加载之后才知道名字；撞名时内置/MCP 优先，扩展这一个丢弃
                logger.warning("extension tool %s clashes with an existing tool; skipped", tool.name)
                continue
            taken.add(tool.name)
            tools.append(tool)
        interrupt_on.update({name: True for name in extensions.interrupt_on() if name in taken})
        subagents.extend(extensions.subagents(tools))
        extension_middleware = extensions.middleware()

    backend = sandbox_backend(root_dir, plan_mode=plan_mode)

    # compact_conversation tool (pairs with auto SummarizationMiddleware)
    chat_model = model if not isinstance(model, str) else None
    extra_mw: list[Any] = []
    if chat_model is not None:
        try:
            extra_mw = build_context_middleware(chat_model, backend)
        except Exception:  # noqa: BLE001
            extra_mw = []
    extra_mw.extend(extension_middleware)

    kwargs: dict[str, Any] = {
        "model": model,
        "backend": backend,
        "system_prompt": prompt,
        "interrupt_on": interrupt_on,
        "checkpointer": checkpointer if checkpointer is not None else MemorySaver(),
        "tools": tools,
        "subagents": subagents,
    }
    if skills:
        kwargs["skills"] = skills
    if memory:
        kwargs["memory"] = memory
    if extra_mw:
        kwargs["middleware"] = extra_mw
    if store is not None:
        kwargs["store"] = store

    agent = create_deep_agent(**kwargs)
    try:
        agent._circle_backend = backend  # type: ignore[attr-defined]  # noqa: SLF001
        agent._circle_mcp_tools = mcp_tools  # type: ignore[attr-defined]  # noqa: SLF001
    except Exception:  # noqa: BLE001
        pass
    return agent
