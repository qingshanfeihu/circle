"""Immutable message model the reducer produces and the screen renders.

Ported from InfoTest ``main/ist_core/tui/message_model.py``. The compile-engine
block types (phase markers, evidence, findings, mailbox notices) are left out; the
fork card becomes a generic subagent card.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Mapping


_EMPTY_MAP: Mapping[str, Any] = MappingProxyType({})


BLOCK_TEXT = "text"

BLOCK_THINKING = "thinking"

BLOCK_TOOL_USE = "tool_use"

BLOCK_TOOL_RESULT = "tool_result"

BLOCK_ERROR = "error"

BLOCK_TODO_LIST = "todo_list"

BLOCK_ASK_USER = "ask_user"

BLOCK_WARN = "warn"

BLOCK_AGENT_CARD = "agent_card"


@dataclass(frozen=True)
class ContentBlock:

    type: str
    
    text: str = ""
    thinking: str = ""
    thinking_title: str | None = None
    thinking_duration_s: float | None = None
    thinking_done: bool = True
    
    tool_use_id: str = ""
    name: str = ""
    input: Mapping[str, Any] = field(default_factory=lambda: _EMPTY_MAP)
    status: str = ""
    
    output: str = ""
    is_error: bool = False
    
    payload: Mapping[str, Any] = field(default_factory=lambda: _EMPTY_MAP)


@dataclass(frozen=True)
class Message:

    uuid: str
    role: str
    content: tuple[ContentBlock, ...]
    timestamp: str = ""
    parent_tool_use_id: str = ""
    subagent_type: str = ""


@dataclass(frozen=True)
class MessageSnapshot:

    messages: tuple[Message, ...]
    streaming_text: str | None = None
    streaming_tool_uses: tuple[ContentBlock, ...] = ()
    status: str = "idle"
    usage: Mapping[str, int] = field(default_factory=lambda: _EMPTY_MAP)
    usage_cost: Mapping[str, Any] = field(default_factory=lambda: _EMPTY_MAP)
    llm_phase: str = ""
    output_token_count: int = 0
    llm_round: int = 0
    call_started_at: float | None = None
    reasoning_active: bool = False
    reasoning_last_line: str = ""
    reasoning_chars: int = 0
    rev: int = 0
    agent_board_rev: int = 0
    agent_card_indices: Mapping[str, int] = field(default_factory=lambda: _EMPTY_MAP)
    run_end_info: Mapping[str, Any] = field(default_factory=lambda: _EMPTY_MAP)
    source_run_id: str = ""
    llm_waiting: Mapping[str, Any] | None = None


def make_uuid(run_id: str, seq: int | str) -> str:
    return f"{run_id}:{seq}"


def make_text_block(text: str) -> ContentBlock:
    return ContentBlock(type=BLOCK_TEXT, text=text)


def make_thinking_block(
    thinking: str,
    *,
    title: str | None = None,
    duration_s: float | None = None,
    done: bool = True,
) -> ContentBlock:
    return ContentBlock(
        type=BLOCK_THINKING,
        thinking=thinking,
        thinking_title=title,
        thinking_duration_s=duration_s,
        thinking_done=bool(done),
    )


def make_tool_use_block(
    *,
    tool_use_id: str,
    name: str,
    input: Mapping[str, Any] | dict[str, Any] | None = None,
    status: str = "running",
) -> ContentBlock:
    return ContentBlock(
        type=BLOCK_TOOL_USE,
        tool_use_id=tool_use_id,
        name=name,
        input=MappingProxyType(dict(input or {})),
        status=status,
    )


def make_tool_result_block(
    *,
    tool_use_id: str,
    output: str,
    is_error: bool = False,
    name: str = "",
    payload: Mapping[str, Any] | dict[str, Any] | None = None,
) -> ContentBlock:
    return ContentBlock(
        type=BLOCK_TOOL_RESULT,
        tool_use_id=tool_use_id,
        output=output,
        is_error=is_error,
        name=name,
        payload=MappingProxyType(dict(payload or {})),
    )


def make_payload_block(
    type: str,
    payload: Mapping[str, Any] | dict[str, Any] | None = None,
) -> ContentBlock:
    return ContentBlock(
        type=type,
        payload=MappingProxyType(dict(payload or {})),
    )


def make_assistant_message(
    *,
    uuid: str,
    content: ContentBlock | list[ContentBlock] | tuple[ContentBlock, ...],
    timestamp: str = "",
    parent_tool_use_id: str = "",
    subagent_type: str = "",
) -> Message:
    if isinstance(content, ContentBlock):
        content_tuple: tuple[ContentBlock, ...] = (content,)
    else:
        content_tuple = tuple(content)
    return Message(
        uuid=uuid,
        role="assistant",
        content=content_tuple,
        timestamp=timestamp,
        parent_tool_use_id=parent_tool_use_id,
        subagent_type=subagent_type,
    )


def make_user_message(
    *,
    uuid: str,
    content: ContentBlock | list[ContentBlock] | tuple[ContentBlock, ...],
    timestamp: str = "",
    parent_tool_use_id: str = "",
) -> Message:
    if isinstance(content, ContentBlock):
        content_tuple: tuple[ContentBlock, ...] = (content,)
    else:
        content_tuple = tuple(content)
    return Message(
        uuid=uuid,
        role="user",
        content=content_tuple,
        timestamp=timestamp,
        parent_tool_use_id=parent_tool_use_id,
    )


def make_system_message(
    *,
    uuid: str,
    content: ContentBlock | list[ContentBlock] | tuple[ContentBlock, ...],
    timestamp: str = "",
) -> Message:
    if isinstance(content, ContentBlock):
        content_tuple: tuple[ContentBlock, ...] = (content,)
    else:
        content_tuple = tuple(content)
    return Message(
        uuid=uuid,
        role="system",
        content=content_tuple,
        timestamp=timestamp,
    )


def replace_content_block(
    msg: Message, *, predicate, new_block: ContentBlock
) -> Message:
    new_content: list[ContentBlock] = []
    for block in msg.content:
        if predicate(block):
            new_content.append(new_block)
        else:
            new_content.append(block)
    return Message(
        uuid=msg.uuid,
        role=msg.role,
        content=tuple(new_content),
        timestamp=msg.timestamp,
        parent_tool_use_id=msg.parent_tool_use_id,
        subagent_type=msg.subagent_type,
    )


def append_content_block(msg: Message, block: ContentBlock) -> Message:
    return Message(
        uuid=msg.uuid,
        role=msg.role,
        content=msg.content + (block,),
        timestamp=msg.timestamp,
        parent_tool_use_id=msg.parent_tool_use_id,
        subagent_type=msg.subagent_type,
    )


__all__ = [
    "ContentBlock",
    "Message",
    "MessageSnapshot",
    "BLOCK_TEXT",
    "BLOCK_THINKING",
    "BLOCK_TOOL_USE",
    "BLOCK_TOOL_RESULT",
    "BLOCK_TODO_LIST",
    "BLOCK_ASK_USER",
    "BLOCK_WARN",
    "BLOCK_AGENT_CARD",
    "BLOCK_ERROR",
    "make_uuid",
    "make_text_block",
    "make_thinking_block",
    "make_tool_use_block",
    "make_tool_result_block",
    "make_payload_block",
    "make_assistant_message",
    "make_user_message",
    "make_system_message",
    "replace_content_block",
    "append_content_block",
]
