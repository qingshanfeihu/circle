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
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.subagents import GENERAL_PURPOSE_SUBAGENT
from langchain.agents.middleware import TodoListMiddleware
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.tools import BaseTool
from langgraph.checkpoint.memory import MemorySaver

try:
    from langgraph._internal._constants import CONFIG_KEY_DURABILITY
except ImportError:  # pragma: no cover - the key has had this value since langgraph 0.6
    CONFIG_KEY_DURABILITY = "__pregel_durability"

from circle.approvals import ApprovalPolicy, default_policy
from circle.context_middleware import build_context_middleware
from circle.host_paths import install_tilde_expansion
from circle.job_agents import BackgroundTaskMiddleware
from circle.job_tools import CircleFilesystemMiddleware, build_job_tools
from circle.jobs import JobRegistry
from circle.mcp_loader import load_mcp_tools_sync
from circle.memory_sources import memory_source_paths
from circle.middleware import (
    LoopGuardMiddleware,
    PlanTailMiddleware,
    ToolCallCompatibilityMiddleware,
    ToolErrorBoundaryMiddleware,
    ToolResultPruneMiddleware,
)
from circle.middleware.cancellation import CancellationMiddleware
from circle.middleware.job_notice import JobNoticeMiddleware
from circle.middleware.steering import SteeringMiddleware
from circle.middleware.tool_selection import ToolSelectionMiddleware
from circle.paths import project_data_dir
from circle.run_options import RunOptions
from circle.plan_backend import PlanGuardedBackend
from circle.prompt_features import (
    build_extra_tools,
    collect_tool_description_overrides,
    explore_subagent_spec,
    plan_mode_append,
)
from circle.sandbox import shell_environment
from circle.skills import skill_sources
from circle.system_prompt import (
    CONTEXT_FILE_NAMES,
    build_system_prompt,
    discover_context_files,
    file_identity,
    load_tool_prompt,
    prompt_overrides,
)

if TYPE_CHECKING:
    from circle.extensions import ExtensionHost

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = build_system_prompt()

# 需要审批的内置工具；是否真的弹审批由 circle.approvals 的策略按调用判定
GATED_TOOLS = ("execute", "write_file", "edit_file", "apply_patch", "delete")

# explore 子代理只拿只读工具：文件系统只留读类，额外工具只留不改状态的
EXPLORE_FS_TOOLS = ["ls", "read_file", "glob", "grep"]
EXPLORE_EXTRA_TOOLS = frozenset({"webfetch", "websearch", "lsp", "skill", "list_jobs"})

# 内置工具名：扩展不得占用（deepagents 自带 + circle extras + /compact 工具）
BUILTIN_TOOL_NAMES = frozenset({
    "ls", "read_file", "write_file", "edit_file", "glob", "grep", "execute", "write_todos",
    "task", "compact_conversation", "webfetch", "question", "skill", "websearch", "lsp",
    "apply_patch", "list_jobs", "stop_job", "wait_jobs",
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
            except Exception:
                logger.debug("tool description profile unavailable: %s", key, exc_info=True)
                continue
    _profiles_ready = True


def _todo_middleware() -> TodoListMiddleware:
    description = load_tool_prompt("write_todos")
    return TodoListMiddleware(tool_description=description) if description else TodoListMiddleware()


def sandbox_backend(
    root_dir: str | Path | None = None,
    *,
    plan_mode: bool = False,
    home: Path | None = None,
) -> PlanGuardedBackend:
    """Local sandbox: workspace-virtual paths under root; host abs paths pass through;
    summaries' history and very long tool results go to the data folder."""
    install_tilde_expansion()
    return PlanGuardedBackend(
        root_dir=root_dir,
        virtual_mode=True,
        inherit_env=False,
        env=shell_environment(workspace=root_dir or Path.cwd()),
        plan_mode=plan_mode,
        offload_root=project_data_dir(Path(root_dir) if root_dir else Path.cwd(), home),
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
    approvals: ApprovalPolicy | None = None,
    ask_user: bool = False,
    run_options: RunOptions | None = None,
    jobs: JobRegistry | None = None,
):
    """Build harness with file/shell tools, explore subagent, and prompt-backed extras.

    Prefers LangChain/deepagents primitives:
    - ``memory=`` → MemoryMiddleware (AGENTS.md / MEMORY.md)
    - built-in SummarizationMiddleware (auto compact at ~85% context)
    - SummarizationToolMiddleware → ``compact_conversation`` tool for /compact
    - ``checkpointer`` + ``store`` for short/long-term memory

    ``ask_user``: the caller answers ``ask_user`` interrupts (the full-screen session),
    so the ``question`` tool pauses for real answers instead of returning the questions
    as text.

    ``run_options``: what the command line chose for this run: a replaced or extended
    system prompt, no AGENTS.md / CLAUDE.md, and which tools the model gets.

    ``jobs``: the session's background jobs, kept across agent rebuilds; a private registry
    is made when none is given.
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

    options = run_options or RunOptions()
    base, added = prompt_overrides(cwd, home, system=options.system_prompt,
                                   append=options.append_system_prompt)
    append = "\n\n".join(part for part in (plan_mode_append() if plan_mode else None, *added)
                          if part) or None
    prompt = system_prompt or build_system_prompt(
        cwd=cwd,
        model_id=mid,
        protocol=protocol,
        append=append,
        extension_tools=extensions.catalog() if extensions is not None else None,
        context_files=[] if options.no_context_files else None,
        base=base,
    )

    explore = explore_subagent_spec()
    skills = skill_sources(cwd, home)
    memory = memory_source_paths(cwd, home)
    if options.no_context_files:
        memory = [path for path in memory if Path(path).name.lower() not in CONTEXT_FILE_NAMES]
    elif system_prompt is None:
        # Files already in the prompt as project instructions are not added again
        in_prompt = {file_identity(path) for path, _text in discover_context_files(cwd)}
        memory = [path for path in memory if file_identity(path) not in in_prompt]
    tools: list[Any] = list(build_extra_tools(cwd, home, plan_mode=plan_mode, ask_user=ask_user))
    if extra_tools:
        tools.extend(extra_tools)
    if mcp_servers:
        mcp_tools = load_mcp_tools_sync(mcp_servers)
        tools.extend(mcp_tools)
    else:
        mcp_tools = []
    backend = sandbox_backend(root_dir, plan_mode=plan_mode, home=home)
    jobs = jobs if jobs is not None else JobRegistry()
    backend.bind_jobs(jobs)
    descriptions = collect_tool_description_overrides()
    job_tools = build_job_tools(jobs, {name: load_tool_prompt(name) or ""
                                       for name in ("list_jobs", "stop_job", "wait_jobs")})
    tools.extend(job_tools[name] for name in ("list_jobs", "stop_job"))
    policy = approvals or default_policy(home)
    # 禁止类命令在后端拒绝执行：主代理与子代理共用这个后端，一处拦住全部
    backend.command_guard = policy.deny_message
    policy.bind_workspace(backend._resolve_path, backend.cwd)
    explore = {
        **explore,
        "tools": [t for t in tools if getattr(t, "name", None) in EXPLORE_EXTRA_TOOLS],
        # 替换子代理默认的文件系统中间件：没有 write_file / edit_file / delete / execute
        "middleware": [FilesystemMiddleware(backend=backend, tools=list(EXPLORE_FS_TOOLS)),
                       CancellationMiddleware()],
        # 只读子代理不需要审批；不写这一项它会继承主代理的审批表
        "interrupt_on": {},
    }
    gated: list[str] = list(GATED_TOOLS)
    # Declaring general-purpose explicitly lets the same cancellation boundary
    # reach it; deepagents only inherits replacements for existing middleware
    # slots into its automatically created general-purpose agent.
    general_purpose: dict[str, Any] = {
        **GENERAL_PURPOSE_SUBAGENT,
        # Its execute can run in the background too (deepagents swaps this in by name)
        "middleware": [CircleFilesystemMiddleware(backend=backend,
                                                  custom_tool_descriptions=descriptions),
                       CancellationMiddleware()],
    }
    if skills:
        general_purpose["skills"] = skills
    subagents: list[dict[str, Any]] = [general_purpose, explore]
    extension_middleware: list[Any] = []
    if extensions is not None:
        extensions.bind_jobs(jobs)
        taken = {getattr(t, "name", None) for t in tools} | set(BUILTIN_TOOL_NAMES)
        for tool in extensions.tools():
            if tool.name in taken:
                # MCP 工具在扩展加载之后才知道名字；撞名时内置/MCP 优先，扩展这一个丢弃
                logger.warning("extension tool %s clashes with an existing tool; skipped", tool.name)
                continue
            taken.add(tool.name)
            tools.append(tool)
        gated.extend(name for name in extensions.interrupt_on() if name in taken)
        for spec in extensions.subagents(tools):
            configured = {**spec, "middleware": [*spec.get("middleware", []),
                                                  CancellationMiddleware()]}
            existing = next((index for index, item in enumerate(subagents)
                             if item["name"] == spec["name"]), None)
            if existing is None:
                subagents.append(configured)
            else:
                subagents[existing] = configured
        extension_middleware = extensions.middleware()

    # 通用中间件在最前：错误边界包住其后所有工具层（含扩展的 tool_boundary），
    # 兼容层在执行前修形态；工具表要等 deepagents 组装完才齐，建完再 bind
    interrupt_on = policy.interrupt_on(gated)
    compat = ToolCallCompatibilityMiddleware(gated=interrupt_on)
    extra_mw: list[Any] = [
        ToolErrorBoundaryMiddleware(),
        CancellationMiddleware(),
        compat,
        ToolResultPruneMiddleware(),
        # deepagents 0.7 起不再默认挂 write_todos；提示词与计划面板都依赖它。
        # 同名中间件按名替换，模型档自带的那份（如 Codex）不会重复
        _todo_middleware(),
    ]
    # compact_conversation tool (pairs with auto SummarizationMiddleware)
    chat_model = model if not isinstance(model, str) else None
    if chat_model is not None:
        try:
            extra_mw.extend(build_context_middleware(chat_model, backend))
        except Exception:
            logger.debug("context middleware unavailable", exc_info=True)
    extra_mw.extend(extension_middleware)
    # Messages typed during the turn go in before the next model call.
    extra_mw.append(SteeringMiddleware())
    # Finished background jobs are told to the model before its next call.
    extra_mw.append(JobNoticeMiddleware(jobs))
    # Persist an occasional plan reminder after tool results. Its before_model
    # hook leaves a durable message instead of changing only the model request.
    extra_mw.append(PlanTailMiddleware())
    extra_mw.append(LoopGuardMiddleware(jobs=jobs))
    # task gains background (main agent only: a subagent cannot start a background one)
    background_tasks = BackgroundTaskMiddleware(jobs)
    extra_mw.append(background_tasks)
    if options.limits_tools():
        extra_mw.append(ToolSelectionMiddleware(allowed=options.tools,
                                                excluded=options.exclude_tools))
    # Replaces deepagents' own filesystem middleware in its place (by name): execute gains
    # background
    extra_mw.append(CircleFilesystemMiddleware(backend=backend,
                                               custom_tool_descriptions=descriptions))

    # Subagents cannot be woken by a notice, so the general-purpose one may wait for jobs
    general_purpose["tools"] = [*tools, job_tools["wait_jobs"]]

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
    kwargs["middleware"] = extra_mw
    if store is not None:
        kwargs["store"] = store

    # LangGraph 1.2.12 async delta-checkpoint workers can wait on one another
    # during fast multi-step turns. Finish each checkpoint before the next step.
    # with_config retains the compiled graph API and callers may still explicitly
    # select another durability mode through invoke/stream.
    agent = create_deep_agent(**kwargs).with_config(
        {"configurable": {CONFIG_KEY_DURABILITY: "sync"}}
    )
    try:
        compat.bind(agent.nodes["tools"].bound.tools_by_name.values())
    except Exception:
        logger.debug("tool table unavailable for tool-call repair", exc_info=True)
    # The compatibility layer checks task calls against the schema with background
    compat.bind(background_tasks.bind(agent, policy=policy))
    try:
        agent._circle_backend = backend  # type: ignore[attr-defined]
        agent._circle_approvals = policy  # type: ignore[attr-defined]
        agent._circle_mcp_tools = mcp_tools  # type: ignore[attr-defined]
        agent._circle_jobs = jobs  # type: ignore[attr-defined]
        agent._circle_background_tasks = background_tasks  # type: ignore[attr-defined]
    except Exception:
        logger.debug("Circle harness metadata unavailable", exc_info=True)
    return agent
