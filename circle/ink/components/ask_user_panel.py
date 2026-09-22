
from __future__ import annotations

from circle.ink.dom import NodeType, create_element, create_text


class AskUserPanel:

    def __init__(self) -> None:
        self._node = create_element(NodeType.BOX)
        self._node.style.height = 0
        self._visible = False

    @property
    def node(self):
        return self._node

    @property
    def is_visible(self) -> bool:
        return self._visible

    def update(self, lines: list[str]) -> None:
        self._node.clear_children()
        if not lines:
            self._node.style.height = 0
            self._visible = False
            return
        self._node.append_child(create_text(" "))
        # 真实行数估高、渲染层对 BOX 直挂的 TextNode 原生折行——长选项行(ask_user 的
        # label+description 常超终端宽)不再被单行行盒截断(2026-07-02 实测决策面板选项断半句)。
        for ln in lines:
            self._node.append_child(create_text(ln))
        self._node.style.height = None
        self._visible = True

    def clear(self) -> None:
        self.update([])
