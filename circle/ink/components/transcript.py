
from __future__ import annotations

from ..dom import DOMElement, NodeType, TextNode, create_element, create_text


def _text_node(text: str, bg: str | None) -> TextNode:
    node = create_text(text)
    if bg:
        node.text_styles.background_color = bg
    return node


class Transcript:

    def __init__(self) -> None:
        self._node = create_element(NodeType.BOX)
        self._node.style.flex_grow = 1
        self._node.style.overflow = "scroll"
        self._node.sticky_scroll = True
        self._messages: list[str] = []
        # 与 _messages 同步增删改：每条消息的类型底色（hex），重建节点时照着恢复。
        self._messages_bg: list[str | None] = []

    @property
    def node(self) -> DOMElement:
        return self._node

    def append_message(self, text: str, *, style: str = "", bg: str | None = None) -> None:
        self._messages.append(text)
        self._messages_bg.append(bg or None)
        self._node.append_child(_text_node(text, bg))

        if self._node.sticky_scroll:
            self._scroll_to_bottom()

    def append_messages(self, texts: list[str], *, bg: str | None = None) -> None:
        if not texts:
            return
        for text in texts:
            self._messages.append(text)
            self._messages_bg.append(bg or None)
            self._node.append_child(_text_node(text, bg))
        if self._node.sticky_scroll:
            self._scroll_to_bottom()

    def ensure_block_gap(self) -> None:
        """块间空行的单点裁决：末行非空时补恰好 1 行空行。"""
        if self._messages and self._messages[-1] != "":
            self.append_message("")

    def update_last_message(self, text: str) -> None:
        if self._node.children:
            last = self._node.children[-1]
            if isinstance(last, TextNode):
                last.set_value(text)
                if self._messages:
                    self._messages[-1] = text
                # 底色不变：节点复用，text_styles 留着
                if self._node.sticky_scroll:
                    self._scroll_to_bottom()

    def clear(self) -> None:
        self._node.clear_children()
        self._messages.clear()
        self._messages_bg.clear()
        self._node.scroll_top = 0
        self._node.sticky_scroll = True

    def scroll_by(self, delta: int) -> None:
        if delta == 0:
            return
        new_top = max(0, min(self.max_top(), self._node.scroll_top + delta))
        self._node.scroll_top = new_top
        self._node.sticky_scroll = new_top >= self.max_top()

    def scroll_to(self, top: int | None) -> None:
        """滚到第 ``top`` 行；None 滚到底（重新吸底）。"""
        max_top = self.max_top()
        new_top = max_top if top is None else max(0, min(max_top, int(top)))
        self._node.scroll_top = new_top
        self._node.sticky_scroll = new_top >= max_top

    def max_top(self) -> int:
        return max(0, self._content_height_rows() - self.viewport_height())

    def scroll_up(self, lines: int = 3) -> None:
        self.scroll_by(-abs(lines))

    def scroll_down(self, lines: int = 3) -> None:
        self.scroll_by(abs(lines))

    def viewport_height(self) -> int:
        h = self._node.rect.height
        return h if h > 0 else 20

    def update_message_at(self, idx: int, text: str, *, bg: str | None = None) -> None:
        if 0 <= idx < len(self._messages):
            self._messages[idx] = text
            if bg is not None:
                self._messages_bg[idx] = bg or None
            children = list(self._node.children)
            if idx < len(children):
                child = children[idx]
                if isinstance(child, TextNode):
                    child.set_value(text)
                    child.text_styles.background_color = self._messages_bg[idx]

            if self._node.sticky_scroll:
                self._scroll_to_bottom()

    def replace_range(
        self, start_idx: int, count: int, new_lines: list[str],
        *, bg: str | None = None, bgs: list[str | None] | None = None,
    ) -> None:
        """Swap only the nodes in the range; the rest of the transcript stays as is.

        ``bgs`` gives each new line its own background (``bg`` gives them all one)."""
        line_bgs = [b or None for b in bgs] if bgs is not None else [bg or None] * len(new_lines)
        line_bgs = (line_bgs + [None] * len(new_lines))[:len(new_lines)]
        children = self._node.children
        in_sync = len(children) == len(self._messages)
        self._messages[start_idx:start_idx + count] = new_lines
        self._messages_bg[start_idx:start_idx + count] = line_bgs
        if not in_sync:
            self._node.clear_children()
            for msg, msg_bg in zip(self._messages, self._messages_bg):
                self._node.append_child(_text_node(msg, msg_bg))
        else:
            for child in children[start_idx:start_idx + count]:
                child.parent = None
            nodes = [_text_node(msg, msg_bg) for msg, msg_bg in zip(new_lines, line_bgs)]
            for node in nodes:
                node.parent = self._node
            children[start_idx:start_idx + count] = nodes
            self._node.mark_dirty()
        if self._node.sticky_scroll:
            self._scroll_to_bottom()

    def message_count(self) -> int:
        return len(self._messages)

    def message_at(self, idx: int) -> str | None:
        return self._messages[idx] if -len(self._messages) <= idx < len(self._messages) else None

    def bg_at(self, idx: int) -> str | None:
        return self._messages_bg[idx] if -len(self._messages_bg) <= idx < len(self._messages_bg) else None

    def snapshot(self) -> list[str]:
        return list(self._messages)

    def snapshot_bgs(self) -> list[str | None]:
        return list(self._messages_bg)

    def restore(self, texts: list[str], bgs: list[str | None] | None = None) -> None:
        self.clear()
        if not texts:
            return
        line_bgs = list(bgs or [])
        line_bgs = (line_bgs + [None] * len(texts))[:len(texts)]
        for text, text_bg in zip(texts, line_bgs):
            self._messages.append(text)
            self._messages_bg.append(text_bg or None)
            self._node.append_child(_text_node(text, text_bg))
        if self._node.sticky_scroll:
            self._scroll_to_bottom()

    def _content_height_rows(self) -> int:
        width = self._node.rect.width if self._node.rect.width > 0 else 80
        return sum(
            child.wrapped_rows(width)
            for child in self._node.children
            if isinstance(child, TextNode)
        )

    def _scroll_to_bottom(self) -> None:
        self._node.scroll_top = self.max_top()
