"""Session message tree with fork/clone (Pi-style branching)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any


@dataclass
class TreeNode:
    id: str
    parent_id: str | None
    role: str  # user | assistant | system | meta
    text: str
    label: str = ""


@dataclass
class SessionTree:
    """In-memory tree; ``active_id`` is the tip of the current branch."""

    nodes: dict[str, TreeNode] = field(default_factory=dict)
    active_id: str | None = None
    root_ids: list[str] = field(default_factory=list)

    def add(self, role: str, text: str, *, parent_id: str | None = None) -> TreeNode:
        pid = parent_id if parent_id is not None else self.active_id
        node = TreeNode(id=uuid.uuid4().hex[:12], parent_id=pid, role=role, text=text)
        self.nodes[node.id] = node
        if pid is None:
            self.root_ids.append(node.id)
        self.active_id = node.id
        return node

    def path_to(self, node_id: str | None = None) -> list[TreeNode]:
        nid = node_id if node_id is not None else self.active_id
        chain: list[TreeNode] = []
        seen: set[str] = set()
        while nid and nid not in seen:
            seen.add(nid)
            node = self.nodes.get(nid)
            if node is None:
                break
            chain.append(node)
            nid = node.parent_id
        chain.reverse()
        return chain

    def children_of(self, node_id: str) -> list[TreeNode]:
        return [n for n in self.nodes.values() if n.parent_id == node_id]

    def jump(self, node_id: str) -> bool:
        if node_id not in self.nodes:
            return False
        self.active_id = node_id
        return True

    def fork_from(self, node_id: str) -> SessionTree | None:
        """New tree containing the path to ``node_id`` (inclusive)."""
        if node_id not in self.nodes:
            return None
        path = self.path_to(node_id)
        tree = SessionTree()
        id_map: dict[str, str] = {}
        prev: str | None = None
        for node in path:
            new = tree.add(node.role, node.text, parent_id=prev)
            new.label = node.label
            id_map[node.id] = new.id
            prev = new.id
        return tree

    def clone_active(self) -> SessionTree:
        tip = self.active_id
        if tip is None:
            return SessionTree()
        forked = self.fork_from(tip)
        return forked or SessionTree()

    def render_list(self, *, limit: int = 40) -> str:
        path = self.path_to()
        lines = ["Session tree (active branch):", ""]
        for i, node in enumerate(path[-limit:], start=max(1, len(path) - limit + 1)):
            mark = "●" if node.id == self.active_id else "○"
            kids = self.children_of(node.id)
            branch = f" (+{len(kids) - 1} branches)" if len(kids) > 1 else ""
            label = f" [{node.label}]" if node.label else ""
            preview = node.text.strip().replace("\n", " ")[:60]
            lines.append(f"  {mark} {i}. {node.id} {node.role}{label}{branch}")
            lines.append(f"      {preview}")
        lines.append("")
        lines.append("Jump: /tree <id>   Fork: /fork <id>   Clone: /clone")
        return "\n".join(lines)

    def transcript_text(self) -> str:
        parts: list[str] = []
        for node in self.path_to():
            parts.append(f"{node.role}: {node.text}")
        return "\n\n".join(parts)

    def to_checkpoint(self) -> dict[str, Any]:
        return {
            "active_id": self.active_id,
            "root_ids": list(self.root_ids),
            "nodes": {
                nid: {
                    "id": n.id,
                    "parent_id": n.parent_id,
                    "role": n.role,
                    "text": n.text,
                    "label": n.label,
                }
                for nid, n in self.nodes.items()
            },
        }

    @classmethod
    def from_checkpoint(cls, data: dict[str, Any]) -> SessionTree:
        tree = cls()
        tree.active_id = data.get("active_id")
        tree.root_ids = list(data.get("root_ids") or [])
        for nid, raw in (data.get("nodes") or {}).items():
            tree.nodes[nid] = TreeNode(
                id=str(raw.get("id") or nid),
                parent_id=raw.get("parent_id"),
                role=str(raw.get("role") or "user"),
                text=str(raw.get("text") or ""),
                label=str(raw.get("label") or ""),
            )
        return tree
