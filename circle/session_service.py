"""Persistent logical sessions over LangGraph's native immutable checkpoints.

The index contains pointers and presentation metadata, never a second message
history. Forking shares a checkpoint's ancestor chain, including DeltaChannel
writes; it does not copy raw saver rows or replay tools.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout
from langchain_core.messages import messages_from_dict, messages_to_dict


def _fresh_thread() -> str:
    return "circle-state-" + uuid.uuid4().hex


class SessionService:
    def __init__(self, home: Path, workspace: Path):
        self.home = home
        self.workspace = str(workspace.resolve())
        home.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(home / "sessions.sqlite", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("""CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL,
            ref TEXT NOT NULL, presentation TEXT NOT NULL DEFAULT '{}',
            updated REAL NOT NULL, status TEXT NOT NULL DEFAULT 'idle')""")
        self._db.commit()
        self._db.execute("CREATE TABLE IF NOT EXISTS message_refs (thread TEXT, message_key TEXT, ref TEXT, PRIMARY KEY(thread,message_key))")
        self._db.execute("CREATE TABLE IF NOT EXISTS session_heads (session TEXT, checkpoint TEXT, ref TEXT, PRIMARY KEY(session,checkpoint))")
        self._db.commit()

    def ensure(self, session_id: str, *, ref: dict | None = None, title: str = "new") -> dict:
        with self._lock, self._db:
            self._db.execute("INSERT OR IGNORE INTO sessions(id,workspace,title,ref,updated) VALUES(?,?,?,?,?)",
                             (session_id, self.workspace, title,
                              json.dumps(ref or {"thread_id": _fresh_thread(), "checkpoint_ns": ""}), time.time()))
        return self.get(session_id)

    def get(self, session_id: str) -> dict:
        with self._lock:
            row = self._db.execute("SELECT * FROM sessions WHERE id=? AND workspace=?",
                                   (session_id, self.workspace)).fetchone()
        if row is None:
            raise KeyError(f"Unknown session {session_id}")
        return {**dict(row), "ref": json.loads(row["ref"]), "presentation": json.loads(row["presentation"])}

    def list(self) -> list[dict]:
        with self._lock:
            ids = [r[0] for r in self._db.execute("SELECT id FROM sessions WHERE workspace=? ORDER BY updated DESC",
                                                (self.workspace,))]
        return [self.get(sid) for sid in ids]

    def save(self, session_id: str, *, ref: dict | None = None, title: str | None = None,
             presentation: dict | None = None, status: str | None = None) -> None:
        current = self.get(session_id)
        with self._lock, self._db:
            self._db.execute("UPDATE sessions SET ref=?,title=?,presentation=?,status=?,updated=? WHERE id=?",
                             (json.dumps(ref if ref is not None else current["ref"]),
                              title if title is not None else current["title"],
                              json.dumps(presentation if presentation is not None else current["presentation"]),
                              status if status is not None else current["status"], time.time(), session_id))

    def select(self, session_id: str, ref: dict) -> None:
        # No checkpoint denotes the empty conversation, not the latest state
        # of a physical thread which may since have been populated.
        selected = dict(ref) if ref.get("checkpoint_id") else {"thread_id": _fresh_thread(), "checkpoint_ns": ""}
        with self.run_guard(session_id, mark_running=False):
            self.remember_head(session_id, self.get(session_id)["ref"])
            self.save(session_id, ref=selected)

    def fork(self, source: str, *, ref: dict | None = None, title: str | None = None) -> str:
        parent = self.get(source)
        selected = ref if ref is not None else parent["ref"]
        if not selected.get("checkpoint_id"):
            selected = {"thread_id": _fresh_thread(), "checkpoint_ns": ""}
        sid = "circle-" + uuid.uuid4().hex[:12]
        self.ensure(sid, ref=selected, title=title or parent["title"] + " (fork)")
        self.remember_head(sid, selected)
        return sid

    def remember_head(self, session_id: str, ref: dict, previous: dict | None = None) -> None:
        """Keep branch tips as native checkpoint pointers, not copied history."""
        if not ref.get("checkpoint_id"):
            return
        ref = {k: ref[k] for k in ("thread_id", "checkpoint_ns", "checkpoint_id") if k in ref}
        def key(value):
            return value["thread_id"] + ":" + value["checkpoint_id"]
        with self._lock, self._db:
            if previous and previous.get("checkpoint_id"):
                self._db.execute("DELETE FROM session_heads WHERE session=? AND checkpoint=?",
                                 (session_id, key(previous)))
            self._db.execute("INSERT OR REPLACE INTO session_heads VALUES(?,?,?)",
                             (session_id, key(ref), json.dumps(ref)))

    def heads(self, session_id: str) -> list[dict]:
        with self._lock:
            return [json.loads(row[0]) for row in self._db.execute(
                "SELECT ref FROM session_heads WHERE session=? ORDER BY checkpoint", (session_id,))]

    @contextmanager
    def run_guard(self, session_id: str, *, mark_running: bool = True):
        """One active writer per logical session, including other processes."""
        locks = self.home / "session-locks"
        locks.mkdir(exist_ok=True)
        lock = FileLock(locks / (hashlib.sha256(session_id.encode()).hexdigest() + ".lock"))
        try:
            lock.acquire(timeout=0)
        except Timeout:
            raise RuntimeError(f"Session {session_id} is already running") from None
        try:
            if mark_running:
                self.save(session_id, status="running")
            yield
        finally:
            lock.release()

    def bind(self, agent: Any) -> SessionGraph:
        return SessionGraph(agent, self)

    def legacy_threads(self, agent) -> list[str]:
        known = {row["ref"]["thread_id"] for row in self.list()}
        return sorted({item.config["configurable"]["thread_id"] for item in agent.checkpointer.list(None)
                       if not item.config["configurable"].get("checkpoint_ns")
                       and not item.metadata.get("circle_session_id")
                       and item.config["configurable"]["thread_id"] not in known})

    def adopt_legacy(self, agent, thread_id: str) -> None:
        if thread_id not in self.legacy_threads(agent):
            raise KeyError(f"No unbound legacy thread {thread_id}")
        state = agent.get_state({"configurable": {"thread_id": thread_id}})
        if not state.values:
            raise ValueError("Legacy thread has no readable state")
        self.ensure(thread_id, ref=dict(state.config["configurable"]), title="legacy " + thread_id)
        self.remember_head(thread_id, dict(state.config["configurable"]))

    def close(self) -> None:
        with self._lock:
            self._db.close()


class SessionGraph:
    """A narrow facade: all execution and state projection remain LangGraph's."""
    def __init__(self, agent: Any, sessions: SessionService):
        self.raw = agent
        self.sessions = sessions
        self.config_defaults = {}

    def __getattr__(self, name: str) -> Any:
        return getattr(self.raw, name)

    def _resolve(self, config: dict | None) -> tuple[str, dict]:
        config = dict(config or {})
        incoming = {**self.config_defaults, **dict(config.get("configurable") or {})}
        sid = str(incoming.get("session_id") or incoming.get("thread_id") or "")
        if not sid:
            raise ValueError("session_id or thread_id is required")
        row = self.sessions.ensure(sid)
        ref = dict(row["ref"])
        config["configurable"] = {**incoming, **ref, "session_id": sid}
        # Keep caller-supplied checkpoint selection explicit.
        if incoming.get("checkpoint_id"):
            config["configurable"]["checkpoint_id"] = incoming["checkpoint_id"]
        config["metadata"] = {**config.get("metadata", {}), "circle_session_id": sid}
        return sid, config

    def _record(self, sid: str, config: dict) -> None:
        physical = config["configurable"]["thread_id"]
        history = self.raw.get_state_history({"configurable": {"thread_id": physical,
                                                               "checkpoint_ns": config["configurable"].get("checkpoint_ns", "")}},
                                              filter={"circle_session_id": sid}, limit=1)
        state = next(iter(history), None)
        if state is not None:
            ref = {k: state.config["configurable"][k] for k in ("thread_id", "checkpoint_ns", "checkpoint_id")}
            self.sessions.remember_head(sid, ref, config["configurable"])
            self.sessions.save(sid, ref=ref, status=self._status(state))
        else:
            self.sessions.save(sid, status="interrupted")

    @staticmethod
    def _status(state):
        return "awaiting_user" if state.interrupts else ("interrupted" if state.next else "idle")

    def invoke(self, input: Any, config: dict | None = None, **kwargs: Any) -> Any:
        sid, resolved = self._resolve(config)
        with self.sessions.run_guard(sid):
            _, resolved = self._resolve(config)
            try:
                return self.raw.invoke(input, config=resolved, **kwargs)
            finally:
                self._record(sid, resolved)

    def stream(self, input: Any, config: dict | None = None, **kwargs: Any) -> Iterator:
        sid, resolved = self._resolve(config)
        with self.sessions.run_guard(sid):
            _, resolved = self._resolve(config)
            try:
                yield from self.raw.stream(input, config=resolved, **kwargs)
            finally:
                self._record(sid, resolved)

    def get_state(self, config: dict, **kwargs: Any) -> Any:
        _, resolved = self._resolve(config)
        return self.raw.get_state(resolved, **kwargs)

    def update_state(self, config: dict, values: Any, **kwargs: Any) -> dict:
        sid, resolved = self._resolve(config)
        with self.sessions.run_guard(sid, mark_running=False):
            _, resolved = self._resolve(config)
            result = self.raw.update_state(resolved, values, **kwargs)
            self.sessions.save(sid, ref={k: v for k, v in result["configurable"].items()
                                        if k in {"thread_id", "checkpoint_id", "checkpoint_ns"}})
            self.sessions.remember_head(sid, result["configurable"], resolved["configurable"])
            return result

    def get_state_history(self, config: dict, **kwargs: Any) -> Iterator:
        _, resolved = self._resolve(config)
        return self.raw.get_state_history(resolved, **kwargs)

    async def _arecord(self, sid, config):
        physical = config["configurable"]["thread_id"]
        async for state in self.raw.aget_state_history({"configurable": {"thread_id": physical,
                                                                      "checkpoint_ns": config["configurable"].get("checkpoint_ns", "")}},
                                                       filter={"circle_session_id": sid}, limit=1):
            ref = {k: state.config["configurable"][k] for k in ("thread_id", "checkpoint_ns", "checkpoint_id")}
            self.sessions.remember_head(sid, ref, config["configurable"])
            self.sessions.save(sid, ref=ref, status=self._status(state))
            return
        self.sessions.save(sid, status="interrupted")

    async def ainvoke(self, input, config=None, **kwargs):
        sid, resolved = self._resolve(config)
        with self.sessions.run_guard(sid):
            _, resolved = self._resolve(config)
            try:
                return await self.raw.ainvoke(input, resolved, **kwargs)
            finally:
                await self._arecord(sid, resolved)

    async def astream(self, input, config=None, **kwargs):
        sid, resolved = self._resolve(config)
        with self.sessions.run_guard(sid):
            _, resolved = self._resolve(config)
            try:
                async for event in self.raw.astream(input, resolved, **kwargs):
                    yield event
            finally:
                await self._arecord(sid, resolved)

    async def astream_native(self, input, config=None, **kwargs):
        """Use the SDK's async saver on the same database; no custom saver."""
        from langgraph.checkpoint.sqlite import SqliteSaver
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
        if isinstance(self.raw.checkpointer, SqliteSaver):
            async with AsyncSqliteSaver.from_conn_string(str(self.sessions.home / "checkpoints.sqlite")) as saver:
                await saver.setup()
                graph = copy.copy(self.raw)
                graph.checkpointer = saver
                facade = SessionGraph(graph, self.sessions)
                async for event in facade.astream(input, config, **kwargs):
                    yield event
        else:
            async for event in self.astream(input, config, **kwargs):
                yield event

    async def aget_state(self, config, **kwargs):
        _, resolved = self._resolve(config)
        return await self.raw.aget_state(resolved, **kwargs)

    async def aget_state_history(self, config, **kwargs):
        _, resolved = self._resolve(config)
        async for state in self.raw.aget_state_history(resolved, **kwargs):
            yield state

    async def aupdate_state(self, config, values, **kwargs):
        sid, resolved = self._resolve(config)
        with self.sessions.run_guard(sid, mark_running=False):
            _, resolved = self._resolve(config)
            result = await self.raw.aupdate_state(resolved, values, **kwargs)
            self.sessions.save(sid, ref={k: v for k, v in result["configurable"].items()
                                        if k in {"thread_id", "checkpoint_id", "checkpoint_ns"}})
            self.sessions.remember_head(sid, result["configurable"], resolved["configurable"])
            return result

    def wire_events(self, input, config, **kwargs):
        """Forward the SDK's v3 JSON-RPC stream without a new event schema."""
        sid, resolved = self._resolve(config)
        with self.sessions.run_guard(sid):
            _, resolved = self._resolve(config)
            stream = self.raw.stream_events(input, resolved, version="v3", **kwargs)
            try:
                with stream:
                    yield from stream
            finally:
                self._record(sid, resolved)

    def close(self):
        self.sessions.close()
        connection = getattr(self.raw.checkpointer, "conn", None)
        if isinstance(connection, sqlite3.Connection):
            connection.close()

    def project_tree(self, session_id):
        from circle.session_tree import SessionTree
        ref = self.sessions.get(session_id)["ref"]
        tree = SessionTree()
        for head in self.sessions.heads(session_id):
            branch = self._project_ref(head)
            tree.nodes.update(branch.nodes)
            tree.root_ids.extend(root for root in branch.root_ids if root not in tree.root_ids)
        active = self._project_ref(ref)
        tree.nodes.update(active.nodes)
        tree.root_ids.extend(root for root in active.root_ids if root not in tree.root_ids)
        tree.active_id = active.active_id
        return tree

    def _project_ref(self, ref):
        from circle.session_tree import SessionTree
        from circle.tui.content_blocks import message_text
        tree = SessionTree()
        if not ref.get("checkpoint_id"):
            return tree
        state = self.raw.get_state({"configurable": ref})
        messages = state.values.get("messages", [])
        def identity(message):
            display = {"type": message.type, "content": message.content,
                       "tool_calls": getattr(message, "tool_calls", None)}
            return str(message.id) + ":" + hashlib.sha256(json.dumps(display, sort_keys=True, default=str).encode()).hexdigest()

        thread = ref["thread_id"]
        with self.sessions._lock:
            cached = {row[0]: json.loads(row[1]) for row in self.sessions._db.execute(
                "SELECT message_key,ref FROM message_refs WHERE thread=?", (thread,))}
        keys = {identity(message) for message in messages}
        missing = keys - cached.keys()
        refs = {}
        cursor = state
        while cursor is not None and missing:
            current_keys = {identity(message) for message in cursor.values.get("messages", [])}
            finished = {key for key in missing if key in refs and key not in current_keys}
            missing -= finished
            for message in cursor.values.get("messages", []):
                key = identity(message)
                if key not in missing:
                    continue
                refs[key] = (dict(cursor.parent_config["configurable"]) if message.type == "human" and cursor.parent_config
                                    else dict(cursor.config["configurable"]))
            cursor = self.raw.get_state(cursor.parent_config) if cursor.parent_config else None
        with self.sessions._lock, self.sessions._db:
            self.sessions._db.executemany("INSERT OR REPLACE INTO message_refs VALUES(?,?,?)",
                                          [(thread, key, json.dumps(value)) for key, value in refs.items()])
        refs = {**cached, **refs}
        for message in messages:
            role = {"human": "user", "ai": "assistant"}.get(message.type, message.type)
            node = tree.add(role, message_text(message.content) or str(getattr(message, "tool_calls", "")))
            # Message IDs are durable selection identities; checkpoint ancestry
            # is resolved through public StateSnapshot.parent_config.
            tree.nodes.pop(node.id)
            old = node.id
            node.id = message.id or old
            tree.nodes[node.id] = node
            if old in tree.root_ids:
                tree.root_ids[tree.root_ids.index(old)] = node.id
            tree.active_id = node.id
            node.checkpoint = refs.get(identity(message), ref)
        return tree

    def export(self, session_id: str) -> dict:
        with self.sessions.run_guard(session_id, mark_running=False):
            return self._export_settled(session_id)

    def _export_settled(self, session_id: str) -> dict:
        row = self.sessions.get(session_id)
        state = self.get_state({"configurable": {"thread_id": session_id}})
        portable = self._portable_state(state)
        branches = [self._portable_state(self.raw.get_state({"configurable": ref}))
                    for ref in self.sessions.heads(session_id) if ref != row["ref"]]
        return {"format": "circle-session", "version": 3, "title": row["title"],
                "state": portable, "branches": branches}

    @staticmethod
    def _portable_state(state):
        if state.next:
            raise ValueError("A pending run must settle before portable export")
        values = dict(state.values)
        values["messages"] = messages_to_dict(values.get("messages", []))
        portable = {k: values[k] for k in ("messages", "todos") if k in values}
        from deepagents.middleware.summarization import SUMMARIZATION_EVENT_KEY
        event = values.get(SUMMARIZATION_EVENT_KEY)
        if event:
            portable[SUMMARIZATION_EVENT_KEY] = {**event,
                "summary_message": messages_to_dict([event["summary_message"]])[0]}
        return portable

    @staticmethod
    def _import_values(portable):
        from deepagents.middleware.summarization import SUMMARIZATION_EVENT_KEY
        values = {k: v for k, v in portable.items() if k in {"messages", "todos", SUMMARIZATION_EVENT_KEY}}
        values["messages"] = messages_from_dict(values.get("messages", []))
        if values.get(SUMMARIZATION_EVENT_KEY):
            event = dict(values[SUMMARIZATION_EVENT_KEY])
            cutoff = event.get("cutoff_index")
            if type(cutoff) is not int or not 0 <= cutoff <= len(values["messages"]):
                raise ValueError("Invalid summarization cutoff")
            event["summary_message"] = messages_from_dict([event["summary_message"]])[0]
            # Offloaded files belong to the original host. The original messages
            # and summary are portable; a new invocation allocates its own file.
            event["file_path"] = None
            values[SUMMARIZATION_EVENT_KEY] = event
        return values

    def import_session(self, payload: dict) -> str:
        if payload.get("format") != "circle-session" or payload.get("version") not in {1, 2, 3}:
            raise ValueError("Unsupported session format")
        # Validate every branch before creating a session. Only framework message
        # objects and known state fields are accepted, never saver internals.
        states = [self._import_values(branch) for branch in payload.get("branches", [])]
        states.append(self._import_values(payload["state"]))
        sid = "circle-" + uuid.uuid4().hex[:12]
        self.sessions.ensure(sid, title=str(payload.get("title") or "imported"))
        # Portable import is a settled conversation. Clear scheduled nodes
        # through LangGraph's public API so import itself never replays tools.
        from langgraph.graph import END
        for values in states:
            self.sessions.select(sid, {"thread_id": _fresh_thread(), "checkpoint_ns": ""})
            self.update_state({"configurable": {"thread_id": sid}}, values, as_node="model")
            self.update_state({"configurable": {"thread_id": sid}}, None, as_node=END)
        return sid
