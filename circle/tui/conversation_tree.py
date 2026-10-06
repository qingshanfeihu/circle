"""The conversation as a tree, read from the session's checkpoints.

Going back to an earlier message and sending something else does not erase anything:
LangGraph continues from the earlier checkpoint and both branches stay in the session.
This module reads every point where a turn ended and lays the messages out as a tree of
your messages and the answers, with the checkpoint to continue from for each.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessage

from circle.tui.content_blocks import parse_content
from circle.tui.replay import is_user_message, shown_text

ROOT = "__root__"

_LINK = re.compile(r"!?\[([^\]]*)\]\([^)\s]*\)")
_LINE_MARK = re.compile(r"(?m)^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?=\S)|```\S*)")


def row_text(text: str) -> str:
    """A message as one row of a list: the words without Markdown's marks (`code`, **bold**,
    # headings, > quotes, list bullets, [links](…)), all on one line."""
    text = _LINK.sub(r"\1", text or "")
    text = _LINE_MARK.sub("", text).replace("**", "").replace("`", "")
    return " ".join(text.split())


@dataclass
class TreeEntry:
    key: str                    # the message id
    role: str                   # "user" or "assistant"
    text: str
    parent: str                 # the entry before it on its branch, or ROOT
    order: int                  # when it was first seen, for sorting siblings
    # The checkpoint to continue from when this entry is chosen: for an answer, the end of
    # its turn; for your message, the end of the turn before it. None means the start of
    # the conversation; "" means there is no such point (a turn that stopped on a card).
    resume_from: str | None = ""
    children: list[str] = field(default_factory=list)


@dataclass
class ConversationTree:
    entries: dict[str, TreeEntry]
    roots: list[str]
    leaf: str | None            # the entry the conversation is at now

    def path_to(self, key: str | None) -> list[str]:
        out: list[str] = []
        while key and key != ROOT and key in self.entries:
            out.append(key)
            key = self.entries[key].parent
        return list(reversed(out))

    def walk(self) -> list[tuple[str, int]]:
        """Every entry with its depth in branches, siblings oldest first. Iterative: a
        long session is thousands of entries deep."""
        out: list[tuple[str, int]] = []
        stack: list[tuple[str, int]] = []

        def push(keys: list[str], depth: int) -> None:
            ordered = sorted(keys, key=lambda k: self.entries[k].order)
            stack.extend((key, depth) for key in reversed(ordered))

        push(self.roots, 1 if len(self.roots) > 1 else 0)
        while stack:
            key, depth = stack.pop()
            out.append((key, depth))
            kids = self.entries[key].children
            push(kids, depth + (1 if len(kids) > 1 else 0))
        return out


def _key(index: int, msg: Any) -> str:
    """A message's id; one written in without an id is known by its place and text, which
    are the same in every checkpoint of its branch."""
    found = str(getattr(msg, "id", "") or "")
    if found:
        return found
    import hashlib

    digest = hashlib.sha1(str(getattr(msg, "content", "")).encode("utf-8")).hexdigest()[:12]
    return f"#{index}:{type(msg).__name__}:{digest}"


def _answer_text(msg: AIMessage) -> str:
    return parse_content(msg.content).text.strip()


class TreeBuilder:
    """The tree of one conversation, kept up to date: each update reads only the
    checkpoints added since the last.

    Reading a checkpoint's state means reading every message up to it, so reading them
    all takes seconds in a long session. The checkpoint list is cheap: from it only the
    resting points are read, where a turn ended or Circle wrote messages in without a turn
    (/fork, /clone, a !command, a skill; see context_middleware.append_messages), and only
    the ones newer than the last update."""

    def __init__(self) -> None:
        self.entries: dict[str, TreeEntry] = {}
        self.roots: list[str] = []
        # a hash of the message ids up to a point → the checkpoint resting there
        self._ended_at: dict[int, str] = {}
        self._order = 0
        self._newest = ""  # the newest resting point read

    def update(self, agent: Any, thread_id: str) -> None:
        for snap in self._new_resting_points(agent, thread_id):
            self._add(snap)

    def tree(self, agent: Any, thread_id: str, leaf_checkpoint: str | None = None
             ) -> ConversationTree:
        configurable: dict[str, Any] = {"thread_id": thread_id}
        if leaf_checkpoint:
            configurable["checkpoint_id"] = leaf_checkpoint
        target = agent.get_state({"configurable": configurable})
        current = list((getattr(target, "values", None) or {}).get("messages") or [])
        leaf = None
        for index in reversed(range(len(current))):
            key = _key(index, current[index])
            if key in self.entries:
                leaf = key
                break
        return ConversationTree(entries=self.entries, roots=self.roots, leaf=leaf)

    def _new_resting_points(self, agent: Any, thread_id: str) -> list[Any]:
        config = {"configurable": {"thread_id": thread_id}}
        saver = getattr(agent, "checkpointer", None)
        lister = getattr(saver, "list", None)
        if not callable(lister):
            history = reversed(list(agent.get_state_history(config)))
            return [s for s in history if not s.next
                    and s.config["configurable"]["checkpoint_id"] > self._newest]
        stepped_on: set[str] = set()
        candidates: list[str] = []
        for item in lister(config):  # newest first
            checkpoint = item.config["configurable"]["checkpoint_id"]
            if checkpoint <= self._newest:
                break  # read before, and nothing older can change
            source = (item.metadata or {}).get("source")
            if source == "loop":
                parent = (item.parent_config or {}).get("configurable", {}).get("checkpoint_id")
                if parent:
                    stepped_on.add(parent)
            if source in ("loop", "update") and checkpoint not in stepped_on:
                candidates.append(checkpoint)
        snapshots = []
        for checkpoint in sorted(candidates):  # checkpoint ids grow with time
            snap = agent.get_state({"configurable": {"thread_id": thread_id,
                                                     "checkpoint_id": checkpoint}})
            if not snap.next:
                snapshots.append(snap)
        return snapshots

    def _add(self, snap: Any) -> None:
        messages = list((snap.values or {}).get("messages") or [])
        ids = [_key(index, m) for index, m in enumerate(messages)]
        prefix = [0] * (len(ids) + 1)  # prefix[i]: a hash of ids[:i]
        for index, key in enumerate(ids):
            prefix[index + 1] = hash((prefix[index], key))
        checkpoint = snap.config["configurable"]["checkpoint_id"]
        self._newest = max(self._newest, checkpoint)
        self._ended_at.setdefault(prefix[len(ids)], checkpoint)
        entries = self.entries
        parent = ROOT
        for index, msg in enumerate(messages):
            key = ids[index]
            if key in entries:
                entry = entries[key]
            else:
                if is_user_message(msg):
                    role, text = "user", shown_text(msg)
                elif isinstance(msg, AIMessage) and not msg.tool_calls and _answer_text(msg):
                    role, text = "assistant", _answer_text(msg)
                else:
                    continue
                entry = TreeEntry(key=key, role=role, text=text, parent=parent, order=self._order)
                entries[key] = entry
                self._order += 1
                if parent == ROOT:
                    self.roots.append(key)
                else:
                    entries[parent].children.append(key)
            if entry.role == "user" and not entry.resume_from:
                entry.resume_from = self._ended_at.get(prefix[index], "") if index else None
            parent = key
        # The answer a turn ended on is where that turn's checkpoint continues from. The
        # first such checkpoint: a later one with the same messages can be the empty step
        # before a write (append_messages), which carries that write.
        if (messages and isinstance(messages[-1], AIMessage) and ids[-1] in entries
                and not entries[ids[-1]].resume_from):
            entries[ids[-1]].resume_from = checkpoint


def build_tree(agent: Any, thread_id: str, *, leaf_checkpoint: str | None = None
               ) -> ConversationTree:
    """The whole tree, read afresh (the session keeps a TreeBuilder to read only what is
    new)."""
    builder = TreeBuilder()
    builder.update(agent, thread_id)
    return builder.tree(agent, thread_id, leaf_checkpoint)
