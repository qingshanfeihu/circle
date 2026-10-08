"""LangChain/deepagents context helpers — prefer framework primitives."""

from __future__ import annotations

import uuid
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage

from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.summarization import SummarizationToolMiddleware

from circle.compaction import create_circle_summarization


def build_context_middleware(
    model: BaseChatModel,
    backend: BackendProtocol,
) -> list[Any]:
    """The compaction, automatic and ``/compact``, through one engine that reports its steps.

    ``create_deep_agent`` adds deepagents' own ``SummarizationMiddleware``; the engine here
    has the same name, so it takes that one's place in the stack (custom middleware replaces
    a built-in of the same name). ``compact_conversation`` (``/compact``, or the model's own
    call) runs the same engine, so both kinds report to the screen the same way
    (circle/compaction.py). Thresholds come from ``model.profile``, which carries the window
    the footer shows (circle.model.apply_context_window).
    """
    engine = create_circle_summarization(model, backend)
    return [engine, SummarizationToolMiddleware(engine, system_prompt=None)]


def thread_config(thread_id: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread_id}}


def inject_thread_message(agent: Any, thread_id: str, message: BaseMessage) -> None:
    """Persist a message into the checkpointer without a model turn."""
    append_messages(agent, thread_config(thread_id), [message])


def append_messages(agent: Any, config: dict[str, Any], messages: list[BaseMessage]
                    ) -> dict[str, Any]:
    """Add messages to a thread without a model turn, after the checkpoint in ``config``
    (its latest when the config names none). Returns the config of the new checkpoint.

    LangGraph keeps an update's messages as writes on the checkpoint before it, and reads
    every write on a checkpoint when it rebuilds a later one. Going back to a checkpoint
    with writes for another branch would bring those messages along, so the update goes
    after an empty step, and the result is closed like the end of a turn: nothing waits to
    run, and /tree can go back to it.
    """
    config = {**config, "configurable": {"checkpoint_ns": "", **config.get("configurable", {})}}
    # Every message gets an id, so that /tree and later updates can tell them apart
    messages = [m if m.id else m.model_copy(update={"id": f"circle-{uuid.uuid4().hex}"})
                for m in messages]
    spacer = agent.update_state(config, None, as_node="__end__")
    written = agent.update_state(spacer, {"messages": messages})
    return agent.update_state(written, None, as_node="__end__")


def plan_boundary_message(*, enabled: bool) -> HumanMessage:
    """Inject a clear mode boundary into the checkpointer thread (not UI-only)."""
    if enabled:
        text = (
            "[Circle system] Plan mode is now ON. "
            "Do not create/edit/delete project files (except /plan.md) "
            "and do not run mutating shell commands. "
            "Research and update /plan.md only."
        )
    else:
        text = (
            "[Circle system] Plan mode is now OFF. "
            "Previous plan-mode constraints no longer apply. "
            "You may implement changes with normal tools subject to approval."
        )
    return HumanMessage(content=text)


def skill_boundary_message(*, name: str, body: str, args: str = "") -> HumanMessage:
    """Load a skill as a real conversation message (survives in checkpointer)."""
    arg_note = f"\nUser arguments: {args}\n" if args.strip() else "\n"
    return HumanMessage(
        content=(
            f"[Circle system] Skill `{name}` loaded via /skill.{arg_note}"
            f"Follow it for subsequent requests until the user says otherwise.\n\n"
            f"{body}"
        )
    )


def compact_prompt(*, hint: str = "") -> str:
    """User turn that asks the agent to call deepagents ``compact_conversation``."""
    base = (
        "Call the compact_conversation tool now (no arguments). "
        "After it returns, reply with only: COMPACT_OK "
        "(or briefly explain if nothing was compacted)."
    )
    if hint.strip():
        return f"User compact hint: {hint.strip()}\n\n{base}"
    return base

