"""Circle harness.

File and shell access are Deep Agents' own tools. This module does not
define a filesystem tool or a sandbox.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import LocalShellBackend
from langchain_core.language_models.chat_models import BaseChatModel
from langgraph.checkpoint.memory import MemorySaver

SYSTEM_PROMPT = (
    "You are Circle, a compile harness. "
    "Read, write, and run commands only through the built-in sandbox tools."
)

_INTERRUPT_ON = {"execute": True, "write_file": True, "edit_file": True}


def sandbox_backend(root_dir: str | Path | None = None) -> LocalShellBackend:
    """Framework local sandbox: filesystem tools plus execute.

    ``virtual_mode`` confines filesystem paths to ``root_dir``. Shell
    commands are not confined by that flag; ``inherit_env`` stays off so
    the parent process environment is not copied into commands.
    """
    return LocalShellBackend(
        root_dir=root_dir,
        virtual_mode=True,
        inherit_env=False,
    )


def create_harness(
    model: str | BaseChatModel,
    *,
    root_dir: str | Path | None = None,
    checkpointer: Any = None,
):
    """Build a harness whose file and shell tools are the framework defaults.

    Prefer passing a ``BaseChatModel`` built by ``circle.model.build_chat_model``
    so provider comes from Circle settings, not from model-name heuristics
    (e.g. ``grok-*`` → xAI).
    """
    return create_deep_agent(
        model=model,
        backend=sandbox_backend(root_dir),
        system_prompt=SYSTEM_PROMPT,
        interrupt_on=_INTERRUPT_ON,
        checkpointer=checkpointer if checkpointer is not None else MemorySaver(),
    )
