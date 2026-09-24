
from __future__ import annotations

from ..dom import DOMElement, NodeType, TextNode, create_element, create_text


class Transcript:

    def __init__(self) -> None:
        self._node = create_element(NodeType.BOX)
        self._node.style.flex_grow = 1
        self._node.style.overflow = "scroll"
        self._node.sticky_scroll = True
        self._messages: list[str] = []

    @property
    def node(self) -> DOMElement:
        return self._node

    def append_message(self, text: str, *, style: str = "") -> None:
        self._messages.append(text)
        msg_node = create_text(text)
        self._node.append_child(msg_node)

        if self._node.sticky_scroll:
            self._scroll_to_bottom()

    def append_messages(self, texts: list[str]) -> None:
        if not texts:
            return
        for text in texts:
            self._messages.append(text)
            self._node.append_child(create_text(text))
        if self._node.sticky_scroll:
            self._scroll_to_bottom()

    def update_last_message(self, text: str) -> None:
        if self._node.children:
            last = self._node.children[-1]
            if isinstance(last, TextNode):
                last.set_value(text)
                if self._messages:
                    self._messages[-1] = text
                
                
                if self._node.sticky_scroll:
                    self._scroll_to_bottom()

    def clear(self) -> None:
        self._node.clear_children()
        self._messages.clear()
        self._node.scroll_top = 0
        self._node.sticky_scroll = True

    def scroll_by(self, delta: int) -> None:
        if delta == 0:
            return
        viewport_h = self._node.rect.height if self._node.rect.height > 0 else 20
        content_h = self._content_height_rows()
        max_top = max(0, content_h - viewport_h + 1)
        new_top = max(0, min(max_top, self._node.scroll_top + delta))
        self._node.scroll_top = new_top
        self._node.sticky_scroll = new_top >= max_top

    def scroll_up(self, lines: int = 3) -> None:
        self.scroll_by(-abs(lines))

    def scroll_down(self, lines: int = 3) -> None:
        self.scroll_by(abs(lines))

    def viewport_height(self) -> int:
        h = self._node.rect.height
        return h if h > 0 else 20

    def update_message_at(self, idx: int, text: str) -> None:
        if 0 <= idx < len(self._messages):
            self._messages[idx] = text
            children = list(self._node.children)
            if idx < len(children):
                child = children[idx]
                if isinstance(child, TextNode):
                    child.set_value(text)
            
            if self._node.sticky_scroll:
                self._scroll_to_bottom()

    def replace_range(self, start_idx: int, count: int, new_lines: list[str]) -> None:
        """Swap only the nodes in the range; the rest of the transcript stays as is."""
        children = self._node.children
        in_sync = len(children) == len(self._messages)
        self._messages[start_idx:start_idx + count] = new_lines
        if not in_sync:
            self._node.clear_children()
            for msg in self._messages:
                self._node.append_child(create_text(msg))
        else:
            for child in children[start_idx:start_idx + count]:
                child.parent = None
            nodes = [create_text(msg) for msg in new_lines]
            for node in nodes:
                node.parent = self._node
            children[start_idx:start_idx + count] = nodes
            self._node.mark_dirty()
        if self._node.sticky_scroll:
            self._scroll_to_bottom()

    def message_count(self) -> int:
        return len(self._messages)

    def message_at(self, idx: int) -> str | None:
        return self._messages[idx] if 0 <= idx < len(self._messages) else None

    def snapshot(self) -> list[str]:
        return list(self._messages)

    def restore(self, texts: list[str]) -> None:
        self.clear()
        if texts:
            self.append_messages(list(texts))

    def _content_height_rows(self) -> int:
        width = self._node.rect.width if self._node.rect.width > 0 else 80
        return sum(
            child.wrapped_rows(width)
            for child in self._node.children
            if isinstance(child, TextNode)
        )

    def _scroll_to_bottom(self) -> None:
        content_h = self._content_height_rows()
        viewport_h = self._node.rect.height if self._node.rect.height > 0 else 20
        self._node.scroll_top = max(0, content_h - viewport_h + 1)
