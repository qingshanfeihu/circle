"""Rebuild a saved conversation for the screen.

Each user message is paired with a snapshot of the turn that answered it, so a reopened
session is drawn by the same code as a live turn and ctrl+o / ctrl+t work on it.
"""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from circle.jobs import NOTICE_MARKER, is_job_notice
from circle.middleware.loop_guard import is_loop_reminder
from circle.middleware.plan_tail import is_plan_reminder
from circle.tui.content_blocks import parse_content
from circle.tui.message_model import (
    BLOCK_JOB_NOTICE,
    Message,
    MessageSnapshot,
    make_assistant_message,
    make_payload_block,
    make_text_block,
    make_thinking_block,
    make_tool_result_block,
    make_tool_use_block,
)


def is_user_message(msg: Any) -> bool:
    """Something the user wrote, not a reminder or summary Circle or deepagents added."""
    if not isinstance(msg, HumanMessage) or is_plan_reminder(msg) or is_loop_reminder(msg):
        return False
    extra = msg.additional_kwargs or {}
    return extra.get("lc_source") != "summarization" and not extra.get("circle_internal")


def shown_text(msg: HumanMessage) -> str:
    """What the user saw when sending: pastes folded, attached files left out."""
    extra = msg.additional_kwargs or {}
    shell = extra.get("circle_shell")
    if isinstance(shell, dict):
        return f"!{shell.get('command', '')}"
    shown = extra.get("circle_shown")
    return shown if isinstance(shown, str) else parse_content(msg.content).text or str(msg.content)


def draft_of(msg: HumanMessage) -> tuple[str, dict[int, str]]:
    """A sent message back as an editable draft: its short form and the pastes it names."""
    pastes = (msg.additional_kwargs or {}).get("circle_pastes") or {}
    return shown_text(msg), {int(k): str(v) for k, v in pastes.items() if str(k).isdigit()}


def write_history(agent: Any, thread_id: str, messages: list[Any]) -> None:
    """Copy messages into a thread one turn at a time, so that /tree in the new session
    can go back to the end of each of them (/fork, /clone, ``--fork``)."""
    from circle.context_middleware import append_messages

    turns: list[list[Any]] = []
    for msg in messages:
        if is_user_message(msg) or not turns:
            turns.append([])
        turns[-1].append(msg)
    config = {"configurable": {"thread_id": thread_id}}
    for turn in turns:
        append_messages(agent, config, turn)


def first_turns(messages: list[Any], turns: int) -> list[Any]:
    """The messages of the first ``turns`` turns: everything before the next user message."""
    seen = 0
    for index, msg in enumerate(messages):
        if is_user_message(msg):
            seen += 1
            if seen > turns:
                return list(messages[:index])
    return list(messages)


def saved_turns(messages: list[Any]) -> list[tuple[str, MessageSnapshot]]:
    """``(what the user wrote, the turn's snapshot)`` for each turn, oldest first. A turn
    that Circle started for finished background jobs has no text: its snapshot opens with
    the jobs' rows."""
    turns: list[tuple[str, list[Message]]] = []
    hidden = False  # inside a /compact exchange, which the screen did not show as a turn
    answered = True  # the last turn has ended with an answer (no call left to run)
    for index, msg in enumerate(messages):
        if is_job_notice(msg):
            jobs = list((msg.additional_kwargs or {}).get(NOTICE_MARKER) or [])
            notice = make_assistant_message(uuid=f"saved:{index}", content=[
                make_payload_block(BLOCK_JOB_NOTICE, {"jobs": jobs})])
            if answered or not turns:
                turns.append(("", [notice]))  # it started a turn of its own
            else:
                turns[-1][1].append(notice)  # it reached the model in the running turn
            hidden = False
            answered = False
            continue
        if isinstance(msg, HumanMessage) and (msg.additional_kwargs or {}).get("circle_internal"):
            hidden = hidden or (msg.additional_kwargs or {}).get("circle_internal") == "compact"
            continue
        if isinstance(msg, HumanMessage):
            if not is_user_message(msg):
                continue
            hidden = False
            answered = False
            shell = (msg.additional_kwargs or {}).get("circle_shell")
            if isinstance(shell, dict):
                # A command the user ran with ``!``: drawn as they saw it
                call_id = f"saved-shell:{index}"
                turns.append((f"!{shell.get('command', '')}", [make_assistant_message(
                    uuid=call_id, content=[
                        make_tool_use_block(tool_use_id=call_id, name="execute",
                                            input={"command": shell.get("command", "")},
                                            status="done"),
                        make_tool_result_block(tool_use_id=call_id,
                                               output=str(shell.get("output", "")),
                                               is_error=shell.get("exit_code") not in (0, None),
                                               name="execute")])]))
                answered = True
                continue
            turns.append((shown_text(msg), []))
            continue
        if not turns or hidden:
            continue
        blocks = []
        if isinstance(msg, AIMessage):
            answered = not msg.tool_calls
            parsed = parse_content(msg.content)
            thinking = parsed.thinking or (msg.additional_kwargs or {}).get("reasoning_content")
            if isinstance(thinking, str) and thinking.strip():
                blocks.append(make_thinking_block(thinking))
            if parsed.text:
                blocks.append(make_text_block(parsed.text))
            for call in msg.tool_calls or ():
                blocks.append(make_tool_use_block(
                    tool_use_id=str(call.get("id") or ""), name=str(call.get("name") or ""),
                    input=call.get("args") or {}, status="done"))
        elif isinstance(msg, ToolMessage):
            output = msg.content if isinstance(msg.content, str) else parse_content(msg.content).text
            job = (msg.additional_kwargs or {}).get("circle_job")
            blocks.append(make_tool_result_block(
                tool_use_id=str(msg.tool_call_id or ""), output=output,
                is_error=getattr(msg, "status", "") == "error", name=str(msg.name or ""),
                payload={"job": dict(job)} if isinstance(job, dict) else None))
        if blocks:
            turns[-1][1].append(make_assistant_message(uuid=f"saved:{index}", content=blocks))
    return [(text, MessageSnapshot(messages=tuple(msgs), status="idle")) for text, msgs in turns]
