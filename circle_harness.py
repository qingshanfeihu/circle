"""Circle harness.

File and shell access are Deep Agents' own tools. This module does not
define a filesystem tool or a sandbox.
"""

from __future__ import annotations

from pathlib import Path

from deepagents import create_deep_agent
from deepagents.backends import LocalShellBackend
from langgraph.checkpoint.memory import MemorySaver

# The model sees this once. Tool behavior lives on the built-in tool schemas.
SYSTEM_PROMPT = (
    "You are Circle, a compile harness. "
    "Read, write, and run commands only through the built-in sandbox tools."
)

# Mutations wait for approval. Reads do not. The checkpointer is what makes
# the framework's interrupt actually pause.
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
    model: str,
    *,
    root_dir: str | Path | None = None,
    checkpointer=None,
):
    """Build a harness whose file and shell tools are the framework defaults."""
    return create_deep_agent(
        model=model,
        backend=sandbox_backend(root_dir),
        system_prompt=SYSTEM_PROMPT,
        interrupt_on=_INTERRUPT_ON,
        checkpointer=checkpointer if checkpointer is not None else MemorySaver(),
    )
